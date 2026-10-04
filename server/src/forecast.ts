// 堆场容量预测与预警模块
//
// 设计原则：预测不是 occupied × 系数，而是把未来窗口内每一个有来源的“进出块事件”
// （航次卸船、闸口预约、查验释放、出口集港、翻箱改堆、临时封闭）投影成时间序列。
// 每个预测数字都带贡献台账，可追溯到具体箱/任务/预约，或批量来源航次的推断组。
// 同一物理移动（如预约与 receive 任务、from/to 两条翻箱腿）按去重键合并；
// 取消的预约、已完成的任务、改堆后的旧位置不会重复计数。
// 预测按版本归档，执行缓解动作后的版本会标记 supersede 旧版本。

import {
  appointments, blocks, containers, recordAudit, tasks, voyages,
  type Container, type GateAppointment, type YardBlock, type YardTask, parseSlot
} from './domain.js';

// ---------- 参数 ----------

export const DEFAULT_HORIZON_HOURS = 12;
export const DEFAULT_BUCKET_MINUTES = 60;
export const DEFAULT_WARNING_AT = 0.9;
export const DEFAULT_CRITICAL_AT = 0.97;

const CONFIDENT_PROBABILITY = 0.5;                 // 进入 occupied 主线的置信下限
const DISCHARGE_LEAD_MINUTES = 30;                // ETA 后开始卸入堆场
const PICKUP_SPREAD_MINUTES = 20;                 // 提箱预约窗口内默认作业时刻
const LOAD_LEAD_MINUTES = 90;                     // 出口箱 ETD 前默认装船
const BATCH_DISCHARGE_SHARE = 0.25;              // 无箱级样本时，低风险航次推断卸入堆场的剩余 move 比例
const BATCH_DISCHARGE_SHARE_HIGH_RISK = 0.15;   // 高延误风险航次窗口兑现率更低，保守取值
const BATCH_PROBABILITY = 0.45;                   // 推断批次低于主线置信
const ACTION_DELAY_MINUTES = 20;                  // 建议动作默认在调度确认后 20 分钟生效

// ---------- 类型 ----------

export interface BlockClosure {
  id: string;
  blockId: string;
  from: string;
  to: string;
  entryClosed: boolean;   // 封闭进入（入场事件需改道）
  exitClosed: boolean;    // 封闭提离（出场事件暂缓）
  capacityReduced: number; // 封闭期临时削减的容量（检修占用）
  reason: string;
}

export type DeltaKind = 'in' | 'out';
export type Feasibility = 'confirmed' | 'conditional' | 'infeasible';

/** 一次导致区块占用变化的事件。delta +1 进入、-1 离开；批量事件用 containers/units。 */
export interface ForecastEvent {
  key: string;
  at: string;
  blockId: string;
  originBlockId?: string;        // 因封闭改道时的原定区块
  delta: DeltaKind;
  units: number;                 // 贡献箱量（单箱=1，批量推断>1）
  containerId?: string;
  voyageId?: string;
  taskId?: string;
  appointmentId?: string;
  source:
    | 'voyage-discharge'         // 航次卸船（箱级）
    | 'voyage-discharge-batch'   // 航次卸船（无箱级样本的批量推断）
    | 'gate-dropoff'             // 出口集港/还箱进场
    | 'gate-pickup'              // 提箱离场
    | 'vessel-load'              // 装船出口
    | 'rehandle'                 // 翻箱改堆
    | 'inspection-release'       // 查验释放
    | 'closure-marker';          // 临时封闭说明（不计占用）
  probability: number;           // 0–1：事件兑现概率（冷启动批量推断低于确认事件）
  feasibility: Feasibility;
  infeasibleReason?: string;
  excluded?: 'duplicate';       // 重复/改期残留：保留台账但不进需求积压
  description: string;
  mergedFrom?: string[];         // 去重合并掉的其它事件 key
  assumptions?: string[];
}

export interface ForecastPoint {
  t: string;
  bucketIndex: number;
  occupied: number;             // 置信主线（confirmed + probability>=0.5 的 conditional）
  occupiedPessimistic: number;  // 悲观线：纳入全部可行事件
  infeasibleIn: number;         // 想进却进不来（封闭/约束冲突）的箱量
  canceledIn: number;           // 被取消/重复而剔除的预约进场箱量
  capacity: number;             // 考虑临时封闭削减后的有效容量
  utilization: number;
  utilizationPessimistic: number;
  status: 'normal' | 'warning' | 'critical' | 'overflow';
  inConfident: number; outConfident: number;
  inConditional: number; outConditional: number;
  eventKeys: string[];
}

export interface BlockForecast {
  blockId: string;
  zone: string;
  capacity: number;
  baselineOccupied: number;
  warningAt: number;
  criticalAt: number;
  points: ForecastPoint[];
  peak: ForecastPoint;
  criticalFrom?: string;         // 首次达到/超过 criticalAt 的时刻（临界时间）
  warningFrom?: string;
  overflowFrom?: string;        // 超过物理容量的时刻
  maxOverflow: number;
  dataGaps: string[];
  assumptions: string[];
  events: ForecastEvent[];      // 该区块全部贡献事件（含 infeasible/canceled，便于追溯）
  recommendations?: RecommendedAction[];
}

export type ForecastStatus = 'superseded' | 'current' | 'simulation';

export interface ForecastVersion {
  id: string;
  createdAt: string;
  from: string;
  horizonHours: number;
  bucketMinutes: number;
  status: ForecastStatus;
  supersedes?: string;
  scenario: { actionId?: string; actionType?: string; label: string };
  blocks: BlockForecast[];
  changes: ForecastChange[];    // 与上一版本/基线场景的差异
  globalAssumptions: string[];
  generatedFrom: {
    voyages: number; containers: number; appointments: number; tasks: number; closures: number;
  };
}

export interface ForecastChange {
  kind: 'canceled' | 'rerouted' | 'blocked' | 'rehandle' | 'new-event' | 'closure' | 'timing' | 'removed';
  reference: string;           // 箱号/预约/任务/区块
  description: string;
  units: number;
  fromBlock?: string;
  toBlock?: string;
}

export interface ForecastParams {
  from?: string;
  horizonHours?: number;
  bucketMinutes?: number;
  blockId?: string;
  warningAt?: number;
  criticalAt?: number;
  /** 模拟场景：不改台账，只在内存事件集上施加动作，产出 what-if 版本 */
  simulate?: MitigationActionRequest;
}

export type MitigationType =
  | 'expedite-pickup'       // 提前提箱（把出场事件前移）
  | 'reroute-appointment'   // 预约箱改入其他区块
  | 'cancel-dropoff'        // 取消/推迟进场预约
  | 'relocate-stock'        // 在场箱翻箱搬出
  | 'divert-batch'          // 临时封闭入场，后续卸船批量改道
  | 'close-entry';

export interface MitigationActionRequest {
  type: MitigationType;
  blockId: string;
  containerId?: string;
  appointmentId?: string;
  targetBlockId?: string;
  units?: number;            // divert-batch 改道批量
  at?: string;               // 动作生效时刻
}

export interface RecommendedAction {
  id: string;
  type: MitigationType;
  title: string;
  rationale: string;
  blockId: string;
  targetBlockId?: string;
  containerId?: string;
  appointmentId?: string;
  units: number;
  reliefUnits: number;        // 在临界桶可释放/转移的占用
  executeAt: string;
  confidence: number;
  requiresConfirmation: boolean;
}

