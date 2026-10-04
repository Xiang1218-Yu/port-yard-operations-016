import {
  appointments, blocks, containers, recordAudit, tasks, voyages,
  type AppointmentStatus, type Container, type GateAppointment, type YardBlock, type YardTask
} from './domain.js';

// ===========================================================================
// 堆场容量预测与预警
// 事件驱动的时间序列投影：每个预测数字都由 ForecastContribution（具名箱或
// 航次批量事件）逐时间桶累加得到，而不是对当前 occupied 做系数放大。
// 规则覆盖：取消预约、箱子改堆、重复事件去重、无历史样本的批量估计、
// 区块临时封闭（容量冻结 + 解封积压尖峰）、预测版本替换与缓解动作重预测。
// ===========================================================================

export type ContributionKind =
  | 'discharge' | 'gate-dropoff' | 'rehandle-in' | 'release-return'
  | 'pickup' | 'load' | 'rehandle-out'
  | 'voyage-discharge' | 'export-gatein' | 'voyage-load';

export interface ForecastContribution {
  id: string;
  kind: ContributionKind;
  refId: string;
  containerId?: string;
  voyageId?: string;
  blockId: string;
  delta: number;
  at: string;
  cert: 'firm' | 'estimated';
  basis: string;
  excluded?: boolean;
  excludedReason?: string;
  duplicateOf?: string;
  movedByAction?: string;
}

export interface BlockClosure {
  id: string;
  blockId: string;
  reason: string;
  startAt: string;
  endAt: string;
  status: 'scheduled' | 'active';
}

export interface ForecastBucket {
  t: string;
  label: string;
  occupied: number;
  inflowFirm: number;
  inflowEstimated: number;
  outflow: number;
  effectiveCapacity: number;
  capacity: number;
  closed: boolean;
}

export type MitigationType = 'rehandle' | 'reschedule' | 'cancel' | 'release' | 'divert-batch' | 'reopen';

export interface MitigationSuggestion {
  id: string;
  type: MitigationType;
  title: string;
  detail: string;
  containerId?: string;
  refId?: string;
  closureId?: string;
  toBlockId?: string;
  voyageId?: string;
  contributionKind?: ContributionKind;
  newTime?: string;
  count?: number;
  projectedPeak: number;
  projectedCriticalAt?: string;
  removesCritical: boolean;
  severity: 'critical' | 'warning';
}

export interface BlockForecast {
  blockId: string;
  zone: string;
  capacity: number;
  baseline: number;
  peak: number;
  peakAt: string;
  finalOccupied: number;
  criticalAt?: string;
  warningAt?: string;
  closureSpikeAt?: string;
  unmetLoad: number;
  buckets: ForecastBucket[];
  contributions: ForecastContribution[];
  suggestions: MitigationSuggestion[];
  notes: string[];
}

export interface ForecastVersion {
  id: string;
  createdAt: string;
  horizonHours: number;
  bucketMinutes: number;
  basisTime: string;
  supersedes?: string;
  scenario: string;
  active: boolean;
  trigger: 'manual' | 'mitigation' | 'simulation';
  actions?: ScenarioAction[];
  blocks: BlockForecast[];
  methodology: string[];
}

export interface ForecastOptions {
  horizonHours?: number;
  bucketMinutes?: number;
  includeEstimated?: boolean;
  now?: string;
  scenario?: string;
  trigger?: ForecastVersion['trigger'];
}

export interface ScenarioAction {
  type: MitigationType;
  containerId?: string;
  refId?: string;
  closureId?: string;
  toBlockId?: string;
  newTime?: string;
  voyageId?: string;
  contributionKind?: ContributionKind;
  count?: number;
}

interface Diversion { voyageId: string; kind: ContributionKind; count: number; toBlockId: string }

interface Snapshot {
  now: number;
  horizonHours: number;
  bucketMinutes: number;
  includeEstimated: boolean;
  blocks: YardBlock[];
  containers: Container[];
  appointments: GateAppointment[];
  tasks: YardTask[];
  closures: BlockClosure[];
  diversions: Diversion[];
  scenario: string;
}

// ---------------------------------------------------------------------------
// 区块临时封闭
// ---------------------------------------------------------------------------

const closures: BlockClosure[] = [
  { id: 'CLS-1001', blockId: 'C03', reason: '轨道检修：C03 半幅封闭，出口集港暂停', startAt: new Date(Date.now() + 150 * 60000).toISOString(), endAt: new Date(Date.now() + 270 * 60000).toISOString(), status: 'scheduled' }
];
let closureSeq = 1002;

export function listClosures() { return closures.slice(); }
export function createClosure(input: Omit<BlockClosure, 'id'>) {
  if (!blocks.some(b => b.id === input.blockId)) throw new Error('区块不存在');
  if (new Date(input.endAt) <= new Date(input.startAt)) throw new Error('封闭结束时间必须晚于开始时间');
  const item: BlockClosure = { ...input, id: `CLS-${closureSeq++}` };
  closures.push(item);
  recordAudit('CREATE', 'block-closure', item.id, `${item.blockId} 临时封闭：${item.reason}`);
  return item;
}
export function updateClosure(id: string, patch: Partial<Omit<BlockClosure, 'id'>>) {
  const item = closures.find(c => c.id === id);
  if (!item) return undefined;
  if (patch.startAt && patch.endAt && new Date(patch.endAt) <= new Date(patch.startAt)) throw new Error('封闭结束时间必须晚于开始时间');
  Object.assign(item, patch);
  recordAudit('UPDATE', 'block-closure', id, `调整封闭窗口：${JSON.stringify(patch)}`);
  return item;
}
export function deleteClosure(id: string) {
  const index = closures.findIndex(c => c.id === id);
  if (index < 0) return undefined;
  const [item] = closures.splice(index, 1);
  recordAudit('DELETE', 'block-closure', id, `解除 ${item.blockId} 的临时封闭`);
  return item;
}

// ---------------------------------------------------------------------------
// 预测版本
// ---------------------------------------------------------------------------

const versions: ForecastVersion[] = [];
let forecastSeq = 0;
const WARN_RATIO = 0.9;

const blockOfSlot = (slot?: string) => slot?.match(/^([A-Z]\d\d)-/)?.[1];
const inHorizon = (snap: Snapshot, time: number) =>
  time > snap.now - 60000 && time < snap.now + snap.horizonHours * 3600000 + 60000;

export function forecastVersions() { return versions.slice(); }
export function activeForecast() { return versions.find(v => v.active); }
export function getForecast(id: string) { return versions.find(v => v.id === id); }

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

