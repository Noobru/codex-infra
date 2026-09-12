import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { QueueCoordinator } from '../src/queue.js';
import { StateStore, type Job, type JobStatus } from '../src/state.js';

function fixture(t: TestContext) {
  const state = new StateStore(':memory:');
  t.after(() => state.close());
  const calls: { id: string; timeout: number }[] = [];
  const create = (key: string, dependencyIds: string[] = []) => state.create({ idempotencyKey: key,
    projectId: 'fixture', objective: key, mode: 'read-only', profileHash: 'v1', dependencyIds });
  const finish = (id: string, status: JobStatus = 'completed'): Job => {
    if (status === 'completed') state.transition(id, 'validating');
    return state.transition(id, status);
  };
  const engine = {
    state,
    run: async (id: string, timeout = 300000): Promise<Job> => {
      calls.push({ id, timeout });
      state.claim(id, process.pid, 1);
      return finish(id);
    },
    cancel: async (id: string): Promise<Job> => state.transition(id, 'cancelled'),
  };
  return { state, calls, create, finish, engine };
}

test('explicit drain respects dependencies and maxJobs without recreating work', async (t) => {
  const { state, calls, create, engine } = fixture(t);
  const first = create('first');
  const dependent = create('dependent', [first.id]);
  const last = create('last');
  const result = await new QueueCoordinator(engine).drain({ maxJobs: 2, totalTimeoutMs: 10000 });
  assert.equal(result.stopReason, 'max_jobs');
  assert.deepEqual(result.jobs.map((job) => job.id), [first.id, dependent.id]);
  assert.deepEqual(calls.map((call) => call.id), [first.id, dependent.id]);
  assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 10000));
  assert.equal(state.get(last.id).status, 'ready');
  assert.equal(state.list().length, 3);
});

test('failed dependency stays blocked and quota stops the remaining queue without retry', async (t) => {
  const { state, create, finish, engine, calls } = fixture(t);
  const prerequisite = create('prerequisite');
  state.claim(prerequisite.id, process.pid);
  finish(prerequisite.id, 'failed');
  const blocked = create('blocked', [prerequisite.id]);
  const quota = create('quota');
  const later = create('later');
  engine.run = async (id, timeout = 300000) => {
    calls.push({ id, timeout });
    state.claim(id, process.pid, 1);
    return finish(id, 'waiting_quota');
  };
  const result = await new QueueCoordinator(engine).drain({ maxJobs: 3, totalTimeoutMs: 10000 });
  assert.equal(result.stopReason, 'waiting_quota');
  assert.deepEqual(calls.map((call) => call.id), [quota.id]);
  assert.equal(state.get(blocked.id).attempts, 0);
  assert.equal(state.get(later.id).attempts, 0);
  assert.equal(state.get(quota.id).attempts, 1);
});

test('deadline with insufficient remaining budget never dispatches a job', async (t) => {
  const { state, create, calls, engine } = fixture(t);
  const job = create('not-started');
  const result = await new QueueCoordinator(engine).drain({ maxJobs: 1, totalTimeoutMs: 1 });
  assert.equal(result.stopReason, 'deadline');
  assert.equal(calls.length, 0);
  assert.equal(state.get(job.id).status, 'ready');
});

test('abort requests canonical cancellation and starts no following job', async (t) => {
  const { state, create, engine } = fixture(t);
  const first = create('first');
  const later = create('later');
  const controller = new AbortController();
  const cancelled: string[] = [];
  let resolveRun: ((job: Job) => void) | undefined;
  engine.run = async (id) => {
    state.claim(id, process.pid, 1);
    const pending = new Promise<Job>((resolve) => { resolveRun = resolve; });
    controller.abort();
    return pending;
  };
  engine.cancel = async (id) => {
    cancelled.push(id);
    const job = state.transition(id, 'cancelled');
    resolveRun!(job);
    return job;
  };
  const result = await new QueueCoordinator(engine).drain({ maxJobs: 2, totalTimeoutMs: 10000, signal: controller.signal });
  assert.equal(result.stopReason, 'aborted');
  assert.deepEqual(cancelled, [first.id]);
  assert.equal(result.jobs[0]?.status, 'cancelled');
  assert.equal(state.get(later.id).attempts, 0);
});

test('total deadline cancels active work through its owner before returning', async (t) => {
  const { state, create, engine } = fixture(t);
  const first = create('first');
  const later = create('later');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveRun: ((job: Job) => void) | undefined;
  engine.run = async (id) => {
    state.claim(id, process.pid, 1);
    return new Promise<Job>((resolve) => { resolveRun = resolve; });
  };
  engine.cancel = async (id) => {
    assert.equal(id, first.id);
    const job = state.transition(id, 'cancelled');
    resolveRun!(job);
    return job;
  };
  const drain = new QueueCoordinator(engine).drain({ maxJobs: 2, totalTimeoutMs: 10000 });
  assert.equal(state.get(first.id).status, 'running');
  t.mock.timers.tick(10000);
  const result = await drain;
  assert.equal(result.stopReason, 'deadline');
  assert.equal(result.jobs[0]?.status, 'cancelled');
  assert.equal(state.get(later.id).attempts, 0);
});
