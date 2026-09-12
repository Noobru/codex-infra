import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { TaskEngine } from '../src/engine.js';
import type { WorkerInput, WorkerResult } from '../src/codex-worker.js';
import { QueueCoordinator } from '../src/queue.js';
import { StateStore, type CreateJobInput, type Job } from '../src/state.js';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() { this.promise = new Promise<T>(resolve => { this.resolve = resolve; }); }
}

/** All fixture state stays under this infrastructure checkout, never a product root. */
class FleetFixture {
  readonly root: string;
  readonly database: string;
  private readonly stores: StateStore[] = [];
  constructor(t: TestContext) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    mkdirSync(parent, { recursive: true });
    this.root = mkdtempSync(path.join(parent, 'fleet-'));
    this.database = path.join(this.root, 'jobs.sqlite');
    t.after(() => {
      for (const store of this.stores) store.close();
      assert.ok(path.resolve(this.root).startsWith(path.resolve(parent) + path.sep + 'fleet-'));
      rmSync(this.root, { recursive: true, force: true });
    });
  }
  track(store: StateStore): StateStore { this.stores.push(store); return store; }
  open(): StateStore { return this.track(new StateStore(this.database)); }
  create(store: StateStore, id: string, overrides: Partial<CreateJobInput> = {}): Job {
    return store.create({ idempotencyKey: id, projectId: id, objective: id,
      profileHash: 'fixture-v1', mode: 'read-only', executionKind: 'checks',
      resourceKey: 'root:/fixture/' + id, ...overrides });
  }
  complete(store: StateStore, id: string): Job {
    store.transition(id, 'validating');
    return store.transition(id, 'completed');
  }
}

/** Controlled completions isolate scheduling/ownership from actual execution checks. */
class ControlledQueueEngine {
  readonly calls: string[] = [];
  readonly cancelled: string[] = [];
  readonly pending = new Map<string, Deferred<Job>>();
  peak = 0;
  constructor(readonly state: StateStore) {}
  async run(id: string): Promise<Job> {
    this.state.claim(id, process.pid, 2, 1);
    this.calls.push(id);
    const completion = new Deferred<Job>();
    this.pending.set(id, completion);
    this.peak = Math.max(this.peak, this.pending.size);
    return completion.promise;
  }
  finish(id: string): void {
    this.state.transition(id, 'validating');
    const completed = this.state.transition(id, 'completed');
    this.pending.get(id)!.resolve(completed);
    this.pending.delete(id);
  }
  async cancel(id: string): Promise<Job> {
    this.cancelled.push(id);
    const cancelled = this.state.transition(id, 'cancelled');
    this.pending.get(id)!.resolve(cancelled);
    this.pending.delete(id);
    return cancelled;
  }
}

test('separate stores enforce global admission and overlapping physical roots across projects', t => {
  const fixture = new FleetFixture(t), first = fixture.open(), peer = fixture.open();
  const parent = fixture.create(first, 'parent', { resourceKey: 'root:/fixture/shared' });
  const child = fixture.create(first, 'child', { resourceKey: 'root:/fixture/shared/subdir' });
  const sibling = fixture.create(first, 'sibling', { resourceKey: 'root:/fixture/shared-other' });
  first.claim(parent.id, process.pid, 2);
  assert.throws(() => peer.claim(child.id, process.pid, 2), /resource already has an active job/);
  assert.equal(peer.claim(sibling.id, process.pid, 2).status, 'running');
  const third = fixture.create(peer, 'third');
  assert.throws(() => first.claim(third.id, process.pid, 2), /Global concurrency/);
  assert.equal(first.get(third.id).attempts, 0);
  fixture.complete(first, parent.id);
  assert.equal(peer.claim(child.id, process.pid, 2).status, 'running');
  fixture.complete(peer, child.id);
  fixture.complete(peer, sibling.id);
  assert.ok(first.list().every(job => job.ownerPid === null));
});