function takeSnapshot(options: Pick<ForecastOptions, 'horizonHours' | 'bucketMinutes' | 'includeEstimated' | 'now' | 'scenario'>): Snapshot {
  return {
    now: options.now ? new Date(options.now).getTime() : Date.now(),
    horizonHours: options.horizonHours ?? 12,
    bucketMinutes: options.bucketMinutes ?? 30,
    includeEstimated: options.includeEstimated ?? true,
    blocks: blocks.map(b => ({ ...b })),
    containers: containers.map(c => ({ ...c })),
    appointments: appointments.map(a => ({ ...a })),
    tasks: tasks.map(t => ({ ...t })),
    closures: closures.map(c => ({ ...c })),
    diversions: [],
    scenario: options.scenario ?? 'live'
  };
}

function cloneSnapshot(base: Snapshot): Snapshot {
  return {
    ...base,
    blocks: base.blocks.map(b => ({ ...b })),
    containers: base.containers.map(c => ({ ...c })),
    appointments: base.appointments.map(a => ({ ...a })),
    tasks: base.tasks.map(t => ({ ...t })),
    closures: base.closures.map(c => ({ ...c })),
    diversions: base.diversions.map(d => ({ ...d }))
  };
}

// ---------------------------------------------------------------------------
// 场景动作：在快照副本上改写，不污染真实数据
// ---------------------------------------------------------------------------

function applyAction(snap: Snapshot, action: ScenarioAction): string {
  if (action.type === 'rehandle') {
    const container = snap.containers.find(c => c.id === action.containerId);
    if (!container) throw new Error('箱号不存在');
    const target = snap.blocks.find(b => b.id === action.toBlockId);
    if (!target) throw new Error('目标区块不存在');
    if (container.hazmatClass && !target.hazmatAllowed) throw new Error('目标区块无危险品隔离资质');
    if (container.reefer && target.reeferPlugs <= target.usedPlugs) throw new Error('目标区块没有可用冷藏插座');
    const time = action.newTime ?? new Date(snap.now + 30 * 60000).toISOString();
    const fromBlock = blockOfSlot(container.yardSlot);
    snap.tasks = snap.tasks.filter(t => !(t.kind === 'rehandle' && t.containerId === container.id));
    snap.tasks.push({
      id: `SIM-REH-${container.id}`, kind: 'rehandle', containerId: container.id,
      from: container.yardSlot, to: `${action.toBlockId}-R01-T1`, priority: 90, status: 'queued',
      scheduledAt: time, blockingReasons: [], estimatedMinutes: 20
    });
    container.yardSlot = `${action.toBlockId}-R01-T1`;
    return `改堆 ${container.id}：${fromBlock ?? '?'} → ${action.toBlockId}`;
  }
  if (action.type === 'reschedule') {
    if (!action.newTime) throw new Error('需要新的计划时间');
    const apt = snap.appointments.find(a => a.id === action.refId);
    const task = snap.tasks.find(t => t.id === action.refId);
    if (apt) {
      const start = new Date(action.newTime).getTime();
      apt.windowStart = action.newTime;
      apt.windowEnd = new Date(start + 30 * 60000).toISOString();
      return `预约 ${apt.id} 改约至 ${action.newTime}`;
    }
    if (task) { task.scheduledAt = action.newTime; return `任务 ${task.id} 改期至 ${action.newTime}`; }
    throw new Error('未找到要改期的预约或任务');
  }
  if (action.type === 'cancel') {
    const before = snap.appointments.length;
    snap.appointments = snap.appointments.filter(a => a.id !== action.refId);
    if (snap.appointments.length === before) throw new Error('未找到要取消的预约');
    return `取消预约 ${action.refId}`;
  }
  if (action.type === 'release') {
    const container = snap.containers.find(c => c.id === action.containerId);
    if (!container) throw new Error('箱号不存在');
    if (container.customs === 'released') throw new Error('该箱海关已放行');
    const time = action.newTime ?? new Date(snap.now + 20 * 60000).toISOString();
    if (blockOfSlot(container.yardSlot) === 'D05') {
      const target = action.toBlockId ?? (container.direction === 'import' ? 'A01' : 'B07');
      snap.tasks = snap.tasks.filter(t => !(t.kind === 'inspect' && t.containerId === container.id));
      snap.tasks.push({
        id: `SIM-REL-${container.id}`, kind: 'rehandle', containerId: container.id,
        from: container.yardSlot, to: `${target}-R01-T1`, priority: 95, status: 'queued',
        scheduledAt: time, blockingReasons: [], estimatedMinutes: 20
      });
      container.yardSlot = `${target}-R01-T1`;
    } else {
      snap.tasks = snap.tasks.filter(t => t.kind === 'inspect' && t.containerId === container.id);
    }
    container.customs = 'released';
    return `推动查验释放 ${container.id}`;
  }
  if (action.type === 'divert-batch') {
    if (!action.toBlockId || !action.count || !action.voyageId || !action.contributionKind) throw new Error('分流动作缺少参数');
    if (!snap.blocks.some(b => b.id === action.toBlockId)) throw new Error('目标区块不存在');
    snap.diversions.push({ voyageId: action.voyageId, kind: action.contributionKind, count: action.count, toBlockId: action.toBlockId });
    return `${action.voyageId} ${labelOf(action.contributionKind)} 分流 ${action.count} 箱 → ${action.toBlockId}`;
  }
  if (action.type === 'reopen') {
    const closure = snap.closures.find(c => c.id === action.closureId);
    if (!closure) throw new Error('封闭记录不存在');
    closure.endAt = action.newTime ?? new Date(snap.now + 10 * 60000).toISOString();
    return `提前解除封闭 ${closure.blockId}，积压箱提前消化`;
  }
  throw new Error('未知的缓解动作类型');
}

// ---------------------------------------------------------------------------
// 事件抽取
// ---------------------------------------------------------------------------

const DISCHARGE_SHARE: Record<string, number> = { A01: 0.65, B07: 0.35 };
const GATEIN_SHARE: Record<string, number> = { C03: 0.9, B07: 0.1 };
const LOAD_SHARE: Record<string, number> = { C03: 0.8, B07: 0.2 };

interface PlannedMove {
  container: Container;
  kind: ContributionKind;
  refId: string;
  at: number;
  cert: 'firm' | 'estimated';
  basis: string;
  priority: number;
}

