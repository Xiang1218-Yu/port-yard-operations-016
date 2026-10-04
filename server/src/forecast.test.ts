import test from 'node:test';
import assert from 'node:assert/strict';
import { blockClosures, createBlockClosure, deleteBlockClosure, executeMitigation, runForecast } from './forecast.js';
import { appointments, blocks, containers, editGateAppointment, tasks, updateContainer } from './domain.js';

const inHours = (h: number) => new Date(Date.now() + h * 3600000).toISOString();

test('forecast builds an event-sourced time series with traceable contributions', () => {
  const version = runForecast({ horizonHours: 12, bucketMinutes: 60 });
  assert.equal(version.blocks.length, blocks.length);
  assert.ok(version.id.startsWith('FCST-'));
  const a01 = version.blocks.find(b => b.blockId === 'A01')!;
  assert.equal(a01.points.length, 12);
  assert.equal(a01.points[0].occupied, a01.baselineOccupied - 1, 'MSC 提箱出场应降低主线占用');
  // 每个非零桶都能回溯到事件，每个事件能追溯到箱或航次
  for (const point of a01.points) {
    for (const key of point.eventKeys) {
      const event = a01.events.find(e => e.key === key);
      assert.ok(event, '桶引用的事件必须存在于贡献台账');
      assert.ok(event.containerId || event.voyageId || event.source === 'closure-marker', '事件必须可追溯到箱或航次');
    }
  }
  // 批量推断事件必须显式标注假设，而不是隐藏系数
  const batch = a01.events.find(e => e.source === 'voyage-discharge-batch');
  assert.ok(batch?.assumptions?.some(a => a.includes('无箱级样本')));
  assert.ok(batch!.probability < 0.5, '批量推断只能进悲观线');
});

test('cancelled appointments are removed from demand but kept in the ledger', async () => {
  const apt = appointments.find(a => a.id === 'APT-9001')!;
  editGateAppointment(apt.id, { status: 'cancelled' });
  const version = runForecast({ horizonHours: 12 });
  const target = version.blocks.find(b => b.blockId === 'C03')!;
  const canceled = target.events.find(e => e.appointmentId === 'APT-9001');
  assert.equal(canceled?.units, 0);
  assert.equal(canceled?.feasibility, 'infeasible');
  assert.ok(canceled?.infeasibleReason?.includes('取消'));
  // 取消事件 0 单位：不进任何桶的占用统计
  assert.ok(target.points.every(p => !p.eventKeys.includes(canceled!.key) || target.events.find(e => e.key === canceled!.key)?.units === 0));
  const contributes = target.events.some(e => e.appointmentId === 'APT-9001' && e.units > 0);
  assert.equal(contributes, false, '取消预约不得贡献占用');
  editGateAppointment(apt.id, { status: 'checked-in' });

  // 未来窗口的预约被取消：桶内 canceledIn 必须增加，占用不变
  const { createGateAppointment, deleteGateAppointment } = await import('./domain.js');
  const future = createGateAppointment({
    containerId: 'MSCU-4829017', truckNo: 'TEST-CANCEL', driver: '取消测试', type: 'dropoff',
    windowStart: inHours(2), windowEnd: inHours(2.5), lane: 'north'
  });
  editGateAppointment(future.id, { status: 'cancelled' });
  const v2 = runForecast({ horizonHours: 12 });
  const a01 = v2.blocks.find(b => b.blockId === 'A01')!;
  assert.ok(a01.points.some(p => p.canceledIn >= 1), '未来取消量进入 canceledIn 统计');
  assert.ok(!a01.events.some(e => e.appointmentId === future.id && e.units > 0));
  deleteGateAppointment(future.id);
});

test('rehandle moves one unit out and one unit in, never double counts', () => {
  const version = runForecast({ horizonHours: 12 });
  const d05 = version.blocks.find(b => b.blockId === 'D05')!;
  const b07 = version.blocks.find(b => b.blockId === 'B07')!;
  const intoD05 = d05.events.find(e => e.containerId === 'EISU-1288420' && e.delta === 'in' && e.source === 'rehandle');
  const outB07 = b07.events.find(e => e.containerId === 'EISU-1288420' && e.delta === 'out' && e.source === 'rehandle');
  assert.ok(intoD05, '改堆进入 D05 必须有一条 in 事件');
  assert.ok(outB07, '改堆离开 B07 必须有一条 out 事件');
  // 阻塞的翻箱不能在主线释放占用
  assert.equal(outB07.feasibility, 'infeasible');
});

