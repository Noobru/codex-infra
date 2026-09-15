import path from 'node:path';
import { parseArgs } from 'node:util';
import { TaskEngine } from './engine.js';
import { QueueCoordinator } from './queue.js';
import { WorkflowManager } from './workflow.js';
import { SupervisorManager, type SupervisorRecord, type SupervisorRequest } from './supervisor.js';
import { atomicWriteJson, errorMessage, readJson } from './legacy/command-os-utils.js';

let request: SupervisorRequest | undefined;
let current: SupervisorRecord | undefined;
let engine: TaskEngine | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
const controller = new AbortController();
const abort = (): void => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

try {
  const { values } = parseArgs({ options: { root: { type: 'string' }, id: { type: 'string' } } });
  if (!values.root || !values.id) throw new Error('queue-worker requires --root and --id');
  request = await new SupervisorManager(values.root).loadRequest(values.id);
  const startedAt = new Date().toISOString();
  current = { id: request.id, state: 'running', pid: process.pid, createdAt: request.createdAt,
    startedAt, updatedAt: startedAt, finishedAt: null, result: null, error: null };
  await atomicWriteJson(path.join(request.path, 'status.json'), current);
  engine = new TaskEngine(request.root);
  const cancelPath = path.join(request.path, 'cancel.json');
  let polling = false;
  const observeCancellation = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try { if (await readJson(cancelPath, null) !== null) controller.abort(); }
    finally { polling = false; }
  };
  await observeCancellation();
  poll = setInterval(() => { void observeCancellation().catch(() => controller.abort()); }, 250);
  const result = request.mode === 'learning'
    ? await new (await import('./autonomous-learning.js')).AutonomousLearning(request.root).drain({ maxJobs:request.maxJobs,totalTimeoutMs:request.totalTimeoutMs,signal:controller.signal })
    : await new QueueCoordinator(engine).drain({ maxJobs: request.maxJobs,
      totalTimeoutMs: request.totalTimeoutMs, signal: controller.signal, concurrency:request.concurrency,jobIds:request.jobIds,continueIndependent:request.continueIndependent });
  clearInterval(poll);
  if(request.workflowId)await new WorkflowManager(engine).consolidate(request.workflowId,result);
  engine.close(); engine = undefined;
  await atomicWriteJson(path.join(request.path, 'result.json'), result);
  const completed = ['max_jobs', 'no_ready_jobs'].includes(result.stopReason);
  const failed = result.stopReason.startsWith('dispatch_error:') || ['failed', 'running', 'validating'].includes(result.stopReason);
  current = { ...current, state: completed ? 'completed' : failed ? 'failed' : 'stopped',
    updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result };
  await atomicWriteJson(path.join(request.path, 'status.json'), current);
  process.stdout.write(JSON.stringify({ id: request.id, state: current.state, stopReason: result.stopReason, finishedAt: current.finishedAt }) + '\n');
  if (failed) process.exitCode = 1;
} catch (error) {
  if (request && current) {
    current = { ...current, state: 'failed', updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), error: errorMessage(error) };
    await atomicWriteJson(path.join(request.path, 'failure.json'), { capturedAt: current.finishedAt, error: current.error });
    await atomicWriteJson(path.join(request.path, 'status.json'), current);
  }
  process.stderr.write(errorMessage(error) + '\n');
  process.exitCode = 1;
} finally {
  clearInterval(poll);
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
  engine?.close();
}