function buildTimeline(snap: Snapshot): Map<string, PlannedMove[]> {
  const map = new Map<string, PlannedMove[]>();
  const push = (containerId: string, move: PlannedMove) => {
    const list = map.get(containerId) ?? [];
    list.push(move); map.set(containerId, list);
  };

  for (const apt of snap.appointments) {
    const container = snap.containers.find(c => c.id === apt.containerId);
    if (!container) continue;
    const status: AppointmentStatus = apt.status;
    if (status === 'cancelled') {
      push(container.id, { container, kind: apt.type === 'pickup' ? 'pickup' : 'gate-dropoff', refId: apt.id, at: 0, cert: 'firm', basis: '预约已取消，不产生流量', priority: 0 });
      continue;
    }
    if (status === 'completed' || status === 'exception') continue;
    if (apt.type === 'pickup') {
      if (container.customs !== 'released') {
        push(container.id, { container, kind: 'pickup', refId: apt.id, at: 0, cert: 'firm', basis: `提箱预约但海关状态=${container.customs}，不能放行`, priority: 0 });
        continue;
      }
      const at = Math.max(new Date(apt.windowStart).getTime(), status === 'checked-in' ? snap.now : 0);
      push(container.id, { container, kind: 'pickup', refId: apt.id, at,
        cert: status === 'checked-in' ? 'firm' : 'estimated',
        basis: status === 'checked-in' ? '车辆已签到，提箱离场确定' : '按预约窗口起点估计提箱离场（无历史样本）', priority: 2 });
    } else {
      if (container.customs === 'hold') {
        push(container.id, { container, kind: 'gate-dropoff', refId: apt.id, at: 0, cert: 'firm', basis: '海关扣留箱不能集港进场', priority: 0 });
        continue;
      }
      // 已签到但窗口已越过当前时刻的，按“即时进场”计入
      const at = Math.max(new Date(apt.windowStart).getTime(), status === 'checked-in' ? snap.now : 0);
      push(container.id, { container, kind: 'gate-dropoff', refId: apt.id, at,
        cert: status === 'checked-in' ? 'firm' : 'estimated',
        basis: status === 'checked-in' ? (at > new Date(apt.windowStart).getTime() ? '已签到且窗口已开始，按当前时刻进场' : '已签到称重，按窗口进场') : '按预约窗口估计集港进场（无历史样本）', priority: 2 });
    }
  }

  for (const task of snap.tasks) {
    if (task.status === 'done') continue;
    const container = snap.containers.find(c => c.id === task.containerId);
    if (!container) continue;
    const at = new Date(task.scheduledAt).getTime();
    switch (task.kind) {
      case 'rehandle':
        push(container.id, { container, kind: 'rehandle-out', refId: task.id, at, cert: 'firm', basis: `改堆任务离开 ${blockOfSlot(task.from) ?? task.from}`, priority: 3 });
        push(container.id, { container, kind: 'rehandle-in', refId: task.id, at, cert: 'firm', basis: `改堆任务进入 ${blockOfSlot(task.to) ?? task.to}`, priority: 3 });
        break;
      case 'load':
        push(container.id, { container, kind: 'load', refId: task.id, at, cert: 'firm', basis: '装船任务，出口箱装船离场', priority: 3 });
        break;
      case 'discharge':
        push(container.id, { container, kind: 'discharge', refId: task.id, at, cert: 'firm', basis: '卸船任务入堆场', priority: 3 });
        break;
      case 'deliver':
        push(container.id, { container, kind: 'pickup', refId: task.id, at, cert: 'firm', basis: '交付任务，箱离开区块去往闸口', priority: 3 });
        break;
      case 'inspect':
        if (container.customs !== 'released') {
          push(container.id, { container, kind: 'release-return', refId: task.id, at: at + task.estimatedMinutes * 60000,
            cert: 'estimated', basis: '查验作业完成后预计放行回区（无历史样本）', priority: 1 });
        }
        break;
      case 'receive':
        push(container.id, { container, kind: 'gate-dropoff', refId: task.id, at, cert: 'firm', basis: '收箱任务进场', priority: 3 });
        break;
    }
  }

  for (const container of snap.containers) {
    const voyage = voyages.find(v => v.id === container.voyageId);
    if (!voyage || voyage.status === 'departed') continue;
    const list = map.get(container.id) ?? [];
    if ((container.status === 'in-transit' || container.status === 'on-quay') && container.direction !== 'export' &&
      !list.some(m => m.kind === 'discharge' && m.at > 0)) {
      push(container.id, { container, kind: 'discharge', refId: `ETA-${voyage.id}`, at: new Date(voyage.eta).getTime(),
        cert: 'estimated', basis: `无卸船任务，按航次 ${voyage.id} ETA 推断落场`, priority: 0 });
    }
    if (container.status === 'at-gate' && container.direction === 'export' &&
      !list.some(m => (m.kind === 'gate-dropoff') && m.at > 0)) {
      push(container.id, { container, kind: 'gate-dropoff', refId: 'GATE-INFER', at: snap.now + 15 * 60000,
        cert: 'firm', basis: '出口箱已在闸口且无有效预约事件，推断即将进入出口预组区', priority: 0 });
    }
  }
  return map;
}

/** 同一物理移动被预约和任务重复描述时：任务优先，其次确定性高、时间早的；被排除的规则事件不参与。 */
function dedupeMoves(moves: PlannedMove[]): { kept: PlannedMove[]; dropped: { move: PlannedMove; winnerId: string }[] } {
  const groups = new Map<string, PlannedMove[]>();
  const groupKey = (m: PlannedMove) => {
    if (m.kind === 'rehandle-in') return 'rehandle-in';
    if (m.kind === 'rehandle-out') return 'rehandle-out';
    if (m.kind === 'gate-dropoff' || m.kind === 'discharge') return 'enter-yard';
    return 'leave-yard'; // pickup / load / release 之后的离场都指向“箱离开当前区块”
  };
  const kept: PlannedMove[] = [];
  const dropped: { move: PlannedMove; winnerId: string }[] = [];
  for (const move of moves) {
    if (move.at === 0) { kept.push(move); continue; }
    const key = groupKey(move);
    const list = groups.get(key) ?? [];
    list.push(move); groups.set(key, list);
  }
  for (const list of groups.values()) {
    if (list.length === 1) { kept.push(list[0]); continue; }
    list.sort((a, b) => b.priority - a.priority || a.at - b.at);
    kept.push(list[0]);
    for (const loser of list.slice(1)) dropped.push({ move: loser, winnerId: list[0].refId });
  }
  return { kept, dropped };
}

function largestRemainder(total: number, shares: Record<string, number>): Record<string, number> {
  const parts = Object.entries(shares).map(([id, s]) => {
    const value = total * s;
    return { id, floor: Math.floor(value), frac: value - Math.floor(value) };
  });
  let remainder = total - parts.reduce((sum, p) => sum + p.floor, 0);
  parts.sort((a, b) => b.frac - a.frac);
  for (const part of parts) { if (remainder <= 0) break; part.floor += 1; remainder -= 1; }
  return Object.fromEntries(parts.map(p => [p.id, p.floor]));
}

function closureAt(snap: Snapshot, blockId: string, time: number) {
  return snap.closures.find(c => c.blockId === blockId &&
    new Date(c.startAt).getTime() <= time && time < new Date(c.endAt).getTime());
}

