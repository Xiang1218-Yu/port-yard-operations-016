import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeForecast, createClosure, deleteClosure, executeMitigation, forecastVersions,
  runForecast, simulateMitigation
} from './forecast.js';
import { appointments, blocks, containers, createContainer, createGateAppointment, deleteContainer, editGateAppointment, voyages } from './domain.js';

const H = 12;

test('forecast reconstructs occupancy bucket by bucket from traceable contributions', () => {
  const version = runForecast({ horizonHours: H, bucketMinutes: 30 });
  // 每个桶都必须能用贡献逐桶重放还原（基线 + 逐桶 delta，不能是系数推算）
  for (const block of version.blocks) {
    let occ = block.baseline;
    for (const bucket of block.buckets) {
      const start = new Date(bucket.t).getTime();
      const end = start + 30 * 60000;
      const d = block.contributions
        .filter(c => !c.excluded && new Date(c.at).getTime() >= start && new Date(c.at).getTime() < end)
        .reduce((sum, c) => sum + c.delta, 0);
      const inflow = Math.max(0, d);
      const wantOut = Math.max(0, -d);
      const actualOut = Math.min(wantOut, occ);
      occ = occ + inflow - actualOut;
      assert.equal(bucket.occupied, occ, `${block.blockId} bucket ${bucket.label} 必须由贡献重放得到`);
    }
  }
});

test('cancelled and customs-blocked appointments are excluded, not counted as flow', () => {
  // APT-9003 是 EISU-1288420 的提箱预约（原本计入估计离场）
  editGateAppointment('APT-9003', { status: 'cancelled' });
  const version = runForecast({ horizonHours: H });
  const b07 = version.blocks.find(b => b.blockId === 'B07')!;
  const excluded = b07.contributions.find(c => c.refId === 'APT-9003' && c.excluded);
  assert.ok(excluded, '取消的预约必须保留为可追溯的排除事件');
  assert.match(excluded.excludedReason!, /取消/);
  editGateAppointment('APT-9003', { status: 'booked' });
});

test('appointment and task describing the same physical move are deduplicated', () => {
  const version = runForecast({ horizonHours: H });
  const a01 = version.blocks.find(b => b.blockId === 'A01')!;
  const dup = a01.contributions.find(c => c.refId === 'APT-9002' && c.excluded && c.duplicateOf);
  assert.ok(dup, 'APT-9002 与 TASK-101 描述同一提箱离场，应被标记为重复');
  assert.equal(dup.duplicateOf, 'TASK-101');
});

test('closed blocks freeze capacity and defer inbound flow into a reopen spike', () => {
  const version = runForecast({ horizonHours: H });
  const c03 = version.blocks.find(b => b.blockId === 'C03')!;
  assert.ok(c03.closureSpikeAt, '解封时刻必须识别为积压尖峰');
  assert.ok(c03.buckets.some(b => b.closed), '封闭期内桶必须标记 closed');
  // 封闭期内没有进场，所有非排除进场贡献都不在封闭窗口内落桶
  const closure = createClosure({
    blockId: 'A01', reason: '测试临时封闭', status: 'scheduled',
    startAt: new Date(Date.now() + 30 * 60000).toISOString(),
    endAt: new Date(Date.now() + 90 * 60000).toISOString()
  });
  const v2 = runForecast({ horizonHours: H });
  const a01 = v2.blocks.find(b => b.blockId === 'A01')!;
  const closedBuckets = a01.buckets.filter(b => b.closed);
  assert.ok(closedBuckets.length >= 1);
  for (const b of closedBuckets) assert.equal(b.inflowFirm + b.inflowEstimated, 0, '封闭期只出不进');
  deleteClosure(closure.id);
});

test('forecast versions supersede each other and only one is active', () => {
  const first = runForecast({ horizonHours: H });
  const second = runForecast({ horizonHours: H, scenario: 'rerun' });
  assert.equal(second.supersedes, first.id);
  assert.equal(second.active, true);
  assert.equal(forecastVersions().filter(v => v.active).length, 1);
  assert.equal(activeForecast()?.id, second.id);
});

test('batched voyage events carry explicit no-history basis and estimated certainty', () => {
  const version = runForecast({ horizonHours: H });
  const batches = version.blocks.flatMap(b => b.contributions).filter(c => c.kind === 'voyage-discharge');
  assert.ok(batches.length > 0);
  for (const c of batches.slice(0, 3)) {
    assert.equal(c.cert, 'estimated');
    assert.match(c.basis, /无历史样本/);
    assert.ok(c.refId && voyages.some(v => v.id === c.refId));
  }
});

test('simulated rehandle reroutes named container flow without touching live data', () => {
  const before = appointments.length;
  const simulation = simulateMitigation([
    { type: 'rehandle', containerId: 'OOLU-7734201', toBlockId: 'D05' }
  ], { horizonHours: H });
  const c03 = simulation.blocks.find(b => b.blockId === 'C03')!;
  const d05 = simulation.blocks.find(b => b.blockId === 'D05')!;
  assert.ok(c03.contributions.some(c => c.containerId === 'OOLU-7734201' && c.excluded) ||
    !c03.contributions.some(c => c.containerId === 'OOLU-7734201' && c.delta > 0 && !c.excluded));
  assert.ok(d05.contributions.some(c => c.containerId === 'OOLU-7734201' && c.delta > 0));
  // 模拟不产生真实数据副作用
  assert.equal(appointments.length, before);
  assert.match(simulation.scenario, /场景模拟/);
});

test('executed mitigation lands on live data and replaces the forecast version', () => {
  const previous = activeForecast() ?? runForecast({ horizonHours: H });
  const container = createContainer({
    id: `TEST-FC-${Math.floor(Math.random() * 1e6)}`, voyageId: 'VOY-QF2', size: '20', isoType: '22G1',
    direction: 'export', status: 'in-yard', weightT: 11, reefer: false, customs: 'released',
    priority: 'normal', yardSlot: 'C03-R09-T1'
  });
  const apt = createGateAppointment({
    containerId: container.id, truckNo: 'TEST-FC-1', driver: '测试', type: 'dropoff', lane: 'north',
    windowStart: new Date(Date.now() + 45 * 60000).toISOString(),
    windowEnd: new Date(Date.now() + 75 * 60000).toISOString()
  });
  // 注意：箱已 in-yard，这里再建 dropoff 仅用于验证取消动作；执行取消后该预约必须被排除
  const next = executeMitigation([{ type: 'cancel', refId: apt.id }]);
  assert.equal(next.supersedes, previous.id);
  assert.equal(next.trigger, 'mitigation');
  assert.equal(appointments.find(a => a.id === apt.id)?.status, 'cancelled');
  assert.ok(next.blocks.flatMap(b => b.contributions).some(c => c.refId === apt.id && c.excluded));
  assert.equal(activeForecast()?.id, next.id);
  deleteContainer(container.id);
});

test('release suggestion respects customs state and blocked inspection stays in yard', () => {
  // TGHU-9831204 海关 inspection：没有有效提箱离场，占用 D05
  const version = runForecast({ horizonHours: H });
  const d05 = version.blocks.find(b => b.blockId === 'D05')!;
  assert.ok(!d05.contributions.some(c => c.containerId === 'TGHU-9831204' && c.delta === -1 && !c.excluded),
    '海关未放行的查验箱不能被计为离场');
  const container = containers.find(c => c.id === 'TGHU-9831204')!;
  assert.equal(container.customs, 'inspection');
});
