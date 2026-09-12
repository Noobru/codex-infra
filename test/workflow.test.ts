import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { z } from 'zod';
import { TaskEngine } from '../src/engine.js';
import { WorkflowManager, WorkflowTaskSchema, type WorkflowPlan } from '../src/workflow.js';

type WorkflowTask = z.input<typeof WorkflowTaskSchema>;

/** Small real checks in an owned fixture; no model, product, supervisor or parallel load. */
class WorkflowFixture {
  readonly engine: TaskEngine;
  readonly workflow: WorkflowManager;
  private constructor(readonly root: string) {
    this.engine = new TaskEngine(root);
    this.workflow = new WorkflowManager(this.engine);
  }
  static async create(t: TestContext): Promise<WorkflowFixture> {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'workflow-'));
    const fixture = new WorkflowFixture(root);
    t.after(async () => {
      fixture.engine.close();
      assert.ok(path.resolve(root).startsWith(path.resolve(parent) + path.sep + 'workflow-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, 'profiles'));
    const projects = await Promise.all(['fixture', 'other'].map(async id => {
      const directory = path.join(root, id); await fs.mkdir(directory);
      return { id, name: id, root: directory, status: 'active', stack: ['node'],
        modes: ['read-only', 'workspace-write'], sourceRoots: [], sources: [], checks: [
          { id: 'pass', executable: process.execPath, args: ['-e', "process.stdout.write('fixture-ok')"], readOnly: true },
          { id: 'fail', executable: process.execPath, args: ['-e', "process.stderr.write('controlled-failure');process.exit(3)"], readOnly: true },
        ] };
    }));
    await fs.writeFile(path.join(root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects }));
    return fixture;
  }
  task(check = 'pass', overrides: Partial<WorkflowTask> = {}): WorkflowTask {
    return { project: 'fixture', objective: 'Run a small fixture check', mode: 'read-only',
      kind: 'checks', checkIds: [check], ...overrides };
  }
  job(plan: WorkflowPlan, nodeId: string): string {
    const id = plan.nodes.find(node => node.id === nodeId)?.jobId;
    assert.ok(id, 'Prepared node has a job ID');
    return id;
  }
  async receipt(jobId: string, name: string): Promise<string> {
    const attempt = this.engine.state.get(jobId).attempts;
    return fs.readFile(path.join(this.engine.artifactDir(jobId), 'attempt-' + attempt, name), 'utf8');
  }
}

test('cycles and missing dependencies reject the whole DAG before creating jobs', async t => {
  const f = await WorkflowFixture.create(t);
  await assert.rejects(f.workflow.prepare({ idempotencyKey: 'cycle', objective: 'Invalid cycle', nodes: [
    { id: 'a', dependsOn: ['b'], task: f.task() }, { id: 'b', dependsOn: ['a'], task: f.task() },
  ] }), /dependency cycle/);
  assert.equal(f.engine.state.list().length, 0);
  await assert.rejects(f.workflow.prepare({ idempotencyKey: 'missing', objective: 'Missing parent', nodes: [
    { id: 'a', task: f.task() }, { id: 'b', dependsOn: ['absent'], task: f.task() },
  ] }), /Unknown workflow dependency/);
  assert.equal(f.engine.state.list().length, 0);
  assert.deepEqual(await f.workflow.list(), []);
});

test('prepare is idempotent and a completed dependent records its parent check digest', async t => {
  const f = await WorkflowFixture.create(t);
  const input = { idempotencyKey: 'handoff', objective: 'Validate a real check handoff', nodes: [
    { id: 'consumer', dependsOn: ['producer'], task: f.task() }, { id: 'producer', task: f.task() },
  ] };
  const plan = await f.workflow.prepare(input), repeated = await f.workflow.prepare(input);
  assert.deepEqual(repeated, plan);
  assert.deepEqual(plan.nodes.map(node => node.id), ['producer', 'consumer']);
  assert.equal(f.engine.state.list().length, 2);
  await assert.rejects(f.workflow.prepare({ ...input, objective: 'Different request' }), /different plan/);
  assert.equal(f.engine.state.list().length, 2);
  const result = await f.workflow.run(plan.id, { totalTimeoutMs: 30000, concurrency: 1 });
  assert.equal(result.status, 'completed');
  const producer = f.job(plan, 'producer'), consumer = f.job(plan, 'consumer');
  const checksText = await f.receipt(producer, 'checks.json');
  const checks = JSON.parse(checksText), handoff = JSON.parse(await f.receipt(consumer, 'handoffs.json'));
  assert.equal(checks[0].exitCode, 0);
  assert.match(checks[0].stdout, /fixture-ok/);
  assert.equal(handoff.jobId, consumer);
  assert.equal(handoff.handoffs.length, 1);
  assert.equal(handoff.handoffs[0].jobId, producer);
  assert.equal(handoff.handoffs[0].attempt, 1);
  assert.equal(handoff.handoffs[0].checksSha256, createHash('sha256').update(checksText).digest('hex'));
  assert.deepEqual(handoff.handoffs[0].checks, [{ checkId: 'pass', exitCode: 0 }]);
  assert.match(handoff.scope, /do not expand its authority/);
  assert.ok(f.engine.state.list().every(job => job.status === 'completed' && job.ownerPid === null && job.attempts === 1));
});

test('replan retains completed work, replaces failed descendants and honors revision limits', async t => {
  const f = await WorkflowFixture.create(t);
  const first = await f.workflow.prepare({ idempotencyKey: 'replan', objective: 'Repair a small failed branch', maxRevisions: 2, nodes: [
    { id: 'base', task: f.task() },
    { id: 'repair', dependsOn: ['base'], task: f.task('fail') },
    { id: 'leaf', dependsOn: ['repair'], task: f.task() },
    { id: 'tail', dependsOn: ['leaf'], task: f.task() },
  ] });
  const failed = await f.workflow.run(first.id, { totalTimeoutMs: 30000, concurrency: 1 });
  assert.equal(failed.status, 'blocked');
  const base = f.job(first, 'base'), repair = f.job(first, 'repair'), leaf = f.job(first, 'leaf'), tail = f.job(first, 'tail');
  assert.equal(f.engine.state.get(base).status, 'completed');
  assert.equal(f.engine.state.get(repair).status, 'failed');
  assert.equal(f.engine.state.get(leaf).attempts, 0);
  const failureChecks = JSON.parse(await f.receipt(repair, 'checks.json'));
  assert.equal(failureChecks[0].exitCode, 3);
  const baseReceipt = await f.receipt(base, 'checks.json');
  const next = await f.workflow.replan(first.id, { reason: 'Replace the controlled failing check',
    evidence: f.engine.artifactDir(repair), replacements: [{ nodeId: 'repair', task: f.task() }] });
  assert.equal(next.revision, 2);
  assert.equal(f.job(next, 'base'), base);
  assert.notEqual(f.job(next, 'repair'), repair);
  assert.notEqual(f.job(next, 'leaf'), leaf);
  assert.notEqual(f.job(next, 'tail'), tail);
  assert.deepEqual(new Set(next.replaces?.map(item => item.jobId)), new Set([repair, leaf, tail]));
  assert.equal(f.engine.state.get(repair).status, 'failed');
  assert.equal(f.engine.state.get(leaf).status, 'cancelled');
  assert.equal(f.engine.state.get(tail).status, 'cancelled');
  assert.deepEqual(f.engine.state.dependencies(f.job(next, 'leaf')), [f.job(next, 'repair')]);
  assert.deepEqual(f.engine.state.dependencies(f.job(next, 'tail')), [f.job(next, 'leaf')]);
  const completed = await f.workflow.run(first.id, { totalTimeoutMs: 30000, concurrency: 1 });
  assert.equal(completed.status, 'completed');
  assert.equal(f.engine.state.get(base).attempts, 1);
  assert.equal(await f.receipt(base, 'checks.json'), baseReceipt);
  assert.ok(completed.nodes.every(node => node.job?.status === 'completed' && node.job.ownerPid === null));
  const count = f.engine.state.list().length;
  await assert.rejects(f.workflow.replan(first.id, { reason: 'Beyond explicit revision budget', evidence: 'fixture',
    replacements: [{ nodeId: 'repair', task: f.task() }] }), /revision budget exhausted/);
  assert.equal(f.engine.state.list().length, count);
  assert.equal((await f.workflow.read(first.id)).revision, 2);
});

test('replan refuses another project or broader authority mode before creating jobs', async t => {
  const f = await WorkflowFixture.create(t);
  const plan = await f.workflow.prepare({ idempotencyKey: 'scope', objective: 'Preserve authorized scope',
    nodes: [{ id: 'node', task: f.task() }] });
  for (const task of [f.task('pass', { project: 'other' }), f.task('pass', { mode: 'workspace-write' })]) {
    await assert.rejects(f.workflow.replan(plan.id, { reason: 'Attempted scope expansion', evidence: 'fixture',
      replacements: [{ nodeId: 'node', task }] }), /cannot expand project or authority mode/);
    assert.equal(f.engine.state.list().length, 1);
    assert.equal((await f.workflow.read(plan.id)).revision, 1);
  }
});

test('interrupted replan does not expose jobs from an incomplete revision to the queue', async t => {
  const f = await WorkflowFixture.create(t);
  const plan = await f.workflow.prepare({ idempotencyKey: 'partial-replan', objective: 'Keep incomplete revision non-dispatchable', nodes: [
    { id: 'first', task: f.task() }, { id: 'later', dependsOn: ['first'], task: f.task() },
  ] });
  const originalIds = new Set(plan.nodes.map(node => node.jobId));
  await assert.rejects(f.workflow.replan(plan.id, { reason: 'Controlled preparation failure', evidence: 'Unavailable fixture check', replacements: [
    { nodeId: 'first', task: f.task('pass', { objective: 'Prepare replacement branch' }) },
    { nodeId: 'later', task: f.task('unavailable') },
  ] }), /Unavailable acceptance check/);
  const created = f.engine.state.list().filter(job => !originalIds.has(job.id));
  assert.ok(created.every(job => job.status !== 'ready'),
    'An incomplete replacement revision must not leave new jobs ready for an unscoped drain');
});