// ---------------------------------------------------------------------------
// 核心投影：快照 -> 预测版本（不落库）
// ---------------------------------------------------------------------------

function project(snap: Snapshot, trigger: ForecastVersion['trigger'], actions?: ScenarioAction[], supersedes?: string): ForecastVersion {
  const methodology = [
    '事件驱动投影：航次 ETA/ETD、闸口预约窗口、计划任务、查验状态逐桶累加，不对 occupied 做系数放大',
    '具名箱逐箱溯源；航次剩余作业按计划速率摊薄为批量事件，标注 estimated 并写明取数依据',
    '取消预约、海关未放行提箱、扣留箱集港被排除；预约与任务描述同一物理移动时按确定性去重',
    '封闭区块在封闭期内冻结容量（只出不进），进场事件顺延至解封时刻形成积压尖峰',
    '没有历史样本：批量事件按计划速率均匀摊分，估计方法在此显式声明'
  ];
  const horizonEnd = snap.now + snap.horizonHours * 3600000;
  const bucketCount = snap.horizonHours * (60 / snap.bucketMinutes);
  const timeline = buildTimeline(snap);

  const perBlock = new Map<string, ForecastContribution[]>();
  const add = (blockId: string, c: ForecastContribution) => {
    const list = perBlock.get(blockId) ?? [];
    list.push(c); perBlock.set(blockId, list);
  };
  const notes: string[] = [];

  // ---- 具名箱 ----
  for (const [containerId, moves] of timeline) {
    const container = snap.containers.find(c => c.id === containerId)!;
    const { kept, dropped } = dedupeMoves(moves);

    // 时间轴模拟箱的位置：进入/离开有序应用
    let currentBlock = blockOfSlot(container.yardSlot);
    const ordered = kept.filter(m => m.at > 0 && inHorizon(snap, m.at))
      .sort((a, b) => a.at - b.at || b.priority - a.priority);

    // 放行回区之后若已有提箱离场，回区被提箱吸收（箱不经过原区块）
    const releaseMove = ordered.find(m => m.kind === 'release-return');
    const pickupAfterRelease = releaseMove && ordered.some(m =>
      (m.kind === 'pickup' || m.kind === 'load') && m.at >= releaseMove.at);

    for (const move of ordered) {
      if (move.kind === 'gate-dropoff' || move.kind === 'discharge') {
        const target = move.kind === 'discharge'
          ? (blockOfSlot(container.yardSlot) ?? (container.direction === 'transshipment' ? 'B07' : 'A01'))
          : (blockOfSlot(container.yardSlot) ?? (container.direction === 'export' ? 'C03' : 'A01'));
        add(target, { id: `C-${move.refId}-${move.kind}-${containerId}`, kind: move.kind, refId: move.refId,
          containerId, voyageId: container.voyageId, blockId: target, delta: 1,
          at: new Date(move.at).toISOString(), cert: move.cert, basis: move.basis });
        currentBlock = target;
      } else if (move.kind === 'rehandle-in') {
        const task = snap.tasks.find(t => t.id === move.refId);
        const target = blockOfSlot(task?.to);
        if (!target) continue;
        add(target, { id: `C-${move.refId}-rehandle-in-${containerId}`, kind: 'rehandle-in', refId: move.refId,
          containerId, voyageId: container.voyageId, blockId: target, delta: 1,
          at: new Date(move.at).toISOString(), cert: 'firm', basis: move.basis });
        currentBlock = target;
      } else if (move.kind === 'release-return') {
        if (pickupAfterRelease) {
          add(blockOfSlot(container.yardSlot) ?? 'D05', { id: `EXC-${move.refId}-${containerId}`, kind: 'release-return',
            refId: move.refId, containerId, voyageId: container.voyageId, blockId: blockOfSlot(container.yardSlot) ?? 'D05',
            delta: 0, at: new Date(move.at).toISOString(), cert: move.cert,
            basis: `${move.basis}；放行后直接提箱离场，不回原区块`, excluded: true, excludedReason: '被随后的提箱/装船吸收' });
          continue;
        }
        const inspectTask = snap.tasks.find(t => t.id === move.refId);
        const target = blockOfSlot(inspectTask?.to) ?? (container.direction === 'import' ? 'A01' : 'B07');
        const source = blockOfSlot(container.yardSlot) ?? 'D05';
        if (target === source) {
          // 查验任务 from/to 都在查验区：放行只改海关状态，箱不移动
          add(source, { id: `EXC-${move.refId}-stay-${containerId}`, kind: 'release-return',
            refId: move.refId, containerId, voyageId: container.voyageId, blockId: source,
            delta: 0, at: new Date(move.at).toISOString(), cert: move.cert,
            basis: `${move.basis}；查验位与释放后位置同属 ${source}，无区块占用变化`, excluded: true, excludedReason: '同区块放行，占用不变' });
          continue;
        }
        add(source, { id: `C-${move.refId}-release-out-${containerId}`, kind: 'rehandle-out', refId: move.refId,
          containerId, voyageId: container.voyageId, blockId: source, delta: -1,
          at: new Date(move.at).toISOString(), cert: 'estimated', basis: `查验放行离开 ${source}` });
        add(target, { id: `C-${move.refId}-release-in-${containerId}`, kind: 'release-return', refId: move.refId,
          containerId, voyageId: container.voyageId, blockId: target, delta: 1,
          at: new Date(move.at).toISOString(), cert: 'estimated', basis: `${move.basis}，回到 ${target}` });
        currentBlock = target;
      } else {
        // 离场：rehandle-out 以任务 from 为准，其余按当前推断位置
        let source: string | undefined;
        if (move.kind === 'rehandle-out') {
          const task = snap.tasks.find(t => t.id === move.refId);
          source = blockOfSlot(task?.from) ?? currentBlock;
        } else source = currentBlock;
        if (!source) continue;
        add(source, { id: `C-${move.refId}-${move.kind}-${containerId}`, kind: move.kind, refId: move.refId,
          containerId, voyageId: container.voyageId, blockId: source, delta: -1,
          at: new Date(move.at).toISOString(), cert: move.cert, basis: move.basis });
        if (move.kind !== 'rehandle-out') currentBlock = undefined;
      }
    }

    // 被规则排除的事件（取消、海关拦截）保留用于溯源
    for (const move of kept.filter(m => m.at === 0)) {
      add(blockOfSlot(container.yardSlot) ?? 'UNKNOWN', {
        id: `EXC-${move.refId}-${move.kind}-${containerId}`, kind: move.kind, refId: move.refId,
        containerId, voyageId: container.voyageId, blockId: blockOfSlot(container.yardSlot) ?? 'UNKNOWN',
        delta: 0, at: new Date(snap.now).toISOString(), cert: 'firm', basis: move.basis,
        excluded: true, excludedReason: move.basis
      });
    }
    for (const d of dropped) {
      add(blockOfSlot(container.yardSlot) ?? 'UNKNOWN', {
        id: `DUP-${d.move.refId}-${d.move.kind}-${containerId}`, kind: d.move.kind, refId: d.move.refId,
        containerId, voyageId: container.voyageId, blockId: blockOfSlot(container.yardSlot) ?? 'UNKNOWN',
        delta: 0, at: new Date(d.move.at).toISOString(), cert: d.move.cert,
        basis: `${d.move.basis}；与 ${d.winnerId} 描述同一物理移动`, excluded: true,
        excludedReason: `重复事件：保留 ${d.winnerId}`, duplicateOf: d.winnerId
      });
    }
  }

  // ---- 航次批量事件 ----
  const countKind = (kind: ContributionKind) => {
    const tally = new Map<string, number>();
    for (const list of perBlock.values()) {
      for (const c of list) {
        if (c.excluded || !c.voyageId || c.kind !== kind) continue;
        tally.set(c.voyageId, (tally.get(c.voyageId) ?? 0) + (c.delta > 0 ? 1 : c.delta < 0 ? 1 : 0));
      }
    }
    return tally;
  };
  const namedDischarge = countKind('discharge');
  const namedLoad = countKind('load');
  const namedGateIn = countKind('gate-dropoff');

  const batchContribs: ForecastContribution[] = [];
  const pushBatch = (blockId: string, c: ForecastContribution) => {
    batchContribs.push(c);
    add(blockId, c);
  };

  for (const voyage of voyages) {
    if (voyage.status === 'departed') continue;
    const eta = new Date(voyage.eta).getTime();
    const etd = new Date(voyage.etd).getTime();

    // 卸船批量
    const remainDischarge = Math.max(0, voyage.plannedDischarge - voyage.doneDischarge - (namedDischarge.get(voyage.id) ?? 0));
    if (remainDischarge > 0 && eta < horizonEnd) {
      const durHours = remainDischarge / voyage.dischargeRatePerHour;
      const start = Math.max(snap.now, eta);
      const end = Math.min(horizonEnd, start + durHours * 3600000);
      if (end > start) {
        const inWindow = Math.round(remainDischarge * ((end - start) / (durHours * 3600000)));
        const alloc = largestRemainder(inWindow, DISCHARGE_SHARE);
        const basis = `${voyage.vessel} 剩余卸船 ${remainDischarge}（计划 ${voyage.plannedDischarge} - 已卸 ${voyage.doneDischarge} - 具名 ${namedDischarge.get(voyage.id) ?? 0}），按 ${voyage.dischargeRatePerHour} 箱/时摊分；无历史样本，按计划速率估计`;
        for (const [blockId, count] of Object.entries(alloc)) {
          for (let i = 0; i < count; i++) {
            const t = start + ((i + 0.5) / count) * (end - start);
            pushBatch(blockId, { id: `B-DCH-${voyage.id}-${blockId}-${i}`, kind: 'voyage-discharge', refId: voyage.id,
              voyageId: voyage.id, blockId, delta: 1, at: new Date(t).toISOString(), cert: 'estimated', basis });
          }
        }
      }
    }

    // 出口集港批量：装船开始前匀速到场
    const stagedNamed = snap.containers.filter(c => c.voyageId === voyage.id && c.direction === 'export' &&
      (c.status === 'in-yard' || c.status === 'at-gate')).length;
    const remainGateIn = Math.max(0, voyage.plannedLoad - voyage.doneLoad - stagedNamed);
    if (remainGateIn > 0 && etd > snap.now) {
      const loadHours = (voyage.plannedLoad - voyage.doneLoad) / voyage.loadRatePerHour;
      const loadStart = Math.max(snap.now, etd - loadHours * 3600000);
      const start = Math.max(snap.now, eta);
      const end = Math.min(horizonEnd, loadStart);
      if (end > start) {
        const windowHours = (end - start) / 3600000;
        const inWindow = Math.min(remainGateIn, Math.round(windowHours * voyage.loadRatePerHour));
        const alloc = largestRemainder(inWindow, GATEIN_SHARE);
        const basis = `${voyage.vessel} 待集港出口箱约 ${remainGateIn}（计划装 ${voyage.plannedLoad} - 已装 ${voyage.doneLoad} - 已在区 ${stagedNamed} - 具名预约 ${namedGateIn.get(voyage.id) ?? 0}），按 ${voyage.loadRatePerHour} 箱/时在装船前匀速集港估计；无历史样本`;
        for (const [blockId, count] of Object.entries(alloc)) {
          for (let i = 0; i < count; i++) {
            const t = start + ((i + 0.5) / count) * (end - start);
            pushBatch(blockId, { id: `B-GIN-${voyage.id}-${blockId}-${i}`, kind: 'export-gatein', refId: voyage.id,
              voyageId: voyage.id, blockId, delta: 1, at: new Date(t).toISOString(), cert: 'estimated', basis });
          }
        }
        if (inWindow < remainGateIn) notes.push(`${voyage.id} 约 ${remainGateIn - inWindow} 箱集港发生在预测窗口之外或装船开始之后，未计入本版曲线`);
      }
    }

    // 装船批量（离场，逐桶受存量钳制）
    const remainLoad = voyage.plannedLoad - voyage.doneLoad;
    if (remainLoad > 0) {
      const loadHours = remainLoad / voyage.loadRatePerHour;
      const start = Math.max(snap.now, etd - loadHours * 3600000);
      const end = Math.min(horizonEnd, etd);
      if (end > start) {
        const inWindow = Math.round(remainLoad * ((end - start) / (loadHours * 3600000)));
        const alloc = largestRemainder(inWindow, LOAD_SHARE);
        const basis = `${voyage.vessel} 计划装船速率 ${voyage.loadRatePerHour} 箱/时；批量离场以区块实际存量为上限，装不上的计入未集港缺口`;
        for (const [blockId, count] of Object.entries(alloc)) {
          for (let i = 0; i < count; i++) {
            const t = start + ((i + 0.5) / count) * (end - start);
            pushBatch(blockId, { id: `B-LOAD-${voyage.id}-${blockId}-${i}`, kind: 'voyage-load', refId: voyage.id,
              voyageId: voyage.id, blockId, delta: -1, at: new Date(t).toISOString(), cert: 'estimated', basis });
          }
        }
      }
    }
  }

  // ---- 分流动作：把指定批量贡献迁移到目标区块 ----
  for (const d of snap.diversions) {
    for (const list of perBlock.values()) {
      const candidates = list.filter(c => !c.excluded && c.kind === d.kind && c.voyageId === d.voyageId &&
        c.blockId !== d.toBlockId && !c.movedByAction)
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .slice(0, d.count);
      if (!candidates.length) continue;
      for (const c of candidates) {
        c.movedByAction = `divert:${d.count}→${d.toBlockId}`;
        c.basis = `${c.basis}；场景动作分流至 ${d.toBlockId}`;
        c.blockId = d.toBlockId;
        c.id = `${c.id}-DIV`;
        const targetList = perBlock.get(d.toBlockId) ?? [];
        targetList.push(c); perBlock.set(d.toBlockId, targetList);
        const idx = list.indexOf(c);
        if (idx >= 0) list.splice(idx, 1);
      }
      break;
    }
  }

  // ---- 逐区块逐桶投影 ----
  const resultBlocks: BlockForecast[] = [];
  for (const block of snap.blocks) {
    const blockNotes: string[] = [];
    let contribs = (perBlock.get(block.id) ?? []).slice();
    if (!snap.includeEstimated) contribs = contribs.filter(c => c.cert === 'firm' || c.excluded);

    const deltas = Array.from({ length: bucketCount }, () => ({ inFirm: 0, inEst: 0, out: 0 }));
    const deferred: ForecastContribution[] = [];
    const spikeBuckets = new Set<number>();
    const bucketStartAt = (i: number) => snap.now + i * snap.bucketMinutes * 60000;
    // 桶是否封闭按桶中点判定；解封桶 = 封闭结束后第一个非封闭桶
    const bucketClosed = (i: number) => Boolean(closureAt(snap, block.id, bucketStartAt(i) + snap.bucketMinutes * 30000));
    const reopenBucketAfter = (closureId: string) => {
      const closure = snap.closures.find(c => c.id === closureId)!;
      const end = new Date(closure.endAt).getTime();
      let i = Math.floor((end - snap.now) / (snap.bucketMinutes * 60000));
      i = Math.max(0, Math.min(bucketCount - 1, i));
      while (i < bucketCount && bucketClosed(i)) i += 1;
      return i;
    };

    for (const c of contribs) {
      if (c.excluded) continue;
      const time = new Date(c.at).getTime();
      if (!inHorizon(snap, time)) continue;
      let idx = Math.floor((time - snap.now) / (snap.bucketMinutes * 60000));
      idx = Math.max(0, Math.min(bucketCount - 1, idx));
      const closed = closureAt(snap, block.id, time);
      if (closed && c.delta > 0 && bucketClosed(idx)) {
        const reopen = new Date(closed.endAt).getTime();
        if (reopen < horizonEnd) {
          const target = reopenBucketAfter(closed.id);
          c.at = new Date(bucketStartAt(target)).toISOString();
          c.basis = `${c.basis}；区块封闭，顺延至解封进入`;
          c.movedByAction = c.movedByAction ? `${c.movedByAction}+closure:${closed.id}` : `closure:${closed.id}`;
          deferred.push(c);
          spikeBuckets.add(target);
          if (!blockNotes.some(n => n.includes(closed.id))) {
            blockNotes.push(`${closed.reason}（${closed.id}）：进场流量顺延至 ${new Date(bucketStartAt(target)).toLocaleString()} 所在时间桶，解封时刻出现积压尖峰`);
          }
          continue;
        }
        blockNotes.push('封闭窗口超出预测范围，部分进场流量未计入');
        continue;
      }
      const bucket = deltas[idx];
      if (c.delta > 0) {
        if (c.cert === 'firm') bucket.inFirm += c.delta; else bucket.inEst += c.delta;
      } else bucket.out += -c.delta;
    }
    for (const c of deferred) {
      const time = new Date(c.at).getTime();
      let idx = Math.floor((time - snap.now) / (snap.bucketMinutes * 60000));
      idx = Math.max(0, Math.min(bucketCount - 1, idx));
      const bucket = deltas[idx];
      if (c.cert === 'firm') bucket.inFirm += 1; else bucket.inEst += 1;
    }

    // 封闭开始时的冻结占用量（只出不进，容量上限冻结）
    const freezeOccupancyAt = (time: number) => {
      let occ = block.occupied;
      for (const c of contribs) {
        if (c.excluded || c.delta >= 0) continue;
        if (new Date(c.at).getTime() <= time) occ += c.delta;
      }
      return Math.max(0, occ);
    };

    const buckets: ForecastBucket[] = [];
    let occupied = block.occupied;
    let peak = occupied; let peakAt = new Date(snap.now).toISOString();
    let criticalAt: string | undefined; let warningAt: string | undefined;
    let closureSpikeAt: string | undefined;
    let unmetLoad = 0;
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = snap.now + i * snap.bucketMinutes * 60000;
      const mid = bucketStart + snap.bucketMinutes * 30000;
      const d = deltas[i];
      const closed = Boolean(closureAt(snap, block.id, mid));
      if (spikeBuckets.has(i) && d.inFirm + d.inEst > 0) closureSpikeAt = new Date(bucketStart).toISOString();

      let effectiveCapacity = block.capacity;
      if (closed) {
        const closure = closureAt(snap, block.id, mid)!;
        effectiveCapacity = freezeOccupancyAt(Math.max(new Date(closure.startAt).getTime(), bucketStart));
      }
      const actualOut = Math.min(d.out, occupied);
      unmetLoad += d.out - actualOut;
      occupied = occupied + d.inFirm + d.inEst - actualOut;
      if (occupied > peak) { peak = occupied; peakAt = new Date(bucketStart).toISOString(); }
      if (!warningAt && occupied >= block.capacity * WARN_RATIO) warningAt = new Date(bucketStart).toISOString();
      if (!criticalAt && occupied >= block.capacity) criticalAt = new Date(bucketStart).toISOString();
      buckets.push({
        t: new Date(bucketStart).toISOString(),
        label: new Date(bucketStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        occupied, inflowFirm: d.inFirm, inflowEstimated: d.inEst, outflow: actualOut,
        effectiveCapacity, capacity: block.capacity, closed
      });
    }
    if (unmetLoad > 0) blockNotes.push(`计划装船/提离有 ${unmetLoad} 箱在窗口内找不到在场箱量，存在集港滞后缺口`);
    if (peak > block.capacity) blockNotes.push(`预测峰值 ${peak} 超过容量 ${block.capacity}，溢出 ${peak - block.capacity} 箱`);

    resultBlocks.push({
      blockId: block.id, zone: block.zone, capacity: block.capacity, baseline: block.occupied,
      peak, peakAt, finalOccupied: occupied, criticalAt, warningAt, closureSpikeAt, unmetLoad,
      buckets,
      contributions: contribs.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
      suggestions: [], notes: blockNotes
    });
  }

  const version: ForecastVersion = {
    id: `FCST-${forecastSeq + 1}-${String(Date.now()).slice(-5)}`,
    createdAt: new Date().toISOString(),
    horizonHours: snap.horizonHours, bucketMinutes: snap.bucketMinutes,
    basisTime: new Date(snap.now).toISOString(), supersedes,
    scenario: snap.scenario, active: false, trigger, actions,
    blocks: resultBlocks, methodology: [...methodology, ...notes]
  };
  return version;
}

