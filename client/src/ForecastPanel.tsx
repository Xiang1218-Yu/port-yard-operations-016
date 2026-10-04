import { useCallback, useEffect, useMemo, useState } from 'react';

// ---------- API 类型 ----------
type Feasibility = 'confirmed' | 'conditional' | 'infeasible';
type Point = {
  t: string; bucketIndex: number; occupied: number; occupiedPessimistic: number;
  infeasibleIn: number; canceledIn: number; capacity: number;
  utilization: number; utilizationPessimistic: number; status: string;
  inConfident: number; outConfident: number; inConditional: number; outConditional: number; eventKeys: string[];
};
type ForecastEvent = {
  key: string; at: string; blockId: string; originBlockId?: string; delta: 'in' | 'out'; units: number;
  containerId?: string; voyageId?: string; taskId?: string; appointmentId?: string;
  source: string; probability: number; feasibility: Feasibility; infeasibleReason?: string; excluded?: string;
  description: string; mergedFrom?: string[]; assumptions?: string[];
};
type RecommendedAction = {
  id: string; type: string; title: string; rationale: string; blockId: string; targetBlockId?: string;
  containerId?: string; appointmentId?: string; units: number; reliefUnits: number; executeAt: string;
  confidence: number; requiresConfirmation: boolean;
};
type BlockForecast = {
  blockId: string; zone: string; capacity: number; baselineOccupied: number;
  warningAt: number; criticalAt: number; points: Point[]; peak: Point;
  criticalFrom?: string; warningFrom?: string; overflowFrom?: string; maxOverflow: number;
  dataGaps: string[]; assumptions: string[]; events: ForecastEvent[]; recommendations?: RecommendedAction[];
};
type Change = { kind: string; reference: string; description: string; units: number; fromBlock?: string; toBlock?: string };
type ForecastVersion = {
  id: string; createdAt: string; from: string; horizonHours: number; bucketMinutes: number;
  status: 'superseded' | 'current' | 'simulation'; supersedes?: string;
  scenario: { actionId?: string; actionType?: string; label: string };
  blocks: BlockForecast[]; changes: Change[]; globalAssumptions: string[];
};
type Closure = {
  id: string; blockId: string; from: string; to: string;
  entryClosed: boolean; exitClosed: boolean; capacityReduced: number; reason: string;
};

const api = '/api';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

const hm = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pct = (value: number) => `${Math.round(value * 100)}%`;
const SOURCE_LABEL: Record<string, string> = {
  'voyage-discharge': '航次卸船', 'voyage-discharge-batch': '批量卸船（推断）',
  'gate-dropoff': '闸口进场/集港', 'gate-pickup': '提箱离场', 'vessel-load': '装船出口',
  rehandle: '翻箱改堆', 'inspection-release': '查验释放', 'closure-marker': '区块封闭'
};
const TYPE_LABEL: Record<string, string> = {
  'expedite-pickup': '提前提箱', 'reroute-appointment': '预约改道', 'cancel-dropoff': '取消进场',
  'relocate-stock': '翻箱搬出', 'divert-batch': '批量改道', 'close-entry': '封闭入场'
};
const STATUS_LABEL: Record<string, string> = { confirmed: '确认', conditional: '条件', infeasible: '受阻/剔除' };

// ---------- 主组件 ----------

