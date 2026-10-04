import { useCallback, useEffect, useMemo, useState } from 'react';

type ContributionKind = string;
interface Contribution {
  id: string; kind: ContributionKind; refId: string; containerId?: string; voyageId?: string;
  blockId: string; delta: number; at: string; cert: 'firm' | 'estimated'; basis: string;
  excluded?: boolean; excludedReason?: string; duplicateOf?: string; movedByAction?: string;
}
interface Bucket {
  t: string; label: string; occupied: number; inflowFirm: number; inflowEstimated: number;
  outflow: number; effectiveCapacity: number; capacity: number; closed: boolean;
}
interface Suggestion {
  id: string; type: string; title: string; detail: string;
  containerId?: string; refId?: string; closureId?: string; toBlockId?: string;
  voyageId?: string; contributionKind?: ContributionKind; newTime?: string; count?: number;
  projectedPeak: number; projectedCriticalAt?: string; removesCritical: boolean; severity: 'critical' | 'warning';
}
interface BlockForecast {
  blockId: string; zone: string; capacity: number; baseline: number; peak: number; peakAt: string;
  finalOccupied: number; criticalAt?: string; warningAt?: string; closureSpikeAt?: string;
  unmetLoad: number; buckets: Bucket[]; contributions: Contribution[]; suggestions: Suggestion[]; notes: string[];
}
interface Closure { id: string; blockId: string; reason: string; startAt: string; endAt: string; status: string }
interface ForecastVersion {
  id: string; createdAt: string; horizonHours: number; bucketMinutes: number; basisTime: string;
  supersedes?: string; scenario: string; active: boolean; trigger: string; blocks: BlockForecast[];
  methodology: string[];
}
interface ScenarioAction {
  type: string; containerId?: string; refId?: string; closureId?: string; toBlockId?: string;
  newTime?: string; voyageId?: string; contributionKind?: ContributionKind; count?: number;
}

const KIND_LABEL: Record<string, string> = {
  discharge: '卸船落场', 'gate-dropoff': '闸口集港', 'rehandle-in': '改堆进入', 'release-return': '查验放行回区',
  pickup: '提箱离场', load: '装船离场', 'rehandle-out': '改堆离开',
  'voyage-discharge': '航次卸船批量', 'export-gatein': '出口集港批量', 'voyage-load': '航次装船批量'
};
const KIND_COLOR: Record<string, string> = {
  discharge: '#67d7bc', 'gate-dropoff': '#7cc4f2', 'rehandle-in': '#b69cf0', 'release-return': '#9ad0ff',
  pickup: '#f0a06c', load: '#ef8f8f', 'rehandle-out': '#d98ac0',
  'voyage-discharge': '#3fa98f', 'export-gatein': '#4f97c9', 'voyage-load': '#c96f6f'
};

const hm = (v?: string) => v ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const mdhm = (v?: string) => v ? `${new Date(v).getMonth() + 1}/${new Date(v).getDate()} ${hm(v)}` : '—';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

function suggestionAction(s: Suggestion): ScenarioAction {
  return {
    type: s.type, containerId: s.containerId, refId: s.refId, closureId: s.closureId, toBlockId: s.toBlockId,
    newTime: s.newTime, voyageId: s.voyageId, contributionKind: s.contributionKind, count: s.count
  };
}