// ---------------------------------------------------------------------------
// 缓解建议：每个候选动作都在场景快照里重算一遍峰值
// ---------------------------------------------------------------------------

function buildSuggestions(baseSnap: Snapshot, result: BlockForecast): BlockForecast['suggestions'] {
  if (!result.criticalAt && !result.closureSpikeAt && !result.warningAt) return [];
  const suggestions: MitigationSuggestion[] = [];
  const block = baseSnap.blocks.find(b => b.id === result.blockId)!;
  // 用基线场景下各区块的预测峰值估算目标区块的真实接纳余量，避免把箱推向也会溢出的区块
  const baselinePeak = new Map(project(cloneSnapshot(baseSnap), 'simulation').blocks.map(b => [b.blockId, b.peak]));
  const simulatePeak = (action: ScenarioAction) => {
    const s = cloneSnapshot(baseSnap);
    applyAction(s, action);
    const v = project(s, 'simulation', [action]);
    return v.blocks.find(b => b.blockId === result.blockId)!;
  };
  // 候选目标区块：按“基线预测峰值后的余量”排序（危险/冷藏需满足资质）
  const candidateTargets = (hazmat = false, reefer = false) =>
    baseSnap.blocks
      .filter(b => b.id !== block.id && (!hazmat || b.hazmatAllowed) && (!reefer || b.reeferPlugs > b.usedPlugs))
      .map(b => ({ b, headroom: b.capacity - (baselinePeak.get(b.id) ?? b.occupied) }))
      .filter(x => x.headroom > 4)
      .sort((a, c) => c.headroom - a.headroom)
      .map(x => x.b);

  // 1) 具名进场箱提前改堆（逐个箱，目标选择当前空闲最多的区块）
  const inbound = result.contributions.filter(c => !c.excluded && c.delta > 0 && c.containerId && c.cert === 'firm' &&
    (c.kind === 'discharge' || c.kind === 'gate-dropoff' || c.kind === 'rehandle-in' || c.kind === 'release-return'));
  for (const c of inbound.slice(0, 3)) {
    const container = baseSnap.containers.find(x => x.id === c.containerId);
    const alt = candidateTargets(Boolean(container?.hazmatClass), Boolean(container?.reefer))[0];
    if (!alt) continue;
    const r = simulatePeak({ type: 'rehandle', containerId: c.containerId, toBlockId: alt.id, newTime: c.at });
    suggestions.push({
      id: `SG-${block.id}-REH-${c.containerId}`, type: 'rehandle',
      title: `提前改堆 ${c.containerId} → ${alt.id}`,
      detail: `把 ${c.containerId}（${labelOf(c.kind)}）从 ${block.id} 改至 ${alt.zone} 的 ${alt.id}（当前空闲 ${alt.capacity - alt.occupied}）`,
      containerId: c.containerId, toBlockId: alt.id, newTime: c.at,
      projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
      severity: !r.criticalAt ? 'critical' : 'warning'
    });
  }

  // 2) 临界前进场预约改约到峰值后
  const criticalTime = result.criticalAt ? new Date(result.criticalAt).getTime() : Infinity;
  const afterPeak = new Date(new Date(result.peakAt).getTime() + 2 * baseSnap.bucketMinutes * 60000).toISOString();
  const dropoffs = result.contributions.filter(c => !c.excluded && c.delta > 0 && c.kind === 'gate-dropoff' &&
    new Date(c.at).getTime() < criticalTime);
  for (const c of dropoffs.slice(0, 2)) {
    const r = simulatePeak({ type: 'reschedule', refId: c.refId, newTime: afterPeak });
    suggestions.push({
      id: `SG-${block.id}-RS-${c.refId}`, type: 'reschedule',
      title: `预约 ${c.refId} 改约至峰值后`,
      detail: `${c.containerId} 的进场窗口落在临界时间前，改约至 ${new Date(afterPeak).toLocaleTimeString()} 削峰`,
      containerId: c.containerId, refId: c.refId, newTime: afterPeak,
      projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
      severity: !r.criticalAt ? 'critical' : 'warning'
    });
  }

  // 3) 取消不确定的集港预约
  for (const c of result.contributions.filter(x => !x.excluded && x.delta > 0 && x.kind === 'gate-dropoff' && x.cert === 'estimated').slice(0, 1)) {
    const r = simulatePeak({ type: 'cancel', refId: c.refId });
    suggestions.push({
      id: `SG-${block.id}-CX-${c.refId}`, type: 'cancel',
      title: `联系车队并取消预约 ${c.refId}`,
      detail: `${c.containerId} 的集港预约仍为估计口径且与峰值重叠，确认 no-show 后取消并重新放号`,
      containerId: c.containerId, refId: c.refId,
      projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
      severity: !r.criticalAt ? 'critical' : 'warning'
    });
  }

  // 4) 推动查验释放
  const held = baseSnap.containers.filter(c => c.customs !== 'released' && blockOfSlot(c.yardSlot) === block.id);
  for (const c of held.slice(0, 2)) {
    const r = simulatePeak({ type: 'release', containerId: c.id });
    suggestions.push({
      id: `SG-${block.id}-REL-${c.id}`, type: 'release',
      title: `推动查验释放 ${c.id}`,
      detail: `${c.id} 海关状态 ${c.customs}，释放后恢复提箱离场以腾出容量`,
      containerId: c.id,
      projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
      severity: !r.criticalAt ? 'critical' : 'warning'
    });
  }

  // 5) 航次批量分流：按“航次 × 目标区块”组合模拟，优先推荐真正压低峰值的组合
  const overflow = result.peak - result.capacity;
  if (overflow > 0) {
    for (const kind of ['voyage-discharge', 'export-gatein'] as ContributionKind[]) {
      const batch = result.contributions.filter(c => !c.excluded && c.kind === kind);
      const byVoyage = new Map<string, ForecastContribution[]>();
      for (const c of batch) {
        if (!c.voyageId) continue;
        const list = byVoyage.get(c.voyageId) ?? [];
        list.push(c); byVoyage.set(c.voyageId, list);
      }
      for (const [voyageId, items] of byVoyage) {
        // 只考虑在峰值时刻之前已经进入的箱，分流它们才能削到峰值
        const beforePeak = items.filter(c => new Date(c.at).getTime() <= new Date(result.peakAt).getTime()).length;
        if (!beforePeak) continue;
        let remaining = Math.min(overflow + 8, beforePeak);
        for (const alt of candidateTargets()) {
          if (remaining <= 0) break;
          const targetHeadroom = alt.capacity - (baselinePeak.get(alt.id) ?? alt.occupied) - 4;
          const count = Math.min(remaining, targetHeadroom);
          if (count <= 0) continue;
          const r = simulatePeak({ type: 'divert-batch', voyageId, contributionKind: kind, count, toBlockId: alt.id });
          suggestions.push({
            id: `SG-${block.id}-DIV-${kind}-${voyageId}-${alt.id}`, type: 'divert-batch',
            title: `${voyageId} ${labelOf(kind)}分流 ${count} 箱 → ${alt.id}`,
            detail: `把 ${voyageId} 在峰值前到达的 ${labelOf(kind)}（共 ${beforePeak} 箱）切 ${count} 箱到 ${alt.zone} 的 ${alt.id}，给 ${block.id} 削峰`,
            voyageId, contributionKind: kind, count, toBlockId: alt.id,
            projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
            severity: !r.criticalAt ? 'critical' : 'warning'
          });
          remaining -= count;
        }
      }
    }
  }

  // 6) 提前解封（针对解封积压尖峰；即使尖峰本身不超容，也是预警）
  const closure = baseSnap.closures.find(c => c.blockId === block.id);
  if (closure && (result.closureSpikeAt || result.criticalAt)) {
    const reopen = new Date(baseSnap.now + 15 * 60000).toISOString();
    const r = simulatePeak({ type: 'reopen', closureId: closure.id, newTime: reopen });
    suggestions.push({
      id: `SG-${block.id}-REOPEN`, type: 'reopen',
      title: `提前解除 ${block.id} 临时封闭`,
      detail: `${closure.reason}；积压在解封点形成尖峰，提前解封并安排匀速消化`,
      closureId: closure.id, refId: closure.id, newTime: reopen,
      projectedPeak: r.peak, projectedCriticalAt: r.criticalAt, removesCritical: !r.criticalAt,
      severity: result.criticalAt && r.criticalAt ? 'critical' : 'warning'
    });
  }

  return suggestions.sort((a, b) => a.projectedPeak - b.projectedPeak).slice(0, 6);
}

