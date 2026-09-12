import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { StateStore, type CreateJobInput } from '../src/state.js';

function fixture(t: TestContext): { path: string; store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), 'codexinfra-state-'));
  const path = join(root, 'state.sqlite');
  const store = new StateStore(path);
  t.after(() => {
    store.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\codexinfra-state-') || resolve(root).startsWith(resolve(tmpdir()) + '/codexinfra-state-'));
    rmSync(root, { recursive: true, force: true });
  });
  return { path, store };
}

const input: CreateJobInput = {
  idempotencyKey: 'test-job', projectId: 'fixture-project', objective: 'Read fixture status',
  mode: 'read-only', profileHash: 'profile-v1',
};

test('state and concise events survive reopen; idempotency rejects changed input', (t) => {
  const { path, store } = fixture(t);
  const job = store.create(input);
  assert.equal(store.create(input).id, job.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.events(job.id).length, 1);
  for (const changed of [{ objective: 'Different task' }, { mode: 'workspace-write' as const }, { profileHash: 'profile-v2' }, { projectId: 'another-project' }]) {
    assert.throws(() => store.create({ ...input, ...changed }), /different job request/);
  }
  store.claim(job.id, process.pid);
  store.transition(job.id, 'running', { threadId: 'fixture-thread', turnId: 'fixture-turn' });
  store.transition(job.id, 'validating', { result: 'Fixture evidence recorded' });
  const completed = store.transition(job.id, 'completed');
  assert.equal(completed.ownerPid, null);
  store.close();
  const reopened = new StateStore(path);
  try {
    assert.deepEqual(reopened.get(job.id), completed);
    assert.equal(reopened.create(input).id, job.id);
    assert.equal(reopened.events(job.id).length, 5);
    assert.ok(!JSON.stringify(reopened.events(job.id)).includes('Fixture evidence recorded'));
    assert.throws(() => reopened.transition(job.id, 'ready'), /Illegal job transition/);
  } finally { reopened.close(); }
});

test('claims exclude running and validating jobs of the same project', (t) => {
  const { path, store } = fixture(t);
  const first = store.create(input);
  const second = store.create({ ...input, idempotencyKey: 'second' });
  const other = store.create({ ...input, idempotencyKey: 'other', projectId: 'other-project' });
  const peer = new StateStore(path);
  try {
    assert.equal(store.claim(first.id, process.pid).attempts, 1);
    assert.throws(() => peer.claim(first.id, process.pid), /Cannot claim/);
    assert.throws(() => peer.claim(second.id, process.pid), /active job/);
    assert.equal(peer.claim(other.id, process.pid).status, 'running');
    store.transition(first.id, 'validating');
    assert.throws(() => peer.claim(second.id, process.pid), /active job/);
    store.transition(first.id, 'completed');
    assert.equal(peer.claim(second.id, process.pid).status, 'running');
  } finally { peer.close(); }
});