export default function ForecastPanel() {
  const [horizon, setHorizon] = useState(12);
  const [bucket, setBucket] = useState(60);
  const [version, setVersion] = useState<ForecastVersion>();
  const [simVersion, setSimVersion] = useState<ForecastVersion>();
  const [simAction, setSimAction] = useState<{ blockId: string; actionId: string }>();
  const [closures, setClosures] = useState<Closure[]>([]);
  const [selectedBlock, setSelectedBlock] = useState<string>('A01');
  const [expandedBucket, setExpandedBucket] = useState<number | null>(null);
  const [versions, setVersions] = useState<ForecastVersion[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showClosureForm, setShowClosureForm] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  const load = useCallback(async () => {
    const [v, cs, vlist] = await Promise.all([
      request<ForecastVersion>(`/forecast?horizonHours=${horizon}&bucketMinutes=${bucket}`),
      request<Closure[]>('/yard/closures'),
      request<ForecastVersion[]>('/forecast/versions')
    ]);
    setVersion(v); setClosures(cs); setVersions(vlist.slice(0, 8)); setSimVersion(undefined); setSimAction(undefined);
  }, [horizon, bucket]);

  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : '预测服务不可用')); }, [load]);

  const blocks = version?.blocks ?? [];
  const shownBlocks = simVersion?.blocks ?? blocks;
  const selected = shownBlocks.find(b => b.blockId === selectedBlock) ?? shownBlocks[0];
  const baseSelected = blocks.find(b => b.blockId === selectedBlock);

  const runSim = useCallback(async (bf: BlockForecast, action: RecommendedAction) => {
    setBusy(action.id); setError('');
    try {
      const sim = await request<ForecastVersion>('/forecast/simulate', {
        method: 'POST',
        body: JSON.stringify({
          horizonHours: horizon, bucketMinutes: bucket,
          action: {
            type: action.type, blockId: action.blockId, targetBlockId: action.targetBlockId,
            containerId: action.containerId, appointmentId: action.appointmentId, units: action.units
          }
        })
      });
      setSimVersion(sim); setSimAction({ blockId: bf.blockId, actionId: action.id });
      setNotice(`已生成模拟版本 ${sim.id}：${action.title}。确认效果后可在下方正式执行。`);
    } catch (e) { setError(e instanceof Error ? e.message : '模拟失败'); }
    finally { setBusy(''); }
  }, [horizon, bucket]);

  const executeSim = async () => {
    const action = baseSelected?.recommendations?.find(r => r.id === simAction?.actionId);
    if (!action) return;
    setBusy('execute'); setError('');
    try {
      const result = await request<{ version: ForecastVersion; applied: string[] }>('/forecast/actions/execute', {
        method: 'POST',
        body: JSON.stringify({
          type: action.type, blockId: action.blockId, targetBlockId: action.targetBlockId,
          containerId: action.containerId, appointmentId: action.appointmentId, units: action.units
        })
      });
      setNotice(`动作已执行：${result.applied.join('；')}。新版本 ${result.version.id} 已替换当前预测。`);
      await load();
      const [cs, vlist] = await Promise.all([
        request<Closure[]>('/yard/closures'),
        request<ForecastVersion[]>('/forecast/versions')
      ]);
      setClosures(cs); setVersions(vlist.slice(0, 8));
    } catch (e) { setError(e instanceof Error ? e.message : '执行失败'); }
    finally { setBusy(''); }
  };

  const releaseClosure = async (id: string) => {
    setBusy(id);
    try {
      await request(`/yard/closures/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : '解除封闭失败'); }
    finally { setBusy(''); }
  };

  const warningCount = blocks.filter(b => b.criticalFrom || b.overflowFrom).length;
  const overflowCount = blocks.filter(b => b.overflowFrom).length;

  if (!version) return <section className="panel wide forecast-panel"><div className="loading">正在生成容量预测时间序列…{error && <span className="form-error">{error}</span>}</div></section>;

  return <section className="panel wide forecast-panel">
    <div className="panel-head">
      <div>
        <div className="eyebrow">YARD CAPACITY FORECAST / 容量预测与预警</div>
        <h2>未来 {horizon} 小时区块容量预测</h2>
        <span className="muted">事件溯源：航次 ETA/ETD · 箱务方向 · 预约窗口 · 计划任务 · 查验释放 · 临时封闭 · 版本 {version.id}</span>
      </div>
      <div className="forecast-controls">
        <label>窗口
          <select value={horizon} onChange={e => setHorizon(Number(e.target.value))}>
            {[4, 6, 8, 12, 24].map(h => <option key={h} value={h}>{h}h</option>)}
          </select>
        </label>
        <label>桶粒度
          <select value={bucket} onChange={e => setBucket(Number(e.target.value))}>
            {[30, 60, 120].map(m => <option key={m} value={m}>{m}min</option>)}
          </select>
        </label>
        <button className="primary-action" onClick={() => void load()}>重新预测</button>
      </div>
    </div>

    <div className="fc-summary">
      <div className={overflowCount ? 'crit' : warningCount ? 'warn' : 'ok'}>
        <strong>{overflowCount}</strong><span>区块将溢出</span>
      </div>
      <div className={warningCount ? 'warn' : 'ok'}>
        <strong>{warningCount}</strong><span>区块将进入临界（≥{pct(selected?.criticalAt ?? 0.97)}）</span>
      </div>
      <div><strong>{closures.length}</strong><span>生效中的临时封闭</span></div>
      <div className="spacer">
        <button onClick={() => setShowClosureForm(v => !v)}>＋ 登记临时封闭</button>
        <button onClick={() => setShowLedger(v => !v)}>{showLedger ? '隐藏' : '查看'}全局假设</button>
      </div>
    </div>

    {showLedger && <div className="assumptions-box">
      <b>预测口径与冷启动假设</b>
      <ul>{version.globalAssumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
    </div>}

    {notice && <div className="fc-notice" onClick={() => setNotice('')}>{notice} ×</div>}
    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}<button onClick={() => setError('')}>关闭</button></div>}

    {showClosureForm && <ClosureForm blocks={blocks.map(b => ({ id: b.blockId, zone: b.zone }))} onCancel={() => setShowClosureForm(false)} onSaved={async () => { setShowClosureForm(false); await load(); }} />}

    {/* 区块卡片 */}
    <div className="fc-block-grid">
      {shownBlocks.map(bf => {
        const crit = bf.overflowFrom ?? bf.criticalFrom ?? bf.warningFrom;
        const level = bf.overflowFrom ? 'critical' : bf.criticalFrom ? 'critical' : bf.warningFrom ? 'warning' : 'normal';
        return <button key={bf.blockId} className={`fc-block-card ${level} ${selectedBlock === bf.blockId ? 'selected' : ''}`} onClick={() => { setSelectedBlock(bf.blockId); setExpandedBucket(null); }}>
          <div className="fc-card-top"><b>{bf.blockId}</b><span className={`fc-level ${level}`}>{bf.overflowFrom ? '溢出' : bf.criticalFrom ? '临界' : bf.warningFrom ? '预警' : '正常'}</span></div>
          <small>{bf.zone}</small>
          <div className="fc-card-metric"><strong>{bf.peak.occupiedPessimistic}</strong><em>/ {bf.peak.capacity}</em><span>峰值占用（悲观线）</span></div>
          <div className="fc-card-time"><label>临界时间</label><b>{crit ? hm(crit) : '窗口内安全'}</b></div>
          {bf.maxOverflow > 0 && <div className="fc-overflow">最大超容 {bf.maxOverflow} 箱</div>}
          {(bf.recommendations?.length ?? 0) > 0 && <div className="fc-rec-hint">{bf.recommendations!.length} 个建议缓解动作</div>}
        </button>;
      })}
    </div>

    {closures.length > 0 && <div className="closure-list">
      {closures.map(c => <div key={c.id} className="closure-chip">
        <b>{c.blockId}</b><span>{hm(c.from)}–{hm(c.to)}</span>
        <em>{c.entryClosed ? '禁入' : ''}{c.exitClosed ? '禁出' : ''}{c.capacityReduced ? ` 容量-${c.capacityReduced}` : ''}</em>
        <small>{c.reason}</small>
        <button disabled={Boolean(busy)} onClick={() => void releaseClosure(c.id)}>解除</button>
      </div>)}
    </div>}

    {/* 选定区块明细 */}
    {selected && <BlockDetail
      key={selected.blockId + (simVersion?.id ?? version.id)}
      bf={selected}
      baseline={baseSelected}
      isSim={Boolean(simVersion)}
      simActionId={simAction?.actionId}
      expandedBucket={expandedBucket}
      setExpandedBucket={setExpandedBucket}
      onSim={runSim}
      onExecute={executeSim}
      onDiscardSim={() => { setSimVersion(undefined); setSimAction(undefined); }}
      busy={busy}
    />}

    {/* 版本列表 */}
    <div className="fc-versions">
      <div className="eyebrow">FORECAST VERSIONS / 预测版本替换</div>
      <div className="table"><div className="tr th"><span>版本</span><span>状态</span><span>场景</span><span>生成时间</span><span>替换</span></div>
        {versions.map(v => <div className="tr" key={v.id}>
          <span><b>{v.id}</b></span>
          <span><span className={`pill ${v.status}`}>{v.status === 'current' ? '当前' : v.status === 'simulation' ? '模拟' : '已替换'}</span></span>
          <span>{v.scenario.label}</span>
          <span>{new Date(v.createdAt).toLocaleTimeString()}</span>
          <span>{v.supersedes ?? '—'}</span>
        </div>)}
      </div>
    </div>
  </section>;
}

// ---------- 区块明细：时间序列 + 贡献台账 + 动作 ----------

function BlockDetail(props: {
  bf: BlockForecast; baseline?: BlockForecast; isSim: boolean; simActionId?: string;
  expandedBucket: number | null; setExpandedBucket: (i: number | null) => void;
  onSim: (bf: BlockForecast, action: RecommendedAction) => void; onExecute: () => void;
  onDiscardSim: () => void; busy: string;
}) {
  const { bf, baseline, isSim, simActionId, expandedBucket, setExpandedBucket, onSim, onExecute, onDiscardSim, busy } = props;
  const max = useMemo(() => Math.max(bf.capacity, ...bf.points.map(p => Math.max(p.occupiedPessimistic, p.occupied))) * 1.08, [bf]);
  const toY = (n: number) => 74 - (n / max) * 64;
  const points = bf.points;
  const lineMain = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${18 + i * (64 / Math.max(1, points.length - 1))},${toY(p.occupied)}`).join(' ');
  const linePess = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${18 + i * (64 / Math.max(1, points.length - 1))},${toY(p.occupiedPessimistic)}`).join(' ');
  const capY = toY(bf.capacity);
  const warnY = toY(bf.capacity * bf.warningAt);
  const critY = toY(bf.capacity * bf.criticalAt);
  const tickEvery = Math.max(1, Math.ceil(points.length / 8));
  const eventsByKey = useMemo(() => new Map(bf.events.map(e => [e.key, e])), [bf]);

  const peakDelta = baseline ? bf.peak.occupiedPessimistic - baseline.peak.occupiedPessimistic : 0;
  const expandedEvents = expandedBucket != null
    ? points[expandedBucket].eventKeys.map(k => eventsByKey.get(k)).filter((e): e is ForecastEvent => Boolean(e))
    : [];

  return <div className="fc-detail">
    <div className="fc-detail-head">
      <div>
        <h3>{bf.blockId} · {bf.zone}</h3>
        <span className="muted">基线 {bf.baselineOccupied}/{bf.capacity}（{pct(bf.baselineOccupied / bf.capacity)}）· 预警线 {pct(bf.warningAt)} · 临界线 {pct(bf.criticalAt)}</span>
      </div>
      {isSim && <div className="fc-sim-badge">WHAT-IF 模拟结果{peakDelta !== 0 && <em>（峰值 {peakDelta < 0 ? '下降' : '上升'} {Math.abs(peakDelta)}）</em>}</div>}
    </div>

    {/* SVG 时间序列 */}
    <div className="fc-chart-wrap">
      <svg viewBox="0 0 82 86" preserveAspectRatio="none" className="fc-chart">
        <line x1="14" y1={capY} x2="82" y2={capY} className="cap-line" />
        <line x1="14" y1={warnY} x2="82" y2={warnY} className="warn-line" />
        <line x1="14" y1={critY} x2="82" y2={critY} className="crit-line" />
        <text x="14.5" y={capY - 1.1} className="grid-label">容量 {bf.capacity}</text>
        <text x="14.5" y={critY - 1.1} className="grid-label crit-text">{pct(bf.criticalAt)}</text>
        <path d={linePess} className="series-pess" />
        <path d={lineMain} className="series-main" />
        {points.map((p, i) => {
          const x = 18 + i * (64 / Math.max(1, points.length - 1));
          return <g key={i} onClick={() => setExpandedBucket(expandedBucket === i ? null : i)} className="chart-hit">
            <rect x={x - 2.2} y="6" width="4.4" height="70" fill="transparent" />
            <circle cx={x} cy={toY(p.occupied)} r={expandedBucket === i ? 1.6 : 0.9} className={`dot-main ${p.status}`} />
            <circle cx={x} cy={toY(p.occupiedPessimistic)} r={0.9} className="dot-pess" />
          </g>;
        })}
      </svg>
      <div className="fc-chart-x">
        {points.map((p, i) => (i % tickEvery === 0 || i === points.length - 1) ? <span key={i}>{hm(p.t)}</span> : <span key={i} />)}
      </div>
      <div className="fc-legend">
        <span><i className="lg-main" />置信主线</span>
        <span><i className="lg-pess" />悲观线（含批量推断）</span>
        <span><i className="lg-warn" />预警 {pct(bf.warningAt)}</span>
        <span><i className="lg-crit" />临界 {pct(bf.criticalAt)}</span>
        <span className="hint">点击图上时间点查看该桶由哪些箱/事件贡献</span>
      </div>
    </div>

    {/* 临界信息 */}
    <div className="fc-critical-grid">
      <div><small>首次预警</small><b className="warning">{bf.warningFrom ? hm(bf.warningFrom) : '—'}</b></div>
      <div><small>临界时间</small><b className="critical">{bf.criticalFrom ? hm(bf.criticalFrom) : '窗口内不临界'}</b></div>
      <div><small>物理溢出</small><b className="critical">{bf.overflowFrom ? `${hm(bf.overflowFrom)} 起，最多 ${bf.maxOverflow} 箱` : '不溢出'}</b></div>
      <div><small>受阻/积压</small><b>{bf.peak.infeasibleIn} 箱进不来 · {bf.peak.canceledIn} 箱已取消/重复</b></div>
    </div>

    {bf.dataGaps.length > 0 && <div className="fc-gaps"><b>数据缺口（冷启动）</b>{bf.dataGaps.map((g, i) => <span key={i}>⚠ {g}</span>)}</div>}

    {/* 桶展开：贡献台账 */}
    {expandedBucket != null && <BucketLedger bf={bf} bucketIndex={expandedBucket} events={expandedEvents} />}

    {/* 缓解动作 */}
    {!isSim && bf.recommendations && bf.recommendations.length > 0 && <div className="fc-actions">
      <div className="eyebrow">RECOMMENDED MITIGATIONS / 建议缓解动作</div>
      {bf.recommendations.map(action => <div className="fc-action" key={action.id}>
        <div className="fc-action-main">
          <span className="fc-action-type">{TYPE_LABEL[action.type] ?? action.type}</span>
          <b>{action.title}</b>
          <small>{action.rationale}</small>
          <small className="muted">预计 {hm(action.executeAt)} 生效 · 临界桶缓解 {action.reliefUnits} 箱 · 把握 {pct(action.confidence)}</small>
        </div>
        <div className="fc-action-btns">
          <button disabled={Boolean(busy)} onClick={() => onSim(bf, action)}>{busy === action.id ? '模拟中…' : '模拟效果'}</button>
        </div>
      </div>)}
    </div>}

    {isSim && simActionId && <div className="fc-apply-bar">
      <span>模拟版本不落台账、不替换当前预测。确认执行后将改写预约/堆位/封闭并生成新版本。</span>
      <div>
        <button onClick={onDiscardSim}>放弃模拟</button>
        <button className="primary-action" disabled={busy === 'execute'} onClick={onExecute}>{busy === 'execute' ? '执行中…' : '确认执行并重新预测'}</button>
      </div>
    </div>}
  </div>;
}

// ---------- 桶贡献台账 ----------

function BucketLedger({ bf, bucketIndex, events }: { bf: BlockForecast; bucketIndex: number; events: ForecastEvent[] }) {
  const point = bf.points[bucketIndex];
  const sorted = [...events].sort((a, z) => +new Date(a.at) - +new Date(z.at));
  return <div className="fc-ledger">
    <div className="fc-ledger-head">
      <b>{hm(point.t)} 桶贡献台账</b>
      <span>主线 {point.occupied} · 悲观 {point.occupiedPessimistic} · 容量 {point.capacity}
        · 进 {point.inConfident}(+{point.inConditional} 条件) · 出 {point.outConfident}(-{point.outConditional} 条件)</span>
    </div>
    {sorted.length === 0 && <div className="muted">该桶没有事件，占用与上一个桶持平。</div>}
    <div className="table ledger-table"><div className="tr th"><span>时间</span><span>事件</span><span>方向/量</span><span>来源</span><span>状态</span><span>追溯</span></div>
      {sorted.map(e => <div className="tr" key={e.key}>
        <span>{hm(e.at)}</span>
        <span><b>{e.description}</b>{e.assumptions?.map((a, i) => <small key={i}>假设：{a}</small>)}
          {e.infeasibleReason && <small className="blocked-text">{e.infeasibleReason}</small>}
          {e.mergedFrom && e.mergedFrom.length > 0 && <small className="dup-text">已合并重复事件：{e.mergedFrom.join(', ')}</small>}
          {e.originBlockId && <small className="reroute-text">封闭改道：原区块 {e.originBlockId}</small>}
        </span>
        <span className={e.delta === 'in' ? 'delta-in' : 'delta-out'}>{e.delta === 'in' ? '+' : '−'}{e.units}</span>
        <span>{SOURCE_LABEL[e.source] ?? e.source}</span>
        <span><span className={`pill feas-${e.feasibility}`}>{STATUS_LABEL[e.feasibility]}</span><small>p={e.probability}</small></span>
        <span className="trace">
          {e.containerId && <small>箱 {e.containerId}</small>}
          {e.voyageId && <small>航次 {e.voyageId}</small>}
          {e.appointmentId && <small>预约 {e.appointmentId}</small>}
          {e.taskId && <small>任务 {e.taskId}</small>}
          {!e.containerId && !e.voyageId && !e.appointmentId && !e.taskId && <small>{e.source === 'closure-marker' ? '封闭记录' : '—'}</small>}
        </span>
      </div>)}
    </div>
  </div>;
}

// ---------- 临时封闭登记表 ----------

function ClosureForm({ blocks, onCancel, onSaved }: { blocks: { id: string; zone: string }[]; onCancel: () => void; onSaved: () => void }) {
  const inH = (h: number) => {
    const d = new Date(Date.now() + h * 3600000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const [blockId, setBlockId] = useState(blocks[0]?.id ?? 'A01');
  const [from, setFrom] = useState(inH(0));
  const [to, setTo] = useState(inH(4));
  const [entryClosed, setEntryClosed] = useState(true);
  const [exitClosed, setExitClosed] = useState(false);
  const [capacityReduced, setCapacityReduced] = useState('0');
  const [reason, setReason] = useState('设备检修临时封闭');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError('');
    try {
      await request('/yard/closures', {
        method: 'POST',
        body: JSON.stringify({
          blockId, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
          entryClosed, exitClosed, capacityReduced: Number(capacityReduced), reason
        })
      });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : '登记失败'); setBusy(false); }
  };

  return <div className="closure-form">
    <div className="form-grid">
      <label>区块<select value={blockId} onChange={e => setBlockId(e.target.value)}>{blocks.map(b => <option key={b.id} value={b.id}>{b.id} · {b.zone}</option>)}</select></label>
      <label>原因<input value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label>开始<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>结束<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label className="check-label"><input type="checkbox" checked={entryClosed} onChange={e => setEntryClosed(e.target.checked)} />禁止入场（后续进场自动改道）</label>
      <label className="check-label"><input type="checkbox" checked={exitClosed} onChange={e => setExitClosed(e.target.checked)} />禁止提离（出场不释放占用）</label>
      <label>临时削减容量（检修占用位）<input type="number" min="0" value={capacityReduced} onChange={e => setCapacityReduced(e.target.value)} /></label>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button onClick={onCancel}>取消</button><button className="primary-action" disabled={busy} onClick={save}>{busy ? '保存中…' : '登记并重新预测'}</button></div>
  </div>;
}