test('two processes share the same global slot limit atomically', { timeout: 10000 }, async t => {
  const fixture = new FleetFixture(t), store = fixture.open();
  const occupied = fixture.create(store, 'occupied');
  store.claim(occupied.id, process.pid, 2);
  const contenders = ['left', 'right'].map(id => fixture.create(store, id));
  const moduleUrl = new URL('../src/state.js', import.meta.url).href;
  const script = `import {StateStore} from ${JSON.stringify(moduleUrl)};
    const state = new StateStore(process.argv[1]);
    process.send('ready');
    process.on('message', () => {
      try { state.claim(process.argv[2], process.pid, 2); process.send('claimed'); }
      catch(error) { process.send(error.message); }
      finally { state.close(); process.disconnect(); }
    });`;
  const children = contenders.map(job => spawn(process.execPath,
    ['--input-type=module', '-e', script, fixture.database, job.id],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  let ready = 0;
  const results = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
    let result = '', stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('message', message => {
      if (message === 'ready') {
        if (++ready === children.length) for (const peer of children) peer.send('claim');
      } else result = String(message);
    });
    child.on('exit', code => code === 0 ? resolve(result) : reject(new Error(stderr)));
  })));
  assert.equal(results.filter(value => value === 'claimed').length, 1);
  assert.equal(results.filter(value => value.includes('Global concurrency')).length, 1);
  assert.equal(store.list().filter(job => job.status === 'running').length, 2);
  for (const job of store.list()) if (job.status === 'running') fixture.complete(store, job.id);
  assert.ok(store.list().every(job => job.ownerPid === null));
});

test('isolated worktrees of one project reserve independent resources', t => {
  const fixture = new FleetFixture(t), store = fixture.open(), peer = fixture.open();
  const request = { projectId: 'same-project', resourceKey: 'root:/fixture/shared', isolatedWorkspace: true };
  const left = fixture.create(store, 'left', request), right = fixture.create(peer, 'right', request);
  assert.notEqual(store.resource(left.id).resourceKey, peer.resource(right.id).resourceKey);
  store.claim(left.id, process.pid, 2);
  assert.equal(peer.nextReady()?.id, right.id);
  assert.equal(peer.claim(right.id, process.pid, 2).status, 'running');
  assert.equal(fixture.create(store, 'left', request).id, left.id);
  fixture.complete(store, left.id); fixture.complete(peer, right.id);
  assert.ok(store.list().every(job => job.ownerPid === null));
});

test('a model slot cap still permits independent checks within the total worker cap', t => {
  const fixture = new FleetFixture(t), store = fixture.open(), peer = fixture.open();
  const model = fixture.create(store, 'model', { executionKind: 'codex' });
  const nextModel = fixture.create(store, 'model-next', { executionKind: 'codex' });
  const checks = fixture.create(store, 'checks');
  store.claim(model.id, process.pid, 2, 1);
  assert.throws(() => peer.claim(nextModel.id, process.pid, 2, 1), /Model concurrency/);
  assert.equal(peer.nextReady({ maxModelWorkers: 1 })?.id, checks.id);
  assert.equal(peer.claim(checks.id, process.pid, 2, 1).status, 'running');
  fixture.complete(store, model.id);
  assert.equal(peer.claim(nextModel.id, process.pid, 2, 1).status, 'running');
  fixture.complete(peer, checks.id); fixture.complete(peer, nextModel.id);
  assert.ok(store.list().every(job => job.ownerPid === null));
});

test('parallel scoped drain honors both dependencies and excludes unrelated queued projects', async t => {
  const fixture = new FleetFixture(t), state = fixture.open(), engine = new ControlledQueueEngine(state);
  const foreign = fixture.create(state, 'unrelated-project');
  const left = fixture.create(state, 'left'), right = fixture.create(state, 'right');
  const join = fixture.create(state, 'join', { dependencyIds: [left.id, right.id] });
  const drain = new QueueCoordinator(engine).drain({ concurrency: 2, maxJobs: 3,
    totalTimeoutMs: 10000, jobIds: [left.id, right.id, join.id] });
  assert.deepEqual(engine.calls, [left.id, right.id]);
  engine.finish(left.id); await setImmediate();
  assert.equal(state.get(join.id).attempts, 0);
  engine.finish(right.id); await setImmediate();
  assert.deepEqual(engine.calls, [left.id, right.id, join.id]);
  engine.finish(join.id);
  const result = await drain;
  assert.equal(result.stopReason, 'max_jobs');
  assert.equal(engine.peak, 2);
  assert.equal(result.jobs.length, 3);
  assert.ok(result.jobs.every(job => job.status === 'completed' && job.ownerPid === null));
  assert.equal(state.get(foreign.id).status, 'ready');
  assert.equal(state.get(foreign.id).attempts, 0);
});