function labelOf(kind: ContributionKind) {
  return {
    discharge: '卸船落场', 'gate-dropoff': '闸口集港', 'rehandle-in': '改堆进入', 'release-return': '查验放行回区',
    pickup: '提箱离场', load: '装船离场', 'rehandle-out': '改堆离开',
    'voyage-discharge': '航次卸船批量', 'export-gatein': '出口集港批量', 'voyage-load': '航次装船批量'
  }[kind];
}

// ---------------------------------------------------------------------------
// 对外服务：运行 / 模拟 / 执行
// ---------------------------------------------------------------------------

export function runForecast(options: ForecastOptions = {}): ForecastVersion {
  const snap = takeSnapshot(options);
  const supersedes = versions.find(v => v.active)?.id;
  const version = project(snap, options.trigger ?? 'manual', undefined, supersedes);
  for (const r of version.blocks) r.suggestions = buildSuggestions(snap, r);
  forecastSeq += 1;
  version.id = `FCST-${forecastSeq}-${String(Date.now()).slice(-5)}`;
  version.createdAt = new Date().toISOString();
  version.active = true;
  for (const v of versions) v.active = false;
  versions.unshift(version);
  if (versions.length > 12) versions.pop();
  recordAudit('FORECAST', 'forecast', version.id, `生成预测版本（${snap.horizonHours}h / ${snap.bucketMinutes}min），替换 ${supersedes ?? '无'}`);
  return version;
}