// ---------- 区块封闭（临时约束） ----------

export const blockClosures: BlockClosure[] = [];
let closureSeq = 0;

export function createBlockClosure(input: Omit<BlockClosure, 'id'>) {
  const block = blocks.find(b => b.id === input.blockId);
  if (!block) throw new Error('区块不存在');
  if (new Date(input.to) <= new Date(input.from)) throw new Error('封闭结束时间必须晚于开始时间');
  if (input.capacityReduced < 0 || input.capacityReduced > block.capacity) throw new Error('削减容量超出区块容量范围');
  if (!input.entryClosed && !input.exitClosed && input.capacityReduced === 0) throw new Error('封闭措施至少需要包含入场/出场限制或容量削减');
  const item: BlockClosure = { ...input, id: `CLS-${Date.now()}-${++closureSeq}` };
  blockClosures.unshift(item);
  recordAudit('CREATE', 'block-closure', item.id, `${item.blockId} 临时封闭：${item.reason}`);
  return item;
}

export function deleteBlockClosure(id: string) {
  const index = blockClosures.findIndex(item => item.id === id);
  if (index < 0) return undefined;
  const [item] = blockClosures.splice(index, 1);
  recordAudit('DELETE', 'block-closure', id, `解除 ${item.blockId} 的临时封闭`);
  return item;
}

function activeClosures(closureSet: BlockClosure[], blockId: string, at: Date) {
  return closureSet.filter(c => c.blockId === blockId && new Date(c.from) <= at && at < new Date(c.to));
}

// ---------- 版本管理 ----------

const versions: ForecastVersion[] = [];
let versionSeq = 0;

export function forecastVersions() { return versions; }
export function forecastVersion(id: string) { return versions.find(v => v.id === id); }

function nextVersionId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `FCST-${stamp}-${String(++versionSeq).padStart(2, '0')}`;
}

// ---------- 事件构造与去重 ----------

type RawEvent = ForecastEvent;

let eventSeq = 0;
function ev(partial: Partial<ForecastEvent> & Pick<ForecastEvent, 'at' | 'blockId' | 'delta' | 'source' | 'description'>): RawEvent {
  return {
    key: `EV-${++eventSeq}`,
    units: 1,
    probability: 1,
    feasibility: 'confirmed',
    ...partial
  };
}

function customsOpen(container: Container) { return container.customs === 'released'; }

/** 箱级事件采集：把每个箱未来的物理移动展开为进出块事件 */
function deriveContainerEvents(horizonEnd: Date, now: Date, appointmentByContainer: Map<string, GateAppointment>, taskList: YardTask[]) {
  const raw: RawEvent[] = [];
  const dataGaps: { blockId: string; message: string }[] = [];
  const gap = (blockId: string | undefined, message: string) => { if (blockId) dataGaps.push({ blockId, message }); };

  for (const c of containers) {
    const currentBlock = parseSlot(c.yardSlot);
    const voyage = voyages.find(v => v.id === c.voyageId);
    const appointment = c.appointmentId ? appointments.find(a => a.id === c.appointmentId) : appointmentByContainer.get(c.id);
    const myTasks = taskList.filter(t => t.containerId === c.id && t.status !== 'done');

    const rehandle = myTasks.find(t => t.kind === 'rehandle');
    const receive = myTasks.find(t => t.kind === 'receive');
    const deliver = myTasks.find(t => t.kind === 'deliver');
    const inspect = myTasks.find(t => t.kind === 'inspect');
    const load = myTasks.find(t => t.kind === 'load');

    // 1) 进口/中转卸船（当前不在场内，且有未到 ETA）
    if ((c.status === 'in-transit' || c.status === 'on-quay') && voyage && new Date(voyage.eta) > now) {
      const at = new Date(new Date(voyage.eta).getTime() + DISCHARGE_LEAD_MINUTES * 60000);
      if (at <= horizonEnd && currentBlock) {
        raw.push(ev({
          at: at.toISOString(), blockId: currentBlock, delta: 'in', containerId: c.id, voyageId: voyage.id,
          source: 'voyage-discharge', probability: voyage.status === 'departed' ? 0 : 0.8,
          feasibility: 'conditional',
          description: `${voyage.vessel} 卸船：${c.id}（${c.direction === 'import' ? '进口' : '中转'}）进入 ${currentBlock}`,
          assumptions: [`卸船开始取 ETA +${DISCHARGE_LEAD_MINUTES} 分钟`]
        }));
      }
    }

    // 2) 闸口还箱/出口集港进场：预约驱动；无预约时 receive 任务也作为独立来源（后续按去重键合并）
    if (currentBlock) {
      const dropApt = appointment?.type === 'dropoff' ? appointment : undefined;
      if (dropApt && ['booked', 'checked-in', 'cancelled'].includes(dropApt.status)) {
        if (dropApt.status === 'cancelled') {
          raw.push(ev({
            at: dropApt.windowStart, blockId: currentBlock, delta: 'in', units: 0,
            containerId: c.id, appointmentId: dropApt.id, source: 'gate-dropoff',
            probability: 0, feasibility: 'infeasible', infeasibleReason: '预约已取消，不产生进场占用',
            description: `${c.id} 的集港预约 ${dropApt.id} 已取消，从预测中剔除`
          }));
        } else {
          const at = new Date(dropApt.windowStart);
          if (at <= horizonEnd) {
            const open = customsOpen(c);
            raw.push(ev({
              at: at.toISOString(), blockId: currentBlock, delta: 'in', containerId: c.id,
              appointmentId: dropApt.id,
              source: 'gate-dropoff', probability: open ? 0.95 : 0.6,
              feasibility: open ? 'conditional' : 'infeasible',
              infeasibleReason: open ? undefined : `海关状态 ${c.customs}，预约进场不能无条件落位`,
              description: `出口集港：${c.id} 按预约 ${timeLabel(dropApt)} 进入 ${currentBlock}`,
              assumptions: ['取预约窗口开始为落位时刻']
            }));
          }
        }
      } else if (receive && new Date(receive.scheduledAt) > now && new Date(receive.scheduledAt) <= horizonEnd) {
        const blocked = receive.status === 'blocked';
        raw.push(ev({
          at: receive.scheduledAt, blockId: currentBlock, delta: 'in', containerId: c.id, taskId: receive.id,
          source: 'gate-dropoff', probability: blocked ? 0.3 : 0.85,
          feasibility: blocked ? 'infeasible' : 'conditional',
          infeasibleReason: blocked ? `接收任务阻塞：${receive.blockingReasons.join('；')}` : undefined,
          description: `接收任务 ${receive.id}：${c.id} 进入 ${currentBlock}`,
          assumptions: ['无闸口预约，按 receive 任务计划时刻预测']
        }));
      }
    }

    // 3) 提箱离场（出口箱不会被提箱，只走装船；海关未放行只降低兑现概率）
    if (appointment && appointment.type === 'pickup' && appointment.status === 'booked' && currentBlock && c.direction !== 'export') {
      const at = new Date(new Date(appointment.windowStart).getTime() + PICKUP_SPREAD_MINUTES * 60000);
      if (at <= horizonEnd) {
        const open = customsOpen(c);
        raw.push(ev({
          at: at.toISOString(), blockId: currentBlock, delta: 'out', containerId: c.id,
          appointmentId: appointment.id, source: 'gate-pickup', probability: open ? 0.9 : 0.6,
          feasibility: open ? 'conditional' : 'infeasible',
          infeasibleReason: open ? undefined : `海关状态 ${c.customs}，提箱预约届时可能无法放行`,
          description: `预约提箱：${c.id} 于 ${timeLabel(appointment)} 离开 ${currentBlock}`,
          assumptions: ['取预约窗口开始 +20 分钟为实际提离时刻']
        }));
      }
    }

    // 3b) 提箱出场任务（无预约的提离，如直接疏港）
    if (!appointment && deliver && currentBlock && c.direction !== 'export') {
      const at = new Date(deliver.scheduledAt);
      if (at > now && at <= horizonEnd) {
        const blocked = deliver.status === 'blocked';
        raw.push(ev({
          at: at.toISOString(), blockId: currentBlock, delta: 'out', containerId: c.id, taskId: deliver.id,
          source: 'gate-pickup', probability: blocked ? 0.3 : 0.85,
          feasibility: blocked ? 'infeasible' : 'conditional',
          infeasibleReason: blocked ? `交付任务阻塞：${deliver.blockingReasons.join('；')}` : undefined,
          description: `交付任务 ${deliver.id}：${c.id} 从 ${currentBlock} 提离`
        }));
      }
    }

    // 4) 装船出口
    if (c.direction === 'export' && currentBlock) {
      const at = load
        ? new Date(load.scheduledAt)
        : voyage ? new Date(new Date(voyage.etd).getTime() - LOAD_LEAD_MINUTES * 60000) : undefined;
      if (at && at > now && at <= horizonEnd && c.status !== 'released') {
        raw.push(ev({
          at: at.toISOString(), blockId: currentBlock, delta: 'out', containerId: c.id, voyageId: voyage?.id,
          taskId: load?.id, source: 'vessel-load', probability: load ? 0.85 : 0.4,
          feasibility: 'conditional',
          description: `装船 ${voyage?.id ?? ''}：${c.id} 从 ${currentBlock} 装出`,
          assumptions: load ? undefined : [`无装船任务，按 ETD -${LOAD_LEAD_MINUTES} 分钟推断`]
        }));
      }
    }

    // 5) 翻箱改堆（两条腿：出旧块、进新块，同 key 组联动）
    if (rehandle) {
      const fromBlock = parseSlot(rehandle.from);
      const toBlock = parseSlot(rehandle.to);
      const at = new Date(rehandle.scheduledAt);
      if (at > now && at <= horizonEnd && fromBlock && toBlock && fromBlock !== toBlock) {
        // 任务被显式阻塞，或处于排队但带有未解除的阻塞原因：只能作为条件受限事件，不进主线/不释放占用
        const blocked = rehandle.status === 'blocked' || rehandle.blockingReasons.length > 0;
        const base = {
          at: at.toISOString(), containerId: c.id, taskId: rehandle.id, source: 'rehandle' as const,
          probability: blocked ? 0.3 : 0.9, feasibility: blocked ? 'infeasible' as const : 'conditional' as const,
          infeasibleReason: blocked ? `任务被阻塞：${rehandle.blockingReasons.join('；')}` : undefined
        };
        raw.push(ev({ ...base, blockId: fromBlock, delta: 'out', description: `翻箱：${c.id} 从 ${fromBlock} 移出（${rehandle.id}）` }));
        raw.push(ev({ ...base, blockId: toBlock, delta: 'in', description: `翻箱：${c.id} 改堆进入 ${toBlock}（${rehandle.id}）` }));
      }
    }

    // 6) 查验释放：在查验区且有查验任务时，按任务时刻释放（仍在场内，不产生块间移动）
    if (currentBlock && inspect) {
      const at = new Date(new Date(inspect.scheduledAt).getTime() + inspect.estimatedMinutes * 60000);
      if (at > now && at <= horizonEnd && c.customs !== 'released') {
        raw.push(ev({
          at: at.toISOString(), blockId: currentBlock, delta: 'in', units: 0,
          containerId: c.id, taskId: inspect.id, source: 'inspection-release',
          probability: 0.35, feasibility: 'infeasible',
          infeasibleReason: '查验完成时刻受海关窗口影响，放行后才有提箱预约可预测',
          description: `查验释放预期：${c.id} 预计 ${at.toISOString()} 完成查验，释放后可被提离（当前仍占 ${currentBlock}）`,
          assumptions: ['释放时刻 = 查验任务计划开始 + 预计时长；无历史放行样本']
        }));
        gap(currentBlock, `${c.id} 查验释放无历史样本，放行时刻不确定，未计入出场`);
      }
    } else if (currentBlock && c.customs === 'inspection' && !inspect) {
      gap(currentBlock, `${c.id} 处于查验中且无查验任务计划，无法预测释放时间`);
    }
  }

  return { raw, dataGaps };
}