test('block closure reroutes future entries and keeps outflows from releasing', () => {
  const closure = createBlockClosure({
    blockId: 'C03', from: inHours(1), to: inHours(6),
    entryClosed: false, exitClosed: true, capacityReduced: 0, reason: '测试：封闭提离'
  });
  let version = runForecast({ horizonHours: 12 });
  let c03 = version.blocks.find(b => b.blockId === 'C03')!;
  // FCIU 装船出场落在封闭期内，不能释放占用
  const load = c03.events.find(e => e.containerId === 'FCIU-9920310' && e.delta === 'out' && new Date(e.at) > new Date(closure.from));
  assert.equal(load?.feasibility, 'infeasible');
  assert.ok(c03.events.some(e => e.source === 'closure-marker'));

  // 入场封闭把后续进入改道到其他区块（OOLU 预约早已签到落场，用未来的预约箱 MSCU 验证）
  deleteBlockClosure(closure.id);
  createBlockClosure({ blockId: 'A01', from: inHours(0), to: inHours(8), entryClosed: true, exitClosed: false, capacityReduced: 0, reason: '测试：封闭入场' });
  version = runForecast({ horizonHours: 12 });
  const a01c = version.blocks.find(b => b.blockId === 'A01')!;
  assert.ok(version.changes.some(c => c.kind === 'rerouted' && c.fromBlock === 'A01'));
  // A01 未来的进场事件要么改道、要么不可行，不能仍以可行身份留在 A01
  assert.ok(!a01c.events.some(e => e.delta === 'in' && e.units > 0 && e.feasibility !== 'infeasible' && new Date(e.at) > new Date(version.from)));
  deleteBlockClosure(blockClosures.find(c => c.blockId === 'A01')!.id);
});

test('blocks expose flat baseline points when no events fall in the bucket', () => {
  // 2 分钟窗口内没有任何已排定事件：主线必须严格等于当前 occupied，并给出无样本说明
  const version = runForecast({ horizonHours: 0.034, bucketMinutes: 2 });
  for (const bf of version.blocks) {
    const windowStart = new Date(version.from);
    const windowEnd = new Date(windowStart.getTime() + 120000);
    const hasLive = bf.events.some(e => e.units > 0 && new Date(e.at) > windowStart && new Date(e.at) <= windowEnd);
    if (!hasLive) {
      assert.equal(bf.points[0].occupied, bf.baselineOccupied, '无事件时主线必须等于当前占用');
      assert.ok(bf.dataGaps.some(g => g.includes('没有任何箱级事件样本')));
    }
  }
});

test('forecast versions supersede previous ones and mitigation re-predicts', () => {
  const first = runForecast({ horizonHours: 12 });
  const second = runForecast({ horizonHours: 12 });
  assert.equal(second.status, 'current');
  assert.equal(first.status, 'superseded');
  assert.equal(second.supersedes, first.id);

  const a01 = second.blocks.find(b => b.blockId === 'A01')!;
  const rec = a01.recommendations?.find(r => r.type === 'divert-batch');
  assert.ok(rec, '高水位 A01 必须给出批量改道建议');
  const { version, applied } = executeMitigation({ type: 'divert-batch', blockId: 'A01', targetBlockId: rec!.targetBlockId, units: rec!.units });
  assert.ok(applied.length > 0);
  assert.equal(version.status, 'current');
  assert.ok(version.changes.some(c => c.description.includes('A01') && c.description.includes('峰值')));
  // 台账层面留下了封闭记录与审计动作（由 API 侧 recordAudit 覆盖），这里只验证预测替换
  const after = version.blocks.find(b => b.blockId === 'A01')!;
  assert.ok(after.peak.occupiedPessimistic < a01.peak.occupiedPessimistic);
});

test('what-if simulation never mutates ledger and does not supersede current', () => {
  const baseline = runForecast({ horizonHours: 12 });
  const a01 = baseline.blocks.find(b => b.blockId === 'A01')!;
  const before = containers.length;
  const sim = runForecast({
    horizonHours: 12,
    simulate: { type: 'relocate-stock', blockId: 'A01', containerId: 'MSCU-4829017', targetBlockId: 'C03' }
  });
  assert.equal(sim.status, 'simulation');
  assert.equal(baseline.status, 'current', '模拟不能替换当前版本');
  assert.equal(containers.length, before, '模拟不能改箱台账');
  assert.equal(tasks.filter(t => t.containerId === 'MSCU-4829017' && t.kind === 'rehandle').length, 0, '模拟不能创建任务');
  const sA = sim.blocks.find(b => b.blockId === 'A01')!;
  assert.ok(sA.events.some(e => e.key.startsWith('WHATIF-REL')));
});

test('container re-stack updates yard slot and the old block stops receiving its inflow', () => {
  const c = containers.find(item => item.id === 'OOLU-7734201')!;
  updateContainer(c.id, { yardSlot: 'B07-R06-T1' });
  const version = runForecast({ horizonHours: 12 });
  const b07 = version.blocks.find(b => b.blockId === 'B07')!;
  assert.ok(b07.events.some(e => e.containerId === 'OOLU-7734201' && e.blockId === 'B07'));
  const c03 = version.blocks.find(b => b.blockId === 'C03')!;
  assert.ok(!c03.events.some(e => e.containerId === 'OOLU-7734201'));
  updateContainer(c.id, { yardSlot: 'C03-R06-T1' });
});

test('duplicate same-direction plans for one container count once', () => {
  const version = runForecast({ horizonHours: 12 });
  const a01 = version.blocks.find(b => b.blockId === 'A01')!;
  const pickups = a01.events.filter(e => e.containerId === 'MSCU-4829017' && e.delta === 'out' && e.units > 0);
  assert.equal(pickups.length, 1, '同一箱同方向只能有一条有效出场');
});