export function simulateMitigation(actions: ScenarioAction[], options: ForecastOptions = {}): ForecastVersion {
  const snap = takeSnapshot(options);
  const descriptions: string[] = [];
  for (const action of actions) descriptions.push(applyAction(snap, action));
  const version = project(snap, 'simulation', actions);
  version.scenario = `场景模拟：${descriptions.join('；')}`;
  for (const r of version.blocks) r.suggestions = buildSuggestions(snap, r);
  return version;
}

export function executeMitigation(actions: ScenarioAction[]): ForecastVersion {
  const descriptions: string[] = [];
  for (const action of actions) {
    if (action.type === 'rehandle') {
      const container = containers.find(c => c.id === action.containerId);
      const target = blocks.find(b => b.id === action.toBlockId);
      if (!container || !target) throw new Error('箱号或目标区块不存在');
      if (container.hazmatClass && !target.hazmatAllowed) throw new Error('目标区块无危险品隔离资质');
      tasks.unshift({
        id: `TASK-${Date.now()}-${Math.round(Math.random() * 99)}`, kind: 'rehandle', containerId: container.id,
        from: container.yardSlot, to: `${action.toBlockId}-R01-T1`, priority: 90, status: 'queued',
        scheduledAt: action.newTime ?? new Date().toISOString(), blockingReasons: [], estimatedMinutes: 20
      });
      descriptions.push(`改堆 ${container.id} → ${action.toBlockId}`);
    } else if (action.type === 'reschedule') {
      const apt = appointments.find(a => a.id === action.refId);
      const task = tasks.find(t => t.id === action.refId);
      if (!action.newTime) throw new Error('需要新的计划时间');
      if (apt) {
        apt.windowStart = action.newTime;
        apt.windowEnd = new Date(new Date(action.newTime).getTime() + 30 * 60000).toISOString();
        descriptions.push(`改约 ${apt.id}`);
      } else if (task) {
        task.scheduledAt = action.newTime;
        descriptions.push(`改期 ${task.id}`);
      } else throw new Error('未找到要改期的预约或任务');
    } else if (action.type === 'cancel') {
      const apt = appointments.find(a => a.id === action.refId);
      if (!apt) throw new Error('预约不存在');
      apt.status = 'cancelled';
      descriptions.push(`取消预约 ${apt.id}`);
    } else if (action.type === 'release') {
      const container = containers.find(c => c.id === action.containerId);
      if (!container) throw new Error('箱号不存在');
      container.customs = 'released';
      for (const t of tasks.filter(t => t.containerId === container.id && t.kind === 'inspect' && t.status !== 'done')) t.status = 'done';
      descriptions.push(`查验释放 ${container.id}`);
    } else if (action.type === 'divert-batch') {
      descriptions.push(`下达分流指令：${action.voyageId} ${action.count} 箱 → ${action.toBlockId}`);
    } else if (action.type === 'reopen') {
      const closure = closures.find(c => c.id === action.closureId);
      if (!closure) throw new Error('封闭记录不存在');
      closure.endAt = action.newTime ?? new Date().toISOString();
      descriptions.push(`提前解封 ${closure.blockId}`);
    }
  }
  recordAudit('MITIGATE', 'forecast', 'live', `执行缓解动作：${descriptions.join('；')}`);
  return runForecast({ trigger: 'mitigation', scenario: `缓解：${descriptions.join('；')}` });
}
