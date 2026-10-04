import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { blockClosures, createBlockClosure, deleteBlockClosure, executeMitigation, forecastVersion, forecastVersions, runForecast } from './forecast.js';
const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));

// ---------- 堆场容量预测与预警 ----------
app.get('/api/forecast', (req, res) => {
  const num = (key: string) => req.query[key] !== undefined ? Number(req.query[key]) : undefined;
  const version = runForecast({
    blockId: req.query.blockId ? String(req.query.blockId) : undefined,
    horizonHours: num('horizonHours'), bucketMinutes: num('bucketMinutes'),
    warningAt: num('warningAt'), criticalAt: num('criticalAt'),
    from: req.query.from ? String(req.query.from) : undefined
  });
  res.json(version);
});
app.post('/api/forecast/simulate', (req, res) => {
  try {
    const { horizonHours, bucketMinutes, blockId, action } = req.body ?? {};
    if (!action?.type || !action.blockId) return res.status(400).json({ message: '模拟动作必须包含 type 和 blockId' });
    res.json(runForecast({ horizonHours, bucketMinutes, blockId, simulate: action }));
  } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '模拟失败' }); }
});
app.post('/api/forecast/actions/execute', (req, res) => {
  try { res.json(executeMitigation(req.body)); }
  catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '动作执行失败' }); }
});
app.get('/api/forecast/versions', (_req, res) => res.json(forecastVersions()));
app.get('/api/forecast/versions/:id', (req, res) => { const item = forecastVersion(req.params.id); if (!item) return res.status(404).json({ message: '预测版本不存在' }); res.json(item); });
app.get('/api/yard/closures', (_req, res) => res.json(blockClosures));
app.post('/api/yard/closures', (req, res) => {
  try { res.status(201).json(createBlockClosure(req.body)); }
  catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '封闭登记失败' }); }
});
app.delete('/api/yard/closures/:id', (req, res) => { const item = deleteBlockClosure(req.params.id); if (!item) return res.status(404).json({ message: '封闭记录不存在' }); res.json({ deleted: true, id: item.id }); });

const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