function timeLabel(a: GateAppointment) {
  return `${new Date(a.windowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(a.windowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * 去重：
 * - 同一物理移动可能同时来自预约与任务（dropoff+receive），合并成一条；
 * - 取消/已完成事件保留为 0 单位的 infeasible 记账（解释“为什么没算进去”）；
 * - 同一箱同方向多条事件只保留最早一条（重复计划/改期残留），其余标记重复；
 * - 翻箱两条腿通过容器+任务关联，方向不同不合并。
 */
function dedupEvents(raw: RawEvent[]): ForecastEvent[] {
  const canceled = raw.filter(e => e.units === 0);
  const live = raw.filter(e => e.units > 0);
  const merged = new Map<string, RawEvent>();

  const dedupKey = (e: RawEvent) => {
    if (e.containerId && e.delta === 'in' && (e.source === 'gate-dropoff')) return `in:${e.containerId}:dropoff`;
    // 提箱与装船是“箱子离开当前区块”的同一物理动作，统一到离场键；发生区块不同的另一条由后续同箱同方向去重剔除
    if (e.containerId && e.delta === 'out' && (e.source === 'gate-pickup' || e.source === 'vessel-load')) return `out:${e.containerId}:departure`;
    if (e.containerId && e.taskId && e.source === 'rehandle') return `rehandle:${e.containerId}:${e.taskId}:${e.delta}`;
    if (e.containerId && e.source === 'voyage-discharge') return `in:${e.containerId}:discharge`;
    return `${e.delta}:${e.containerId ?? e.key}:${e.source}:${e.blockId}`;
  };

  for (const e of live) {
    const key = dedupKey(e);
    const existing = merged.get(key);
    if (!existing) { merged.set(key, e); continue; }
    // 预约时刻 vs 任务时刻冲突：保留时间更早的，但记录合并痕迹与说明
    const winner = new Date(e.at) <= new Date(existing.at) ? e : existing;
    const loser = winner === e ? existing : e;
    merged.set(key, {
      ...winner,
      mergedFrom: [...(winner.mergedFrom ?? []), loser.key, ...(loser.mergedFrom ?? [])],
      probability: Math.max(winner.probability, loser.probability),
      assumptions: [...(winner.assumptions ?? []), ...(loser.assumptions ?? [])],
      description: `${winner.description}（已合并重复计划 ${loser.key}）`
    });
  }

  // 同一箱同一方向（进场/出场）只保留最早一条有效移动，其余视为改期/重复残留
  const result = [...merged.values()];
  const earliest = new Map<string, ForecastEvent>();
  for (const e of result) {
    if (!e.containerId) continue;
    const dirKey = `${e.delta}:${e.containerId}`;
    const other = earliest.get(dirKey);
    if (!other || new Date(e.at) < new Date(other.at)) earliest.set(dirKey, e);
    else {
      other.mergedFrom = [...(other.mergedFrom ?? []), e.key];
      e.feasibility = 'infeasible';
      e.excluded = 'duplicate';
      e.infeasibleReason = `与 ${other.key} 是同一箱同一方向的重复事件，按更早的 ${new Date(other.at).toLocaleTimeString()} 计划计一次`;
      e.description = `${e.description}（重复，已并入 ${other.key}）`;
    }
  }

  return [...result, ...canceled];
}

// ---------- 航次批量推断（无箱级样本的冷启动处理） ----------

function zoneAffinity(block: YardBlock, kind: 'import' | 'export') {
  const z = block.zone.toLowerCase();
  if (kind === 'import') {
    if (z.includes('import')) return 1;
    if (z.includes('transshipment')) return 0.75;
    if (z.includes('inspection')) return 0.15;
    return 0.3;
  }
  if (z.includes('export')) return 1;
  if (z.includes('transshipment')) return 0.5;
  if (z.includes('inspection')) return 0.1;
  return 0.2;
}

function projectedFreeAt(events: ForecastEvent[], blockId: string, at: Date, baseline: number, closures: BlockClosure[]) {
  const closure = activeClosures(closures, blockId, at);
  const capReduced = closure.reduce((s, c) => s + c.capacityReduced, 0);
  let occupied = baseline;
  for (const e of events) {
    if (e.blockId !== blockId || e.units === 0) continue;
    if (e.feasibility === 'infeasible') continue;
    if (new Date(e.at) <= at) occupied += e.delta === 'in' ? e.units * (e.probability >= CONFIDENT_PROBABILITY ? 1 : 0) : -e.units * (e.probability >= CONFIDENT_PROBABILITY ? 1 : 0);
  }
  const block = blocks.find(b => b.id === blockId)!;
  return block.capacity - capReduced - occupied;
}

/**
 * 没有箱级样本的航次剩余 move：按“剩余作业量 × 推断进场比例”折成批量卸船事件，
 * 按区块职能亲和度与预计空位分配；无可用样本是显式假设而不是隐式系数。
 */
function deriveBatchEvents(events: ForecastEvent[], horizonEnd: Date, now: Date, closureSet: BlockClosure[], changes: ForecastChange[]) {
  const out: ForecastEvent[] = [];
  for (const voyage of voyages) {
    if (voyage.status === 'departed') continue;
    const eta = new Date(voyage.eta);
    if (eta > horizonEnd || new Date(voyage.etd) <= now) continue;

    const known = containers.filter(c => c.voyageId === voyage.id);
    const knownInbound = known.filter(c => c.direction !== 'export' && c.status !== 'released').length;
    const unexplained = Math.max(0, voyage.movesPlanned - voyage.movesDone - knownInbound);
    const share = voyage.lateRisk === 'high' ? BATCH_DISCHARGE_SHARE_HIGH_RISK : BATCH_DISCHARGE_SHARE;
    const batchUnits = Math.round(unexplained * share);
    if (batchUnits <= 0) continue;

    const windowEnd = new Date(Math.min(new Date(voyage.etd).getTime(), horizonEnd.getTime()));
    const buckets = Math.max(1, Math.round((windowEnd.getTime() - Math.max(eta.getTime(), now.getTime())) / 3600000));

    const candidates = blocks
      .filter(b => !activeClosures(closureSet, b.id, eta).some(c => c.entryClosed))
      .map(b => ({ block: b, weight: zoneAffinity(b, 'import') }));
    const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
    if (totalWeight === 0) {
      changes.push({ kind: 'blocked', reference: voyage.id, units: batchUnits, description: `${voyage.vessel} 有 ${batchUnits} 个推断卸箱但所有入场区块均封闭` });
      continue;
    }

    // 最大余数法按亲和度分配整数箱量
    let raw = candidates.map(c => ({ ...c, exact: batchUnits * c.weight / totalWeight, units: Math.floor(batchUnits * c.weight / totalWeight) }));
    let assigned = raw.reduce((s, c) => s + c.units, 0);
    raw = raw.sort((a, b) => (b.exact - b.units) - (a.exact - a.units));
    for (const c of raw) { if (assigned >= batchUnits) break; c.units += 1; assigned += 1; }

    let remaining = batchUnits;
    for (const c of raw) {
      if (c.units <= 0) continue;
      const free = projectedFreeAt(events.concat(out), c.block.id, eta, blocks.find(b => b.id === c.block.id)!.occupied, closureSet);
      let units = c.units;
      if (free < units) {
        changes.push({ kind: 'blocked', reference: voyage.id, units: units - Math.max(0, free), fromBlock: c.block.id, description: `${c.block.id} 预计无法承接 ${voyage.id} 批量卸箱中的 ${units - Math.max(0, free)} 个` });
        units = Math.max(0, free);
      }
      if (units <= 0) continue;
      remaining -= units;
      // 批量摊到航次作业窗口内的每小时桶
      let per = units;
      for (let i = 0; i < buckets && per > 0; i++) {
        const slice = i === buckets - 1 ? per : Math.min(per, Math.max(1, Math.round(units / buckets)));
        per -= slice;
        out.push(ev({
          key: `BATCH-${voyage.id}-${c.block.id}-${i}`,
          at: new Date(Math.max(eta.getTime(), now.getTime()) + i * 3600000 + DISCHARGE_LEAD_MINUTES * 60000).toISOString(),
          blockId: c.block.id, delta: 'in', units: slice, voyageId: voyage.id,
          source: 'voyage-discharge-batch', probability: BATCH_PROBABILITY, feasibility: 'conditional',
          description: `${voyage.vessel} 批量推断卸船：${slice} 个未建档箱进入 ${c.block.id}`,
          assumptions: [
            `剩余 ${unexplained} moves × 推断比例（无箱级样本，按延误风险取值）`,
            `按区块职能亲和度分配，摊到 ${buckets} 个作业小时`
          ]
        }));
      }
    }
    if (remaining > 0) {
      changes.push({ kind: 'blocked', reference: voyage.id, units: remaining, description: `${voyage.vessel} 批量推断的 ${remaining} 个卸箱没有可承接区块（岸线积压风险）` });
    }
  }
  return out;
}

// ---------- 封闭改道 ----------

function compatible(block: YardBlock, reefer: boolean, hazmat: boolean) {
  if (hazmat && !block.hazmatAllowed) return false;
  if (reefer && block.reeferPlugs - block.usedPlugs <= 0) return false;
  return true;
}

function rerouteTarget(blockId: string, at: Date, events: ForecastEvent[], closureSet: BlockClosure[], opts: { reefer?: boolean; hazmat?: boolean } = {}) {
  const target = blocks
    .filter(b => b.id !== blockId)
    .filter(b => !activeClosures(closureSet, b.id, at).some(c => c.entryClosed))
    .filter(b => compatible(b, Boolean(opts.reefer), Boolean(opts.hazmat)))
    .map(b => {
      const free = projectedFreeAt(events, b.id, at, b.occupied, closureSet);
      const heatPenalty = b.heat;
      return { b, score: free * 2 - heatPenalty - (free <= 0 ? 1000 : 0) };
    })
    .sort((a, z) => z.score - a.score)[0];
  return target?.b;
}

function applyClosures(events: ForecastEvent[], closureSet: BlockClosure[], changes: ForecastChange[], now: Date) {
  // 入场封闭只影响封闭生效后才发生的进场（已开始/已签到的预约按落场处理，不追溯改道）
  for (const e of events) {
    if (e.delta !== 'in' || e.units === 0) continue;
    const when = new Date(e.at);
    if (when <= now) continue;
    const closures = activeClosures(closureSet, e.blockId, when);
    if (!closures.some(c => c.entryClosed)) continue;
    const c = containers.find(item => item.id === e.containerId);
    const target = rerouteTarget(e.blockId, new Date(e.at), events, closureSet, { reefer: c?.reefer, hazmat: Boolean(c?.hazmatClass) });
    if (target) {
      e.originBlockId = e.blockId;
      e.blockId = target.id;
      e.description = `${e.description}（封闭改道自 ${e.originBlockId}）`;
      changes.push({ kind: 'rerouted', reference: e.containerId ?? e.voyageId ?? e.key, units: e.units, fromBlock: e.originBlockId, toBlock: target.id, description: `封闭改道：${e.containerId ?? e.voyageId ?? e.key} 的进场 ${e.originBlockId} → ${target.id}` });
    } else {
      e.feasibility = 'infeasible';
      e.infeasibleReason = `${e.blockId} 临时封闭且无满足约束的替代区块`;
      changes.push({ kind: 'blocked', reference: e.containerId ?? e.voyageId ?? e.key, units: e.units, fromBlock: e.blockId, description: `${e.blockId} 封闭，${e.containerId ?? e.voyageId} 的进场无区块可承接` });
    }
  }
}

// ---------- 投影 ----------

function project(block: YardBlock, events: ForecastEvent[], buckets: Date[], closureSet: BlockClosure[], warningAt: number, criticalAt: number, now: Date) {
  const points: ForecastPoint[] = [];
  let occupied = block.occupied;
  let pessimistic = block.occupied;
  let infeasibleIn = 0;
  let canceledIn = 0;

  // 封闭标记事件（用于时间轴说明，不计数）
  for (const c of closureSet.filter(item => item.blockId === block.id)) {
    events.push(ev({
      key: `CLS-MARK-${c.id}`, at: c.from, blockId: block.id, delta: 'in', units: 0,
      source: 'closure-marker', probability: 0, feasibility: 'infeasible',
      description: `区块临时封闭 ${c.reason}（入场${c.entryClosed ? '禁' : '允'} / 出场${c.exitClosed ? '禁' : '允'} / 容量-${c.capacityReduced}）`
    }));
  }

  const blockEvents = events.filter(e => e.blockId === block.id).sort((a, b) => +new Date(a.at) - +new Date(b.at));

  for (let i = 0; i < buckets.length; i++) {
    const t = buckets[i];
    let inC = 0, outC = 0, inCond = 0, outCond = 0;
    const keys: string[] = [];

    for (const e of blockEvents) {
      const at = new Date(e.at);
      // 只投影预测起点之后的事件；更早的移动已体现在 baseline occupied 中
      const inBucket = at > now && at > (i === 0 ? new Date(0) : buckets[i - 1]) && at <= t;
      if (!inBucket) continue;
      keys.push(e.key);
      if (e.units === 0) {
        if (e.source === 'gate-dropoff') canceledIn += 1; // 取消的预约：不产生需求
        continue;
      }
      if (e.feasibility === 'infeasible') {
        if (e.delta === 'in') { if (e.excluded === 'duplicate') canceledIn += e.units; else infeasibleIn += e.units; }
        // 出场被阻塞（封闭出场/海关）：悲观线也不让它释放
        continue;
      }
      const confident = e.probability >= CONFIDENT_PROBABILITY;
      if (e.delta === 'in') {
        if (confident) { occupied += e.units; inC += e.units; }
        else inCond += e.units;
        pessimistic += e.units;
      } else {
        const exitBlocked = activeClosures(closureSet, block.id, at).some(c => c.exitClosed);
        if (exitBlocked) {
          e.feasibility = 'infeasible';
          e.infeasibleReason = '区块临时禁止提离';
          continue;
        }
        if (confident) { occupied -= e.units; outC += e.units; }
        else outCond += e.units;
        pessimistic -= e.units;
      }
    }

    const capReduced = activeClosures(closureSet, block.id, t).reduce((s, c) => s + c.capacityReduced, 0);
    const capacity = block.capacity - capReduced;
    const utilization = Math.max(0, occupied) / capacity;
    const utilizationP = Math.max(0, pessimistic) / capacity;
    const status: ForecastPoint['status'] =
      occupied > capacity || pessimistic > capacity ? 'overflow'
      : utilizationP >= criticalAt || utilization >= criticalAt ? 'critical'
      : utilizationP >= warningAt || utilization >= warningAt ? 'warning'
      : 'normal';

    points.push({
      t: t.toISOString(), bucketIndex: i,
      occupied: Math.max(0, occupied), occupiedPessimistic: Math.max(0, pessimistic),
      infeasibleIn, canceledIn, capacity,
      utilization, utilizationPessimistic: utilizationP, status,
      inConfident: inC, outConfident: outC, inConditional: inCond, outConditional: outCond,
      eventKeys: keys
    });
  }
  return { points, events: blockEvents };
}

// ---------- 缓解动作 ----------

function actionLabel(req: MitigationActionRequest) {
  switch (req.type) {
    case 'expedite-pickup': return `提前提箱 ${req.containerId ?? ''}`;
    case 'reroute-appointment': return `预约改道 ${req.containerId ?? ''} → ${req.targetBlockId ?? ''}`;
    case 'cancel-dropoff': return `取消/推迟进场 ${req.appointmentId ?? req.containerId ?? ''}`;
    case 'relocate-stock': return `翻箱搬出 ${req.containerId ?? ''} → ${req.targetBlockId ?? ''}`;
    case 'divert-batch': return `批量改道 ${req.units ?? 0} 箱 → ${req.targetBlockId ?? ''}`;
    case 'close-entry': return `临时封闭 ${req.blockId} 入场`;
  }
}

/** 在事件集上施加一个缓解动作（模拟用，不动台账） */
function applyActionToEvents(events: ForecastEvent[], req: MitigationActionRequest, atIso: string, closures: BlockClosure[], changes: ForecastChange[], now: Date): ForecastEvent[] {
  const next: ForecastEvent[] = events.map(e => ({ ...e, mergedFrom: e.mergedFrom ? [...e.mergedFrom] : undefined, assumptions: e.assumptions ? [...e.assumptions] : undefined }));
  const at = new Date(atIso);
  const target = req.targetBlockId ? blocks.find(b => b.id === req.targetBlockId) : undefined;

  switch (req.type) {
    case 'expedite-pickup': {
      const e = next.find(item => item.containerId === req.containerId && item.delta === 'out' && new Date(item.at) > at);
      if (e) { const old = e.at; e.at = atIso; e.probability = Math.max(e.probability, 0.95); e.feasibility = 'confirmed'; e.infeasibleReason = undefined; changes.push({ kind: 'timing', reference: req.containerId!, units: 1, fromBlock: e.blockId, description: `提离时刻 ${new Date(old).toLocaleTimeString()} 提前到 ${new Date(atIso).toLocaleTimeString()}` }); }
      break;
    }
    case 'reroute-appointment': {
      const e = next.find(item => item.containerId === req.containerId && item.delta === 'in' && new Date(item.at) >= at && item.blockId === req.blockId);
      if (e && target) { e.originBlockId = e.blockId; e.blockId = target.id; e.feasibility = 'confirmed'; e.infeasibleReason = undefined; changes.push({ kind: 'rerouted', reference: req.containerId!, units: 1, fromBlock: e.originBlockId, toBlock: target.id, description: `预约落位由 ${e.originBlockId} 改至 ${target.id}` }); }
      break;
    }
    case 'cancel-dropoff': {
      const e = next.find(item => (req.appointmentId ? item.appointmentId === req.appointmentId : item.containerId === req.containerId) && item.delta === 'in');
      if (e) { e.units = 0; e.feasibility = 'infeasible'; e.infeasibleReason = '调度取消/推迟该进场预约'; e.probability = 0; changes.push({ kind: 'canceled', reference: req.appointmentId ?? req.containerId!, units: 1, fromBlock: e.blockId, description: `取消进场预约，原计划 ${new Date(e.at).toLocaleTimeString()} 进入 ${e.blockId}` }); }
      break;
    }
    case 'relocate-stock': {
      if (!target) break;
      const moveAt = atIso;
      next.push(ev({ key: `WHATIF-REL-${req.containerId}-OUT`, at: moveAt, blockId: req.blockId, delta: 'out', containerId: req.containerId, source: 'rehandle', probability: 0.95, feasibility: 'confirmed', description: `模拟翻箱：${req.containerId} 从 ${req.blockId} 搬出` }));
      next.push(ev({ key: `WHATIF-REL-${req.containerId}-IN`, at: moveAt, blockId: target.id, delta: 'in', containerId: req.containerId, source: 'rehandle', probability: 0.95, feasibility: 'confirmed', description: `模拟翻箱：${req.containerId} 改堆进入 ${target.id}` }));
      changes.push({ kind: 'rehandle', reference: req.containerId!, units: 1, fromBlock: req.blockId, toBlock: target.id, description: `在 ${new Date(moveAt).toLocaleTimeString()} 把在场箱翻到 ${target.id}` });
      break;
    }
    case 'divert-batch': {
      if (!target) break;
      const candidates = next
        .filter(e => e.blockId === req.blockId && e.delta === 'in' && e.source === 'voyage-discharge-batch' && new Date(e.at) >= at)
        .sort((a, b) => +new Date(a.at) - +new Date(b.at));
      let units = req.units ?? candidates.reduce((s, e) => s + e.units, 0);
      for (const e of candidates) {
        if (units <= 0) break;
        const take = Math.min(units, e.units);
        changes.push({ kind: 'rerouted', reference: e.voyageId ?? e.key, units: take, fromBlock: req.blockId, toBlock: target.id, description: `${take} 个批量推断卸箱由 ${req.blockId} 改道 ${target.id}` });
        if (take === e.units) {
          e.originBlockId = e.blockId; e.blockId = target.id;
          e.description = `批量改道：${take} 个推断卸箱进入 ${target.id}（原计划 ${e.originBlockId}）`;
        } else {
          e.units -= take;
          next.push(ev({ key: `${e.key}-DIV`, at: e.at, blockId: target.id, originBlockId: req.blockId, delta: 'in', units: take, voyageId: e.voyageId, source: 'voyage-discharge-batch', probability: e.probability, feasibility: 'conditional', description: `批量改道：${take} 个推断卸箱进入 ${target.id}（原计划 ${req.blockId}）` }));
        }
        units -= take;
      }
      break;
    }
    case 'close-entry': {
      const simClosure: BlockClosure = { id: 'WHATIF-CLS', blockId: req.blockId, from: atIso, to: new Date(at.getTime() + 4 * 3600000).toISOString(), entryClosed: true, exitClosed: false, capacityReduced: 0, reason: '模拟临时封闭入场' };
      applyClosures(next, closures.concat(simClosure), changes, now);
      changes.push({ kind: 'closure', reference: req.blockId, units: 0, description: `模拟封闭 ${req.blockId} 入场 4 小时，后续进场自动改道` });
      break;
    }
  }
  return next;
}

// ---------- 推荐缓解动作 ----------

function recommend(blockFc: BlockForecast, events: ForecastEvent[], closures: BlockClosure[], now: Date): RecommendedAction[] {
  const actions: RecommendedAction[] = [];
  const criticalPoint = blockFc.points.find(p => p.status === 'critical' || p.status === 'overflow');
  if (!criticalPoint) return actions;
  const criticalAt = new Date(criticalPoint.t);
  const need = Math.max(1, blockFc.peak.occupiedPessimistic - Math.round(blockFc.capacity * blockFc.criticalAt));
  const executeAt = new Date(now.getTime() + ACTION_DELAY_MINUTES * 60000);
  let relief = 0;
  const push = (a: Omit<RecommendedAction, 'id' | 'reliefUnits' | 'executeAt' | 'requiresConfirmation'>) => {
    actions.push({ ...a, id: `REC-${blockFc.blockId}-${actions.length + 1}`, reliefUnits: a.units, executeAt: executeAt.toISOString(), requiresConfirmation: true });
  };

  // 1) 提前提箱：只有“发生在临界桶之后（含）”的出场，前移到动作时刻才真正降低临界占用
  const outEvents = events
    .filter(e => e.delta === 'out' && e.blockId === blockFc.blockId && e.units > 0 && e.feasibility !== 'infeasible')
    .filter(e => new Date(e.at) > criticalAt)
    .sort((a, b) => +new Date(a.at) - +new Date(b.at));
  for (const e of outEvents) {
    if (relief >= need) break;
    if (!e.containerId) continue;
    push({ type: 'expedite-pickup', title: `提前提箱 ${e.containerId}`, rationale: `该箱已有 ${e.appointmentId ? '提箱预约' : '装船/出场计划'}，协调提前可在临界时刻前释放 1 个位`, blockId: blockFc.blockId, containerId: e.containerId, appointmentId: e.appointmentId, units: 1, confidence: 0.85 });
    relief += 1;
  }

  // 2) 预约进场改道到低压力区块
  const dropEvents = events
    .filter(e => e.delta === 'in' && e.blockId === blockFc.blockId && e.units > 0 && (e.source === 'gate-dropoff' || e.source === 'voyage-discharge'))
    .filter(e => new Date(e.at) <= criticalAt && new Date(e.at) >= now);
  for (const e of dropEvents) {
    if (relief >= need) break;
    const c = containers.find(item => item.id === e.containerId);
    const target = rerouteTarget(blockFc.blockId, new Date(e.at), events, closures, { reefer: c?.reefer, hazmat: Boolean(c?.hazmatClass) });
    if (!target) continue;
    push({ type: 'reroute-appointment', title: `${e.containerId ? '预约箱改道' : '卸船箱改道'} ${e.containerId ?? e.voyageId ?? ''} → ${target.id}`, rationale: `${target.id} 当前 ${target.occupied}/${target.capacity}，满足${c?.reefer ? '冷藏' : ''}${c?.hazmatClass ? '危险品' : ''}约束且有余位`, blockId: blockFc.blockId, targetBlockId: target.id, containerId: e.containerId, appointmentId: e.appointmentId, units: e.units, confidence: 0.8 });
    relief += e.units;
  }

  // 3) 在场箱翻箱搬出
  if (relief < need) {
    const inYard = containers
      .filter(c => parseSlot(c.yardSlot) === blockFc.blockId)
      .filter(c => !c.hazmatClass || true);
    for (const c of inYard) {
      if (relief >= need) break;
      const target = rerouteTarget(blockFc.blockId, executeAt, events, closures, { reefer: c.reefer, hazmat: Boolean(c.hazmatClass) });
      if (!target) continue;
      push({ type: 'relocate-stock', title: `翻箱搬出 ${c.id} → ${target.id}`, rationale: `在场箱可由场桥提前翻到 ${target.id}，直接降低 ${blockFc.blockId} 占用`, blockId: blockFc.blockId, targetBlockId: target.id, containerId: c.id, units: 1, confidence: 0.7 });
      relief += 1;
    }
  }

  // 4) 批量卸船改道（针对无箱级样本的进场洪峰）
  if (relief < need) {
    const batch = events.filter(e => e.blockId === blockFc.blockId && e.source === 'voyage-discharge-batch' && e.delta === 'in' && new Date(e.at) <= criticalAt);
    const batchUnits = batch.reduce((s, e) => s + e.units, 0);
    const target = rerouteTarget(blockFc.blockId, criticalAt, events, closures);
    if (batchUnits > 0 && target) {
      const units = Math.min(batchUnits, need - relief);
      push({ type: 'divert-batch', title: `封闭入场并引导 ${units} 个卸箱改道 ${target.id}`, rationale: `临界时刻主要由 ${[...new Set(batch.map(e => e.voyageId))].join('/')} 批量推断卸箱贡献，提前锁定 ${target.id} 接收`, blockId: blockFc.blockId, targetBlockId: target.id, units, confidence: 0.55 });
      relief += units;
    } else {
      push({ type: 'close-entry', title: `临时封闭 ${blockFc.blockId} 入场`, rationale: '无单个箱可调整时，先封闭入场让系统把后续进场自动改道，再人工翻箱疏解', blockId: blockFc.blockId, units: 0, confidence: 0.5 });
    }
  }

  return actions;
}

// ---------- 主入口 ----------

export function runForecast(params: ForecastParams = {}): ForecastVersion {
  const now = params.from ? new Date(params.from) : new Date();
  const horizonHours = params.horizonHours ?? DEFAULT_HORIZON_HOURS;
  const bucketMinutes = params.bucketMinutes ?? DEFAULT_BUCKET_MINUTES;
  const warningAt = params.warningAt ?? DEFAULT_WARNING_AT;
  const criticalAt = params.criticalAt ?? DEFAULT_CRITICAL_AT;
  const horizonEnd = new Date(now.getTime() + horizonHours * 3600000);

  const bucketCount = Math.ceil((horizonEnd.getTime() - now.getTime()) / (bucketMinutes * 60000));
  const buckets = Array.from({ length: bucketCount }, (_v, i) => new Date(now.getTime() + (i + 1) * bucketMinutes * 60000));

  const changes: ForecastChange[] = [];
  const byContainer = new Map<string, GateAppointment>();
  for (const a of appointments) byContainer.set(a.containerId, a);

  // 模拟场景使用当前封闭集的副本
  const closureSet = [...blockClosures];

  let { raw, dataGaps } = deriveContainerEvents(horizonEnd, now, byContainer, tasks);
  let events = dedupEvents(raw);
  const batch = deriveBatchEvents(events, horizonEnd, now, closureSet, changes);
  events = events.concat(batch);
  applyClosures(events, closureSet, changes, now);

  const globalAssumptions = [
    `预测窗口 ${horizonHours} 小时、桶粒度 ${bucketMinutes} 分钟；置信主线 probability ≥ ${CONFIDENT_PROBABILITY}`,
    `航次剩余 move 无箱级样本时按延误风险取 ${BATCH_DISCHARGE_SHARE_HIGH_RISK}–${BATCH_DISCHARGE_SHARE} 推断进场比例，单独以悲观线呈现（probability ${BATCH_PROBABILITY}）`,
    '已取消预约、已完成任务、改堆旧位置、重复计划均不计数，在贡献台账中可查',
    '临时封闭期间入场事件自动改道，无可承接区块则计为 infeasible；出场封闭时提离事件不释放占用'
  ];

  // 施加模拟动作（what-if 只呈现动作自身带来的差异，不重复列基线已有的批量积压）
  let scenarioLabel = '当前作业态势';
  if (params.simulate) {
    scenarioLabel = `模拟：${actionLabel(params.simulate)}`;
    changes.length = 0;
    const actionAt = params.simulate.at ?? new Date(now.getTime() + ACTION_DELAY_MINUTES * 60000).toISOString();
    events = applyActionToEvents(events, params.simulate, actionAt, closureSet, changes, now);
  }

  // 模拟场景需要展示源区块和目标区块双方，因此不做单区块过滤
  const selected = (!params.blockId || params.simulate) ? blocks : blocks.filter(b => b.id === params.blockId);
  const blockForecasts: BlockForecast[] = selected.map(block => {
    const cloneEvents = (list: ForecastEvent[]): ForecastEvent[] => list.map(e => ({ ...e, mergedFrom: e.mergedFrom ? [...e.mergedFrom] : undefined, assumptions: e.assumptions ? [...e.assumptions] : undefined }));
    const { points, events: blockEvents } = project(block, cloneEvents(events), buckets, closureSet, warningAt, criticalAt, now);
    const peak = [...points].sort((a, b) => b.occupiedPessimistic - a.occupiedPessimistic)[0];
    const warning = points.find(p => p.utilizationPessimistic >= warningAt || p.utilization >= warningAt);
    const critical = points.find(p => p.status === 'critical' || p.status === 'overflow');
    const overflow = points.find(p => p.occupied > p.capacity || p.occupiedPessimistic > p.capacity);
    const maxOverflow = points.reduce((m, p) => Math.max(m, p.occupiedPessimistic - p.capacity), 0);
    const gaps = dataGaps.filter(g => g.blockId === block.id).map(g => g.message);
    if (!blockEvents.some(e => e.units > 0 && e.source !== 'closure-marker' && new Date(e.at) > now && new Date(e.at) <= horizonEnd)) gaps.push(`${block.id} 在预测窗口内没有任何箱级事件样本，采用“当前占用持平”基线`);
    const assumptions = [...new Set(blockEvents.flatMap(e => e.assumptions ?? []))];
    return {
      blockId: block.id, zone: block.zone, capacity: block.capacity, baselineOccupied: block.occupied,
      warningAt, criticalAt, points, peak,
      warningFrom: warning?.t, criticalFrom: critical?.t, overflowFrom: overflow?.t,
      maxOverflow, dataGaps: [...new Set(gaps)], assumptions, events: blockEvents
    };
  });

  // 推荐动作（仅当前态势需要；模拟版本不重复推荐）
  if (!params.simulate) {
    for (const bf of blockForecasts) {
      const recs = recommend(bf, events, closureSet, now);
      bf.recommendations = recs;
    }
  }

  const isSim = Boolean(params.simulate);
  const previous = versions.find(v => v.status === 'current');

  // 与上一版本对比临界时间/峰值的移动，方便调度员核对动作效果
  if (previous) {
    for (const bf of blockForecasts) {
      const old = previous.blocks.find(item => item.blockId === bf.blockId);
      if (!old) continue;
      const peakDelta = bf.peak.occupiedPessimistic - old.peak.occupiedPessimistic;
      if (peakDelta !== 0) changes.push({ kind: 'new-event', reference: bf.blockId, units: Math.abs(peakDelta), description: `${bf.blockId} 窗口峰值由 ${old.peak.occupiedPessimistic} 变为 ${bf.peak.occupiedPessimistic}（${peakDelta < 0 ? '下降' : '上升'} ${Math.abs(peakDelta)}）` });
      if (old.criticalFrom && !bf.criticalFrom) changes.push({ kind: 'removed', reference: bf.blockId, units: 0, description: `${bf.blockId} 临界状态解除（原临界时间 ${new Date(old.criticalFrom).toLocaleTimeString()}）` });
      else if (!old.criticalFrom && bf.criticalFrom) changes.push({ kind: 'new-event', reference: bf.blockId, units: 0, description: `${bf.blockId} 新进入临界状态，临界时间 ${new Date(bf.criticalFrom).toLocaleTimeString()}` });
      else if (old.criticalFrom && bf.criticalFrom && old.criticalFrom !== bf.criticalFrom) changes.push({ kind: 'timing', reference: bf.blockId, units: 0, description: `${bf.blockId} 临界时间由 ${new Date(old.criticalFrom).toLocaleTimeString()} 移动到 ${new Date(bf.criticalFrom).toLocaleTimeString()}` });
    }
  }

  const version: ForecastVersion = {
    id: nextVersionId(),
    createdAt: new Date().toISOString(),
    from: now.toISOString(),
    horizonHours, bucketMinutes,
    status: isSim ? 'simulation' : 'current',
    supersedes: isSim ? undefined : previous?.id,
    scenario: { actionType: params.simulate?.type, label: scenarioLabel },
    blocks: blockForecasts,
    changes,
    globalAssumptions,
    generatedFrom: { voyages: voyages.length, containers: containers.length, appointments: appointments.length, tasks: tasks.length, closures: closureSet.length }
  };

  versions.unshift(version);
  if (!isSim && previous) previous.status = 'superseded';
  return version;
}

// ---------- 动作执行（落台账 + 重新预测，版本替换） ----------

export function executeMitigation(req: MitigationActionRequest): { version: ForecastVersion; applied: string[] } {
  const applied: string[] = [];
  const now = new Date();
  const atIso = (req.at ? new Date(req.at) : new Date(now.getTime() + ACTION_DELAY_MINUTES * 60000)).toISOString();
  const block = blocks.find(b => b.id === req.blockId);
  if (!block) throw new Error('区块不存在');
  const target = req.targetBlockId ? blocks.find(b => b.id === req.targetBlockId) : undefined;
  if (req.targetBlockId && !target) throw new Error('目标区块不存在');
  if (req.targetBlockId === req.blockId) throw new Error('目标区块不能与当前区块相同');

  switch (req.type) {
    case 'expedite-pickup': {
      const c = containers.find(item => item.id === req.containerId);
      if (!c) throw new Error('箱号不存在');
      const apt = appointments.find(a => a.id === c.appointmentId && a.type === 'pickup')
        ?? appointments.find(a => a.containerId === c.id && a.type === 'pickup' && a.status === 'booked');
      if (!apt) throw new Error('该箱没有可提前的提箱预约');
      const start = new Date(atIso);
      apt.windowStart = start.toISOString();
      apt.windowEnd = new Date(start.getTime() + 30 * 60000).toISOString();
      applied.push(`提箱预约 ${apt.id} 窗口前移至 ${start.toLocaleString()}`);
      break;
    }
    case 'reroute-appointment': {
      if (!target) throw new Error('必须指定目标区块');
      const c = containers.find(item => item.id === req.containerId);
      if (!c) throw new Error('箱号不存在');
      if (c.hazmatClass && !target.hazmatAllowed) throw new Error('目标区块无危险品隔离资质');
      if (c.reefer && target.reeferPlugs - target.usedPlugs <= 0) throw new Error('目标区块没有冷藏插座');
      const row = c.yardSlot.replace(/^[A-Z]\d\d/, target.id);      c.yardSlot = row;
      c.lastEvent = `预约改道至 ${target.id} ${new Date().toLocaleTimeString()}`;
      applied.push(`箱 ${c.id} 预约落位改为 ${row}`);
      break;
    }
    case 'cancel-dropoff': {
      const apt = appointments.find(a => a.id === req.appointmentId)
        ?? appointments.find(a => a.containerId === req.containerId && a.type === 'dropoff');
      if (!apt) throw new Error('没有对应的进场预约');
      apt.status = 'cancelled';
      apt.exception = `调度疏解取消：${block.id} 容量预警`;
      const c = containers.find(item => item.id === apt.containerId);
      if (c?.appointmentId === apt.id) c.appointmentId = undefined;
      applied.push(`进场预约 ${apt.id} 已取消`);
      break;
    }
    case 'relocate-stock': {
      if (!target) throw new Error('必须指定目标区块');
      const c = containers.find(item => item.id === req.containerId);
      if (!c) throw new Error('箱号不存在');
      if (parseSlot(c.yardSlot) !== block.id) throw new Error('该箱当前不在源区块');
      if (c.hazmatClass && !target.hazmatAllowed) throw new Error('目标区块无危险品隔离资质');
      if (c.reefer && target.reeferPlugs - target.usedPlugs <= 0) throw new Error('目标区块没有冷藏插座');
      const toSlot = c.yardSlot.replace(/^[A-Z]\d\d/, target.id);
      tasks.unshift({
        id: `TASK-${Date.now()}`, kind: 'rehandle', containerId: c.id, from: c.yardSlot, to: toSlot,
        priority: 95, status: 'assigned', scheduledAt: atIso, blockingReasons: [], estimatedMinutes: 20
      });
      c.yardSlot = toSlot;
      c.lastEvent = `疏解翻箱至 ${target.id} ${new Date().toLocaleTimeString()}`;
      applied.push(`已创建并确认翻箱任务：${c.id} ${block.id} → ${target.id}`);
      break;
    }
    case 'divert-batch': {
      if (!target) throw new Error('必须指定目标区块');
      const until = new Date(new Date(atIso).getTime() + 4 * 3600000).toISOString();
      createBlockClosure({ blockId: block.id, from: atIso, to: until, entryClosed: true, exitClosed: false, capacityReduced: 0, reason: `容量疏解：引导后续卸箱改道 ${target.id}` });
      applied.push(`已封闭 ${block.id} 入场 4 小时，预测引擎会把后续进场自动改道 ${target.id}`);
      break;
    }
    case 'close-entry': {
      const until = new Date(new Date(atIso).getTime() + 4 * 3600000).toISOString();
      createBlockClosure({ blockId: block.id, from: atIso, to: until, entryClosed: true, exitClosed: false, capacityReduced: req.units ?? 0, reason: '调度手动临时封闭入场' });
      applied.push(`已封闭 ${block.id} 入场${req.units ? `并临时削减 ${req.units} 容量` : ''} 4 小时`);
      break;
    }
  }

  recordAudit('MITIGATE', 'forecast', req.type, `${actionLabel(req)}；${applied.join('；')}`);
  // 重算全部区块：改道目标也可能被压垮，必须一起呈现
  const version = runForecast({});
  return { version, applied };
}