function ForecastChart({ base, sim, selectedIdx, onSelect }: {
  base: BlockForecast; sim?: BlockForecast; selectedIdx: number; onSelect: (i: number) => void;
}) {
  const W = 720, H = 210, PAD_L = 44, PAD_R = 12, PAD_T = 14, PAD_B = 26;
  const n = base.buckets.length;
  const simBuckets = sim?.buckets ?? [];
  const yMax = Math.max(base.capacity, base.peak, ...simBuckets.map(b => b.occupied)) * 1.08;
  const x = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => H - PAD_B - (v / yMax) * (H - PAD_T - PAD_B);
  const line = (data: Bucket[]) => data.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b.occupied).toFixed(1)}`).join(' ');
  const area = `${line(base.buckets)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const tickEvery = Math.ceil(n / 12);
  return (
    <svg className="forecast-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75, 1].map(r => (
        <g key={r}>
          <line x1={PAD_L} x2={W - PAD_R} y1={y(base.capacity * r)} y2={y(base.capacity * r)} stroke="#183243" strokeWidth="1" />
          <text x={PAD_L - 6} y={y(base.capacity * r) + 3} textAnchor="end" fontSize="9" fill="#678399">{Math.round(base.capacity * r)}</text>
        </g>
      ))}
      {base.buckets.map((b, i) => b.closed && (
        <rect key={`c-${i}`} x={x(i) - (W - PAD_L - PAD_R) / n / 2} y={PAD_T} width={(W - PAD_L - PAD_R) / n} height={H - PAD_T - PAD_B} fill="#6b5a2333" />
      ))}
      <line x1={PAD_L} x2={W - PAD_R} y1={y(base.capacity)} y2={y(base.capacity)} stroke="#e87e68" strokeWidth="1.4" strokeDasharray="6 4" />
      <line x1={PAD_L} x2={W - PAD_R} y1={y(base.capacity * 0.9)} y2={y(base.capacity * 0.9)} stroke="#e1b14e" strokeWidth="1.2" strokeDasharray="4 4" />
      <path d={area} fill="url(#fcGrad)" opacity="0.35" />
      <defs>
        <linearGradient id="fcGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5bd9c2" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#5bd9c2" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={line(base.buckets)} fill="none" stroke="#5bd9c2" strokeWidth="2" />
      {sim && <path d={line(sim.buckets)} fill="none" stroke="#f0c46e" strokeWidth="2" strokeDasharray="5 3" />}
      {base.warningAt && (() => { const i = base.buckets.findIndex(b => b.t >= base.warningAt!); return i >= 0 ? <circle cx={x(i)} cy={y(base.buckets[i].occupied)} r="4.5" fill="#e1b14e" stroke="#0b1e2d" strokeWidth="1.5" /> : null; })()}
      {base.criticalAt && (() => { const i = base.buckets.findIndex(b => b.t >= base.criticalAt!); return i >= 0 ? <circle cx={x(i)} cy={y(base.buckets[i].occupied)} r="5" fill="#ed7e68" stroke="#0b1e2d" strokeWidth="1.5" /> : null; })()}
      {base.closureSpikeAt && (() => { const i = base.buckets.findIndex(b => b.t >= base.closureSpikeAt!); return i >= 0 ? <polygon points={`${x(i)},${y(base.buckets[i].occupied) - 9} ${x(i) - 5},${y(base.buckets[i].occupied) - 2} ${x(i) + 5},${y(base.buckets[i].occupied) - 2}`} fill="#f0c46e" /> : null; })()}
      <line x1={x(selectedIdx)} x2={x(selectedIdx)} y1={PAD_T} y2={H - PAD_B} stroke="#9fc4d4" strokeWidth="1" strokeDasharray="3 3" />
      {base.buckets.map((_, i) => (
        <rect key={i} x={x(i) - (W - PAD_L - PAD_R) / n / 2} y={PAD_T} width={(W - PAD_L - PAD_R) / n} height={H - PAD_T - PAD_B}
          fill="transparent" onMouseEnter={() => onSelect(i)} onClick={() => onSelect(i)} style={{ cursor: 'pointer' }} />
      ))}
      {base.buckets.map((b, i) => i % tickEvery === 0 && (
        <text key={`t-${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="#7191a2">{b.label}</text>
      ))}
      <text x={W - PAD_R} y={y(base.capacity) - 4} textAnchor="end" fontSize="9" fill="#e87e68">容量上限 {base.capacity}</text>
    </svg>
  );
}

export default function ForecastPanel() {
  const [versions, setVersions] = useState<ForecastVersion[]>([]);
  const [versionId, setVersionId] = useState<string>('');
  const [simulation, setSimulation] = useState<ForecastVersion>();
  const [blockId, setBlockId] = useState('A01');
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [newClosure, setNewClosure] = useState({ blockId: 'A01', reason: '', startAt: '', endAt: '' });

  const toLocalInput = (m: number) => {
    const d = new Date(Date.now() + m * 60000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  const createClosure = async () => {
    if (!newClosure.reason || !newClosure.startAt || !newClosure.endAt) { setError('请填写封闭原因与起止时间'); return; }
    setBusy('closure'); setError('');
    try {
      await request('/yard/closures', { method: 'POST', body: JSON.stringify({
        blockId: newClosure.blockId, reason: newClosure.reason, status: 'scheduled',
        startAt: new Date(newClosure.startAt).toISOString(), endAt: new Date(newClosure.endAt).toISOString()
      }) });
      setNewClosure(c => ({ ...c, reason: '' }));
      await run();
      setClosures(await request<Closure[]>('/yard/closures'));
    } catch (e) { setError(e instanceof Error ? e.message : '封闭登记失败'); } finally { setBusy(''); }
  };

  const removeClosure = async (id: string) => {
    setBusy(id); setError('');
    try {
      await request(`/yard/closures/${id}`, { method: 'DELETE' });
      await run();
      setClosures(await request<Closure[]>('/yard/closures'));
    } catch (e) { setError(e instanceof Error ? e.message : '解除封闭失败'); } finally { setBusy(''); }
  };

  const load = useCallback(async () => {
    const [list, cls] = await Promise.all([
      request<ForecastVersion[]>('/forecast/versions'),
      request<Closure[]>('/yard/closures')
    ]);
    setClosures(cls);
    if (!list.length) {
      const created = await request<ForecastVersion>('/forecast/run', { method: 'POST', body: JSON.stringify({ horizonHours: 12 }) });
      setVersions([created]); setVersionId(created.id);
    } else {
      setVersions(list);
      setVersionId(current => list.some(v => v.id === current) ? current : (list.find(v => v.active)?.id ?? list[0].id));
    }
  }, []);

  useEffect(() => { void load().catch(e => setError(e instanceof Error ? e.message : '预测服务不可用')); }, [load]);

  const version = useMemo(() => versions.find(v => v.id === versionId), [versions, versionId]);
  const shown = simulation ?? version;
  const block = shown?.blocks.find(b => b.blockId === blockId);
  const baseBlock = version?.blocks.find(b => b.blockId === blockId);

  useEffect(() => {
    setSelectedIdx(-1); setSimulation(undefined);
  }, [versionId, blockId]);

  const run = async (body?: unknown) => {
    setBusy('run'); setError('');
    try {
      const v = await request<ForecastVersion>('/forecast/run', { method: 'POST', body: JSON.stringify(body ?? { horizonHours: 12 }) });
      setVersions(current => [v, ...current.filter(x => x.id !== v.id)]); setVersionId(v.id); setSimulation(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : '生成预测失败'); } finally { setBusy(''); }
  };

  const simulate = async (s: Suggestion) => {
    setBusy(s.id); setError('');
    try {
      const v = await request<ForecastVersion>('/forecast/simulate', {
        method: 'POST', body: JSON.stringify({ actions: [suggestionAction(s)], options: { horizonHours: 12 } })
      });
      setSimulation(v);
    } catch (e) { setError(e instanceof Error ? e.message : '场景模拟失败'); } finally { setBusy(''); }
  };

  const execute = async (s: Suggestion) => {
    if (!window.confirm(`确认执行「${s.title}」？动作会写入任务/预约/封闭记录，并生成新的预测版本。`)) return;
    setBusy(s.id); setError('');
    try {
      const v = await request<ForecastVersion>('/forecast/execute', {
        method: 'POST', body: JSON.stringify({ actions: [suggestionAction(s)] })
      });
      setSimulation(undefined);
      const cls = await request<Closure[]>('/yard/closures'); setClosures(cls);
      setVersions(current => [v, ...current.filter(x => x.id !== v.id)]); setVersionId(v.id);
    } catch (e) { setError(e instanceof Error ? e.message : '执行失败'); } finally { setBusy(''); }
  };

  if (!version) return <div className="loading">{error ? `预测服务不可用：${error}` : '正在生成堆场容量预测…'}</div>;
  if (!block || !baseBlock || !shown) return null;

  const idx = selectedIdx >= 0 ? selectedIdx : Math.max(0, block.buckets.findIndex(b => b.t === block.peakAt));
  const bucket = block.buckets[idx];
  const bStart = new Date(bucket.t).getTime();
  const bEnd = bStart + version.bucketMinutes * 60000;
  const bucketContribs = block.contributions
    .filter(c => new Date(c.at).getTime() >= bStart && new Date(c.at).getTime() < bEnd)
    .sort((a, b2) => Number(a.excluded) - Number(b2.excluded) || a.delta - b2.delta);
  const blockClosure = closures.find(c => c.blockId === blockId);

  return (
    <section className="panel wide forecast-panel">
      <div className="panel-head forecast-head">
        <div>
          <div className="eyebrow">YARD CAPACITY FORECAST / 容量预测与预警</div>
          <h2>未来 {version.horizonHours} 小时区块容量时间序列</h2>
          <span className="muted">基准时间 {mdhm(version.basisTime)} · {version.bucketMinutes} 分钟/桶 · 事件驱动投影（非 occupied 系数推算）</span>
        </div>
        <div className="forecast-controls">
          <select value={versionId} onChange={e => { setVersionId(e.target.value); }}>
            {versions.map(v => <option key={v.id} value={v.id}>{v.id} · {new Date(v.createdAt).toLocaleTimeString()} · {v.trigger === 'manual' ? '手动' : v.trigger === 'mitigation' ? '缓解' : '模拟'}{v.active ? ' · 当前' : ''}</option>)}
          </select>
          <button className="primary-action" disabled={busy === 'run'} onClick={() => void run()}>{busy === 'run' ? '计算中…' : '↻ 重新生成预测'}</button>
        </div>
      </div>

      {version.supersedes && <div className="version-chain">版本 {version.id} 替换自 {version.supersedes}；场景：{version.scenario}</div>}
      {simulation && (
        <div className="sim-banner">
          <b>场景模拟（未落库）：</b>{simulation.scenario}
          <button onClick={() => setSimulation(undefined)}>× 返回当前版本</button>
        </div>
      )}
      {error && <div className="form-error">{error}<button onClick={() => setError('')}>关闭</button></div>}

      <div className="forecast-blocks">
        {shown.blocks.map(b => {
          const overflow = b.peak > b.capacity;
          const cls = `fc-block ${b.criticalAt ? 'critical' : b.warningAt ? 'warning' : 'ok'}`;
          return (
            <button key={b.blockId} className={`${cls} ${b.blockId === blockId ? 'selected' : ''}`} onClick={() => setBlockId(b.blockId)}>
              <div><b>{b.blockId}</b><span>{b.zone}</span></div>
              <strong className={overflow ? 'critical' : b.peak >= b.capacity * 0.9 ? 'warning' : 'ok'}>
                {b.peak}<em>/{b.capacity}</em>
              </strong>
              <small>
                {b.criticalAt ? `临界 ${hm(b.criticalAt)}` : b.warningAt ? `预警 ${hm(b.warningAt)}` : '全程安全'}
                {b.closureSpikeAt ? ` · 解封尖峰 ${hm(b.closureSpikeAt)}` : ''}
              </small>
            </button>
          );
        })}
      </div>

      <div className="forecast-metrics">
        <div><small>当前占用</small><b>{block.baseline}</b><span>{Math.round(block.baseline / block.capacity * 100)}% · 容量 {block.capacity}</span></div>
        <div><small>预测峰值</small><b className={block.peak > block.capacity ? 'critical' : block.peak >= block.capacity * 0.9 ? 'warning' : ''}>{block.peak}</b><span>{mdhm(block.peakAt)}</span></div>
        <div><small>90% 预警时间</small><b>{hm(block.warningAt)}</b><span>{block.warningAt ? '剩余 ' + Math.max(0, Math.round((new Date(block.warningAt).getTime() - new Date(version.basisTime).getTime()) / 60000)) + ' 分钟' : '窗口内不触发'}</span></div>
        <div><small>溢出临界时间</small><b className={block.criticalAt ? 'critical' : ''}>{hm(block.criticalAt)}</b><span>{block.criticalAt ? '占用将达到/超过容量' : '窗口内不溢出'}</span></div>
        <div><small>解封积压尖峰</small><b>{hm(block.closureSpikeAt)}</b><span>{blockClosure ? blockClosure.reason : '无封闭计划'}</span></div>
        <div><small>集港/装船缺口</small><b className={block.unmetLoad ? 'warning' : ''}>{block.unmetLoad}</b><span>计划离场但无在场箱量</span></div>
      </div>

      <div className="chart-wrap">
        <div className="chart-legend">
          <span><i style={{ background: '#5bd9c2' }} />占用预测</span>
          {simulation && <span><i style={{ background: '#f0c46e' }} />模拟动作后</span>}
          <span><i style={{ background: '#e1b14e' }} />90% 预警</span>
          <span><i style={{ background: '#ed7e68' }} />溢出临界</span>
          <span><i className="legend-closed" />封闭时段</span>
          <em>悬停/点击曲线查看该时间桶的箱与事件贡献</em>
        </div>
        <ForecastChart base={block} sim={simulation?.blocks.find(b => b.blockId === blockId)} selectedIdx={idx} onSelect={setSelectedIdx} />
      </div>

      {block.notes.length > 0 && <div className="forecast-notes">{block.notes.map((n, i) => <span key={i}>⚠ {n}</span>)}</div>}

      <div className="forecast-cols">
        <div className="fc-col">
          <h3>建议缓解动作 <small>每个数字均为动作执行后的重新预测</small></h3>
          {block.suggestions.length === 0 && <div className="fc-empty">该区块在预测窗口内没有溢出或积压尖峰，无需缓解动作。</div>}
          {block.suggestions.map(s => (
            <div key={s.id} className={`suggestion ${s.removesCritical ? 'fixes' : ''}`}>
              <div className="suggestion-head">
                <span className={`sug-type ${s.severity}`}>{({ rehandle: '改堆', reschedule: '改期', cancel: '取消预约', release: '推动放行', 'divert-batch': '批量分流', reopen: '提前解封' } as Record<string, string>)[s.type]}</span>
                <b>{s.title}</b>
                {s.removesCritical ? <em className="fix-badge">可消除溢出</em> : <em className="soft-badge">缓解 {Math.max(0, block.peak - s.projectedPeak)} 箱</em>}
              </div>
              <p>{s.detail}</p>
              <div className="suggestion-foot">
                <span>峰值 {block.peak} → <b className={s.projectedPeak > block.capacity ? 'warning' : 'ok'}>{s.projectedPeak}</b>{s.projectedCriticalAt ? ` · 仍在 ${hm(s.projectedCriticalAt)} 临界` : ' · 临界解除'}</span>
                <span className="row-actions">
                  <button disabled={Boolean(busy)} onClick={() => void simulate(s)}>{busy === s.id ? '计算中…' : '模拟重预测'}</button>
                  <button className="primary-action" disabled={Boolean(busy)} onClick={() => void execute(s)}>{busy === s.id ? '执行中…' : '执行并出新版'}</button>
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="fc-col">
          <h3>贡献溯源 <small>{bucket.label} 时间桶 · 在场 {bucket.occupied}</small></h3>
          <div className="bucket-flow">
            <span>确定进入 <b className="ok">+{bucket.inflowFirm}</b></span>
            <span>估计进入 <b style={{ color: '#7cc4f2' }}>+{bucket.inflowEstimated}</b></span>
            <span>离场 <b className="warning">−{bucket.outflow}</b></span>
            {bucket.closed && <span className="closed-tag">封闭桶（只出不进）</span>}
          </div>
          {bucketContribs.length === 0 && <div className="fc-empty">该时间桶没有事件贡献，占用全部由历史存量结转。</div>}
          <div className="contrib-list">
            {bucketContribs.map(c => (
              <div key={c.id} className={`contrib ${c.excluded ? 'excluded' : ''} ${c.delta < 0 ? 'out' : c.delta > 0 ? 'in' : ''}`}>
                <div className="contrib-top">
                  <i style={{ background: c.excluded ? '#6e8490' : KIND_COLOR[c.kind] ?? '#8ab' }} />
                  <b>{c.containerId ?? c.voyageId ?? c.refId}</b>
                  <span>{KIND_LABEL[c.kind] ?? c.kind}</span>
                  <strong className={c.delta < 0 ? 'warning' : c.delta > 0 ? 'ok' : ''}>{c.delta > 0 ? `+${c.delta}` : c.delta}</strong>
                  <em className={c.cert === 'firm' ? 'cert-firm' : 'cert-est'}>{c.cert === 'firm' ? '确定' : '估计'}</em>
                </div>
                <p>{c.basis}</p>
                <small>来源 {c.refId} · 计入区块 {c.blockId}{c.duplicateOf ? ` · 重复于 ${c.duplicateOf}` : ''}{c.movedByAction ? ` · 已被动作改写：${c.movedByAction}` : ''}</small>
                {c.excluded && <div className="excluded-reason">不计入预测：{c.excludedReason}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <details className="methodology closure-mgr">
        <summary>区块临时封闭管理（{closures.length} 条）— 封闭期容量冻结、进场顺延至解封</summary>
        <div className="closure-list">
          {closures.map(c => (
            <div key={c.id} className="closure-item">
              <b>{c.blockId}</b><span>{c.reason}</span>
              <em>{mdhm(c.startAt)} → {mdhm(c.endAt)}</em>
              <button disabled={Boolean(busy)} onClick={() => void removeClosure(c.id)}>{busy === c.id ? '解除中…' : '提前解除/删除'}</button>
            </div>
          ))}
          {closures.length === 0 && <div className="fc-empty">当前没有区块封闭计划。</div>}
          <div className="closure-form">
            <select value={newClosure.blockId} onChange={e => setNewClosure(c => ({ ...c, blockId: e.target.value }))}>
              {shown.blocks.map(b => <option key={b.blockId} value={b.blockId}>{b.blockId} · {b.zone}</option>)}
            </select>
            <input placeholder="封闭原因（如轨道检修）" value={newClosure.reason} onChange={e => setNewClosure(c => ({ ...c, reason: e.target.value }))} />
            <label>开始<input type="datetime-local" value={newClosure.startAt || toLocalInput(60)} onChange={e => setNewClosure(c => ({ ...c, startAt: e.target.value }))} /></label>
            <label>结束<input type="datetime-local" value={newClosure.endAt || toLocalInput(180)} onChange={e => setNewClosure(c => ({ ...c, endAt: e.target.value }))} /></label>
            <button className="primary-action" disabled={Boolean(busy)} onClick={() => void createClosure()}>{busy === 'closure' ? '登记中…' : '登记封闭并重预测'}</button>
          </div>
        </div>
      </details>

      <details className="methodology">
        <summary>预测口径与边界情况处理（{version.methodology.length} 条）</summary>
        <ol>{version.methodology.map((m, i) => <li key={i}>{m}</li>)}</ol>
      </details>
    </section>
  );
}