test('abort cancels every parallel worker through TaskEngine and retains owners until shutdown', { timeout: 10000 }, async t => {
  const fixture = new FleetFixture(t);
  const started = new Deferred<void>(), aborted = new Deferred<void>(), release = new Deferred<void>();
  let startedCount = 0, abortedCount = 0;
  const worker = { run: async (input: WorkerInput): Promise<WorkerResult> => {
    if (++startedCount === 2) started.resolve();
    await new Promise<void>(resolve => {
      const stop = () => { if (++abortedCount === 2) aborted.resolve(); resolve(); };
      if (input.signal!.aborted) stop(); else input.signal!.addEventListener('abort', stop, { once: true });
    });
    await release.promise;
    return { status: 'cancelled', summary: 'Controlled fixture worker shutdown confirmed' };
  } };
  await fs.mkdir(path.join(fixture.root, 'profiles'));
  const projects = await Promise.all(['left', 'right', 'foreign'].map(async id => {
    const root = path.join(fixture.root, id); await fs.mkdir(root);
    return { id, name: id, root, status: 'active', stack: ['node'], modes: ['read-only'],
      sourceRoots: [], sources: [], checks: [{ id: 'accept', executable: process.execPath, args: ['--version'], readOnly: true }] };
  }));
  await fs.writeFile(path.join(fixture.root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects }));
  const engine = new TaskEngine(fixture.root, worker), controller = new AbortController();
  fixture.track(engine.state);
  t.after(() => { controller.abort(); release.resolve(); engine.close(); });
  await engine.execution.configure({ maxWorkers: 2, maxModelWorkers: 2 });
  const jobs = [];
  for (const project of ['left', 'right', 'foreign']) jobs.push(await engine.prepare({ project,
    objective: 'Inspect controlled fixture', idempotencyKey: project, mode: 'read-only', kind: 'codex', checkIds: ['accept'] }));
  const scope = jobs.slice(0, 2).map(job => job.id);
  const cancel = engine.cancel.bind(engine), cancelCalls: string[] = [];
  t.mock.method(engine, 'cancel', async (id: string) => { cancelCalls.push(id); return cancel(id); });
  const drain = new QueueCoordinator(engine).drain({ concurrency: 2, maxJobs: 2,
    totalTimeoutMs: 10000, jobIds: scope, signal: controller.signal });
  await started.promise;
  await assert.rejects(engine.execution.configure({ maxWorkers: 1, maxModelWorkers: 1 }), /workers are idle/);
  controller.abort(); await aborted.promise;
  assert.deepEqual(new Set(cancelCalls), new Set(scope));
  assert.ok(scope.every(id => engine.state.get(id).ownerPid === process.pid));
  for (const id of scope) {
    const marker = JSON.parse(await fs.readFile(path.join(engine.artifactDir(id), 'cancel.json'), 'utf8'));
    assert.equal(marker.attempt, 1);
  }
  release.resolve();
  const result = await drain;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.jobs.length, 2);
  assert.ok(result.jobs.every(job => job.status === 'cancelled' && job.ownerPid === null));
  assert.ok(engine.state.list().every(job => job.ownerPid === null));
  assert.equal(engine.state.get(jobs[2]!.id).attempts, 0);
});

test('a losing queue coordinator cannot cancel the attempt claimed by a competing coordinator', { timeout: 10000 }, async t => {
  const fixture = new FleetFixture(t);
  const loserSelected = new Deferred<void>(), releaseLoser = new Deferred<void>();
  const winnerStarted = new Deferred<void>(), releaseWinner = new Deferred<void>();
  let workerSignal: AbortSignal | undefined, workerCalls = 0;
  const worker = { run: async (input: WorkerInput): Promise<WorkerResult> => {
    workerCalls++; workerSignal = input.signal; winnerStarted.resolve();
    await releaseWinner.promise;
    return { status: input.signal?.aborted ? 'cancelled' : 'completed', summary: 'Controlled winning attempt' };
  } };
  await fs.mkdir(path.join(fixture.root, 'profiles'));
  await fs.writeFile(path.join(fixture.root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects: [{
    id: 'fixture', name: 'fixture', root: fixture.root, status: 'active', stack: ['node'], modes: ['read-only'],
    sourceRoots: [], sources: [], checks: [{ id: 'accept', executable: process.execPath, args: ['--version'], readOnly: true }],
  }] }));
  const winner = new TaskEngine(fixture.root, worker), loser = new TaskEngine(fixture.root, worker);
  fixture.track(winner.state); fixture.track(loser.state);
  await winner.execution.configure({ maxWorkers: 2, maxModelWorkers: 1 });
  const job = await winner.prepare({ project: 'fixture', objective: 'Race for the same owned attempt',
    idempotencyKey: 'same-attempt', mode: 'read-only', kind: 'codex', checkIds: ['accept'] });
  const loserRun = loser.run.bind(loser), loserCancel = loser.cancel.bind(loser);
  let losingCancelCalls = 0;
  // Both coordinators select the ready job; hold the loser before its actual claim.
  t.mock.method(loser, 'run', async (...args: Parameters<TaskEngine['run']>) => {
    loserSelected.resolve(); await releaseLoser.promise; return loserRun(...args);
  });
  t.mock.method(loser, 'cancel', async (...args: Parameters<TaskEngine['cancel']>) => {
    losingCancelCalls++; return loserCancel(...args);
  });
  const controller = new AbortController();
  const options = { maxJobs: 1, totalTimeoutMs: 10000, concurrency: 1, jobIds: [job.id] };
  const losingDrain = new QueueCoordinator(loser).drain({ ...options, signal: controller.signal });
  let winningDrain: ReturnType<QueueCoordinator['drain']> | undefined;
  try {
    await loserSelected.promise;
    winningDrain = new QueueCoordinator(winner).drain(options);
    await winnerStarted.promise;
    controller.abort(); releaseLoser.resolve();
    assert.equal((await losingDrain).stopReason, 'aborted');
    assert.equal(losingCancelCalls, 0);
    assert.equal(workerSignal?.aborted, false);
    assert.equal(winner.state.get(job.id).status, 'running');
    assert.equal(winner.state.get(job.id).ownerPid, process.pid);
    assert.equal(winner.state.get(job.id).attempts, 1);
    await assert.rejects(fs.access(path.join(winner.artifactDir(job.id), 'cancel.json')), { code: 'ENOENT' });
    releaseWinner.resolve();
    const result = await winningDrain;
    assert.equal(result.jobs[0]?.status, 'completed');
    assert.equal(result.jobs[0]?.ownerPid, null);
    assert.equal(workerCalls, 1);
  } finally {
    controller.abort(); releaseLoser.resolve(); releaseWinner.resolve();
    await Promise.allSettled([losingDrain, ...(winningDrain ? [winningDrain] : [])]);
  }
});