test('independent processes cannot claim two jobs for one project', async (t) => {
  const { path, store } = fixture(t);
  const first = store.create(input);
  const second = store.create({ ...input, idempotencyKey: 'second' });
  const moduleUrl = new URL('../src/state.js', import.meta.url).href;
  const script = `import { StateStore } from ${JSON.stringify(moduleUrl)};
    const store = new StateStore(process.argv[1]);
    process.send('ready');
    process.on('message', () => {
      try { store.claim(process.argv[2], process.pid); process.send('claimed'); }
      catch (error) { process.send(error.message); }
      finally { store.close(); process.disconnect(); }
    });`;
  const children = [first, second].map((job) => spawn(process.execPath,
    ['--input-type=module', '-e', script, path, job.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  let readyCount = 0;
  const results = await Promise.all(children.map((child) => new Promise<string>((resolveResult, reject) => {
    let result = '';
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('message', (message) => {
      if (message === 'ready') {
        readyCount += 1;
        if (readyCount === children.length) for (const peer of children) peer.send('claim');
      } else result = String(message);
    });
    child.on('exit', (code) => code === 0 ? resolveResult(result) : reject(new Error(stderr)));
  })));
  assert.equal(results.filter((result) => result === 'claimed').length, 1);
  assert.equal(results.filter((result) => result.includes('active job')).length, 1);
  assert.equal(store.list().filter((job) => job.status === 'running').length, 1);
});

test('completion requires validation; retries and cancellation are explicit', (t) => {
  const { store } = fixture(t);
  const job = store.create(input);
  assert.throws(() => store.transition(job.id, 'running'), /Illegal job transition/);
  store.claim(job.id, process.pid);
  assert.throws(() => store.transition(job.id, 'completed'), /Illegal job transition/);
  store.transition(job.id, 'waiting_quota', { error: 'Quota unavailable', threadId: 'fixture-thread' });
  assert.throws(() => store.claim(job.id, process.pid), /Cannot claim/);
  const ready = store.transition(job.id, 'ready');
  assert.equal(ready.error, null);
  assert.equal(ready.threadId, 'fixture-thread');
  assert.equal(store.claim(job.id, process.pid).attempts, 2);
  store.transition(job.id, 'failed', { error: 'Fixture check failed' });
  store.transition(job.id, 'ready');
  assert.equal(store.transition(job.id, 'cancelled').ownerPid, null);
  assert.throws(() => store.transition(job.id, 'ready'), /Illegal job transition/);
  const active = store.create({ ...input, idempotencyKey: 'active' });
  store.claim(active.id, process.pid);
  assert.equal(store.transition(active.id, 'cancelled').status, 'cancelled');
  const waiting = store.create({ ...input, idempotencyKey: 'waiting' });
  store.transition(waiting.id, 'waiting_user');
  assert.equal(store.transition(waiting.id, 'cancelled').status, 'cancelled');
});

test('restart holds orphaned running and validating jobs without replaying user decisions', (t) => {
  const { path, store } = fixture(t);
  const running = store.create(input);
  const validating = store.create({ ...input, idempotencyKey: 'validating', projectId: 'validating-project' });
  const alive = store.create({ ...input, idempotencyKey: 'alive', projectId: 'alive-project' });
  const waiting = store.create({ ...input, idempotencyKey: 'waiting', projectId: 'waiting-project' });
  const quota = store.create({ ...input, idempotencyKey: 'quota', projectId: 'quota-project' });
  store.claim(running.id, 100);
  store.claim(validating.id, 101);
  store.transition(validating.id, 'validating', { result: 'Preserve evidence' });
  store.claim(alive.id, process.pid);
  store.transition(waiting.id, 'waiting_user', { error: 'Need human decision' });
  store.transition(quota.id, 'waiting_quota');
  store.close();
  const reopened = new StateStore(path);
  try {
    const recovered = reopened.reconcile((pid) => pid === process.pid);
    assert.deepEqual(new Set(recovered.map((job) => job.id)), new Set([running.id, validating.id]));
    assert.ok(recovered.every((job) => job.status === 'waiting_user' && job.attempts === 1 && job.ownerPid === null));
    assert.equal(reopened.get(validating.id).result, 'Preserve evidence');
    assert.equal(reopened.get(alive.id).status, 'running');
    assert.equal(reopened.get(waiting.id).error, 'Need human decision');
    assert.equal(reopened.get(quota.id).status, 'waiting_quota');
    assert.deepEqual(reopened.reconcile(() => true), []);
    assert.throws(() => reopened.claim(running.id, process.pid), /Cannot claim/);
    reopened.transition(running.id, 'ready');
    assert.equal(reopened.claim(running.id, process.pid).attempts, 2);
  } finally { reopened.close(); }
});

test('version one database migrates without losing jobs or events', (t) => {
  const { path, store } = fixture(t);
  const original = store.create(input);
  store.transition(original.id, 'waiting_user', { error: 'Preserve decision' });
  const events = store.events(original.id);
  store.close();
  // Version one had exactly these jobs/events and no dependency table.
  const v1 = new DatabaseSync(path);
  v1.exec(`DROP TABLE job_dependencies; DROP INDEX one_active_job_per_resource;
    ALTER TABLE jobs DROP COLUMN resourceKey; ALTER TABLE jobs DROP COLUMN executionKind;
    CREATE UNIQUE INDEX one_active_job_per_project ON jobs(projectId) WHERE status IN ('running','validating');
    PRAGMA user_version = 1;`);
  v1.close();
  const migrated = new StateStore(path);
  try {
    assert.equal(migrated.get(original.id).error, 'Preserve decision');
    assert.deepEqual(migrated.events(original.id), events);
    assert.deepEqual(migrated.dependencies(original.id), []);
    const dependent = migrated.create({ ...input, idempotencyKey: 'dependent', dependencyIds: [original.id] });
    assert.deepEqual(migrated.dependencies(dependent.id), [original.id]);
  } finally { migrated.close(); }
  const raw = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 3); }
  finally { raw.close(); }
});

test('immutable dependencies gate dispatch and form part of idempotency', (t) => {
  const { store } = fixture(t);
  const first = store.create(input);
  const second = store.create({ ...input, idempotencyKey: 'second' });
  const request = { ...input, idempotencyKey: 'dependent', dependencyIds: [first.id, second.id] };
  const dependent = store.create(request);
  assert.equal(store.create({ ...request, dependencyIds: [second.id, first.id] }).id, dependent.id);
  assert.throws(() => store.create({ ...request, dependencyIds: [first.id] }), /different job request/);
  assert.throws(() => store.create({ ...request, dependencyIds: [dependent.id] }), /cannot depend on itself/);
  assert.throws(() => store.create({ ...input, idempotencyKey: 'duplicate', dependencyIds: [first.id, first.id] }), /distinct existing/);
  assert.throws(() => store.create({ ...input, idempotencyKey: 'missing', dependencyIds: ['missing'] }), /Job not found/);
  assert.equal(store.list().length, 3);
  assert.equal(store.nextReady()?.id, first.id);
  assert.throws(() => store.claim(dependent.id, process.pid), /dependency is not completed/);
  store.claim(first.id, process.pid);
  store.transition(first.id, 'validating');
  store.transition(first.id, 'completed');
  store.claim(second.id, process.pid);
  store.transition(second.id, 'failed');
  assert.equal(store.nextReady(), null);
  assert.throws(() => store.claim(dependent.id, process.pid), /dependency is not completed/);
  store.transition(second.id, 'ready');
  store.claim(second.id, process.pid);
  store.transition(second.id, 'validating');
  store.transition(second.id, 'completed');
  assert.equal(store.nextReady()?.id, dependent.id);
  assert.equal(store.claim(dependent.id, process.pid, 1).status, 'running');
});

test('unconfirmed cleanup retains active project locks after reopening even when all owners are absent', (t) => {
  const { path, store } = fixture(t);
  const running = store.create(input);
  const validating = store.create({ ...input, idempotencyKey: 'validating', projectId: 'validating-project' });
  const ordinary = store.create({ ...input, idempotencyKey: 'ordinary', projectId: 'ordinary-project' });
  const queued = store.create({ ...input, idempotencyKey: 'queued' });
  store.claim(running.id, 100);
  store.transition(running.id, 'running', { error: 'Unconfirmed cleanup: worker descendants were not confirmed stopped' });
  store.claim(validating.id, 101);
  store.transition(validating.id, 'validating', { error: 'Unconfirmed cleanup: validation process may remain' });
  store.claim(ordinary.id, 102);
  const retainedRunning = store.get(running.id);
  const retainedValidating = store.get(validating.id);
  store.close();
  const restored = new StateStore(path);
  try {
    assert.deepEqual(restored.reconcile(() => false).map((job) => job.id), [ordinary.id]);
    assert.deepEqual(restored.get(running.id), retainedRunning);
    assert.deepEqual(restored.get(validating.id), retainedValidating);
    assert.throws(() => restored.claim(queued.id, process.pid), /active job/);
    assert.deepEqual(restored.reconcile(() => false), []);
  } finally { restored.close(); }
});