test('schema two migrates existing jobs, events and dependency edges without resetting state', t => {
  const fixture = new FleetFixture(t), legacy = new DatabaseSync(fixture.database);
  legacy.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, projectId TEXT NOT NULL,
    objective TEXT NOT NULL, mode TEXT NOT NULL, profileHash TEXT NOT NULL, status TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    threadId TEXT, turnId TEXT, result TEXT, error TEXT, ownerPid INTEGER);
    CREATE UNIQUE INDEX one_active_job_per_project ON jobs(projectId) WHERE status IN ('running','validating');
    CREATE TABLE job_events (id INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL REFERENCES jobs(id),
      createdAt TEXT NOT NULL, fromStatus TEXT, toStatus TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX events_by_job ON job_events(jobId,id);
    CREATE TABLE job_dependencies (jobId TEXT NOT NULL REFERENCES jobs(id), dependencyId TEXT NOT NULL REFERENCES jobs(id),
      PRIMARY KEY(jobId,dependencyId), CHECK(jobId<>dependencyId));
    PRAGMA user_version=2;`);
  const insert = legacy.prepare(`INSERT INTO jobs(id,idempotency_key,projectId,objective,mode,profileHash,status,
    createdAt,updatedAt,attempts,threadId,turnId,result,error,ownerPid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('parent', 'parent-key', 'legacy', 'done', 'read-only', 'v2', 'completed', '2026-09-11', '2026-09-12', 2, 'thread', 'turn', 'preserve result', null, null);
  insert.run('child', 'child-key', 'legacy', 'pending', 'read-only', 'v2', 'ready', '2026-09-12', '2026-09-12', 0, null, null, null, null, null);
  legacy.prepare('INSERT INTO job_dependencies VALUES (?,?)').run('child', 'parent');
  legacy.prepare('INSERT INTO job_events(jobId,createdAt,fromStatus,toStatus,detail) VALUES (?,?,?,?,?)')
    .run('parent', '2026-09-12', 'validating', 'completed', JSON.stringify({ action: 'transition' }));
  const originalJobs = legacy.prepare('SELECT * FROM jobs ORDER BY id').all();
  const originalEvents = legacy.prepare('SELECT * FROM job_events').all();
  legacy.close();
  const migrated = fixture.open();
  assert.equal(migrated.list().length, 2);
  assert.deepEqual(migrated.dependencies('child'), ['parent']);
  assert.equal(migrated.nextReady()?.id, 'child');
  assert.deepEqual(migrated.resource('parent'), { resourceKey: 'legacy:legacy', executionKind: 'codex' });
  const raw = new DatabaseSync(fixture.database, { readOnly: true });
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 3);
    const columns = Object.keys(originalJobs[0]!).join(',');
    assert.deepEqual(raw.prepare('SELECT ' + columns + ' FROM jobs ORDER BY id').all(), originalJobs);
    assert.deepEqual(raw.prepare('SELECT * FROM job_events').all(), originalEvents);
  } finally { raw.close(); }
  assert.equal(migrated.claim('child', process.pid, 2, 1).status, 'running');
  fixture.complete(migrated, 'child');
  assert.ok(migrated.list().every(job => job.ownerPid === null));
});
