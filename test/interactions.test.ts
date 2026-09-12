import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractionStore, type InteractionBeginInput } from '../src/interactions.js';

class InteractionFixture {
  readonly store: InteractionStore;
  constructor(readonly root: string) { this.store = new InteractionStore(root); }
  static async create(t: TestContext) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'interactions-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return new InteractionFixture(root);
  }
  begin(threadId: string, extra: Partial<InteractionBeginInput> = {}) {
    return this.store.begin({ threadId, title: 'Conversation fixture', source: 'Explicit fixture request', ...extra });
  }
}

test('begin is idempotent across stores and direct conversations create no execution state', async t => {
  const fixture = await InteractionFixture.create(t), peer = new InteractionStore(fixture.root);
  const input = { threadId: 'thread-one', title: 'Talk without a project', source: 'Fixture conversation' };
  const [first, second] = await Promise.all([fixture.store.begin(input), peer.begin(input)]);
  assert.equal(first.id, second.id); assert.equal(first.revision, 1); assert.equal(second.revision, 1);
  assert.equal(first.projectId, null); assert.equal(first.route, 'direct'); assert.equal(first.status, 'open');
  assert.deepEqual(first.jobIds, []); assert.deepEqual(first.workflowIds, []);
  assert.equal((await fixture.store.list({ threadId: 'thread-one' })).total, 1);
  assert.deepEqual(await fs.readdir(path.join(fixture.root, 'artifacts')), ['interactions']);
  await assert.rejects(fs.access(path.join(fixture.root, 'state/jobs.sqlite')), { code: 'ENOENT' });
  const keyed = await fixture.store.begin({ idempotencyKey: 'no-thread-yet', title: 'No thread ID', source: 'Fixture' });
  assert.equal((await peer.begin({ idempotencyKey: 'no-thread-yet', title: 'Do not overwrite', source: 'Fixture repeat' })).id, keyed.id);
  assert.equal((await peer.read(keyed.id)).title, 'No thread ID');
});

test('thread import keeps only bounded metadata, never infers idle completion, and preserves local progress', async t => {
  const fixture = await InteractionFixture.create(t);
  const title = 'Generated long title '.repeat(80);
  const thread = { threadId: 'imported-thread', title, cwd: path.resolve(fixture.root,'unmounted-product'), sourceStatus: 'idle',
    updatedAt: '2026-09-12T19:00:00Z', sourceRef: 'codex://threads/imported-thread' };
  const imported = await fixture.store.importThreads({ source: 'Codex task inventory', observedAt: '2026-09-12T19:01:00Z', threads: [thread] });
  const id = imported.items[0]!.id, initial = await fixture.store.read(id);
  assert.equal(imported.imported, 1); assert.equal(initial.status, 'imported'); assert.equal(initial.projectId, null);
  assert.equal(initial.title!.length, 240); assert.equal(initial.titleTruncated, true); assert.equal(initial.titleOriginalChars, title.length);
  assert.equal(initial.objective, null); assert.equal(initial.imported!.sourceStatus, 'idle');
  const opened = await fixture.begin(thread.threadId, { title: 'Owner objective', intent: 'work', objective: 'Produce a direct result' });
  assert.equal(opened.id, id); assert.equal(opened.revision, 2); assert.equal(opened.status, 'open');
  const receipt = path.join(fixture.root, 'direct-result.txt'); await fs.writeFile(receipt, 'Observed local result');
  const completed = await fixture.store.update(id, { expectedRevision: opened.revision, source: 'Owner-directed fixture work',
    status: 'completed', summary: 'Direct result observed', evidence: [receipt] });
  const reimport = await fixture.store.importThreads({ source: 'Codex task inventory', observedAt: '2026-09-12T19:03:00Z',
    threads: [{ ...thread, title: 'New inventory title', sourceStatus: 'running', updatedAt: '2026-09-12T19:02:00Z' }] });
  assert.equal(reimport.updated, 1);
  const current = await fixture.store.read(id);
  assert.equal(current.status, 'completed'); assert.equal(current.title, 'Owner objective');
  assert.equal(current.summary, completed.summary); assert.deepEqual(current.evidence, [receipt]);
  assert.equal(current.imported!.sourceStatus, 'running'); assert.equal(current.revision, completed.revision + 1);
  assert.equal((await fixture.store.read(id, 1)).status, 'imported');
  const repeated = await fixture.store.importThreads({ source: 'Codex task inventory', observedAt: '2026-09-12T19:04:00Z',
    threads: [{ ...thread, title: 'New inventory title', sourceStatus: 'running', updatedAt: '2026-09-12T19:02:00Z' }] });
  assert.equal(repeated.unchanged, 1); assert.equal(repeated.items[0]!.revision, current.revision);
});

test('updates append sourced evidence and links while exclusive revisions prevent lost updates', async t => {
  const fixture = await InteractionFixture.create(t), peer = new InteractionStore(fixture.root);
  const first = await fixture.begin('update-thread', { projectId: 'fixture', intent: 'work' });
  const jobs = ['3a5ba2ed-b9d6-4d49-aa95-e792e8ee28b4'];
  const workflow = 'workflow_4a5ba2ed-b9d6-4d49-aa95-e792e8ee28b4';
  const second = await fixture.store.update(first.id, { expectedRevision: 1, source: 'Fixture reviewer',
    sourceRef: 'codex://threads/update-thread', summary: 'Contact tester@example.org with '+['ghp_','fakefixturecredential'].join(''),
    evidence: ['Verified diff', 'Verified diff'], jobIds: jobs, workflowIds: [workflow] });
  assert.deepEqual(second.evidence, ['Verified diff']); assert.deepEqual(second.jobIds, jobs);
  assert.match(second.summary!, /\[email redacted\]/); assert.match(second.summary!, /\[credential redacted\]/);
  assert.equal(second.change.origin.source, 'Fixture reviewer'); assert.equal(second.change.previousRevision, 1);
  assert.equal((await fixture.store.read(first.id, 1)).summary, null);
  const outcomes = await Promise.allSettled([
    fixture.store.update(first.id, { expectedRevision: 2, source: 'Concurrent A', evidence: ['A'] }),
    peer.update(first.id, { expectedRevision: 2, source: 'Concurrent B', evidence: ['B'] }),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /revision conflict/);
  const third = await peer.read(first.id);
  assert.equal(third.revision, 3); assert.equal(third.evidence.length, 2); assert.deepEqual(third.jobIds, jobs);
  await assert.rejects(peer.update(first.id, { expectedRevision: 1, source: 'Stale client', summary: 'Overwrite' }), /revision conflict/);
  assert.equal((await peer.read(first.id)).revision, 3);
  await assert.rejects(fs.access(path.join(fixture.root, 'artifacts/jobs')), { code: 'ENOENT' });
});

test('list is filtered and paginated, and stale imports cannot replace newer source metadata', async t => {
  const fixture = await InteractionFixture.create(t);
  await fixture.begin('global'); await fixture.begin('project', { projectId: 'fixture' });
  const first = await fixture.store.list({ limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
  const second = await fixture.store.list({ limit: 1, offset: first.nextOffset! });
  assert.equal(second.items.length, 1); assert.equal(second.nextOffset, null); assert.notEqual(first.items[0]!.id, second.items[0]!.id);
  assert.equal((await fixture.store.list({ projectId: null })).items[0]!.threadId, 'global');
  assert.equal((await fixture.store.list({ projectId: 'fixture', status: 'open' })).total, 1);
  const thread = { threadId: 'source-order', title: 'Current source', sourceStatus: 'idle', sourceRef: 'codex://threads/source-order', updatedAt: '2026-09-12T19:00:00.123Z' };
  const fresh = await fixture.store.importThreads({ source: 'Inventory', observedAt: '2026-09-12T19:01:00Z', threads: [thread,
    { threadId: 'untitled', title: null, sourceStatus: 'idle', sourceRef: 'codex://threads/untitled', updatedAt: null }] });
  const untitled = await fixture.store.read(InteractionStore.idFor({ threadId: 'untitled' }));
  assert.equal(untitled.title, null); assert.equal(untitled.titleOriginalChars, 0); assert.equal(untitled.titleTruncated, false);
  const stale = await fixture.store.importThreads({ source: 'Inventory', observedAt: '2026-09-12T19:02:00Z',
    threads: [{ ...thread, title: 'Older source', updatedAt: '2026-09-12T19:00:00Z' }] });
  assert.equal(stale.unchanged, 1);
  assert.equal((await fixture.store.read(fresh.items[0]!.id)).title, 'Current source');
});

test('explicit findings preserve their first revision, deduplicate identical input and reject conflicting reuse', async t => {
  const f = await InteractionFixture.create(t), first = await f.begin('finding-revisions');
  const finding = { id: 'observer-version', projectId: 'fixture', title: 'Observe runtime version', kind: 'practice' as const,
    content: 'Compare startup and installed build fingerprints after rebuilding.', evidence: ['fixture runtime comparison'] };
  const recorded = await f.store.update(first.id, { expectedRevision: first.revision, source: 'Fixture finding', findings: [finding, finding] });
  assert.deepEqual(recorded.findings, [{ ...finding, recordedRevision: 2 }]);
  assert.deepEqual((await f.store.read(first.id, 1)).findings, []);
  const later = await f.store.update(first.id, { expectedRevision: 2, source: 'Later progress', summary: 'Progress', findings: [finding] });
  assert.deepEqual(later.findings, recorded.findings);
  await assert.rejects(f.store.update(first.id, { expectedRevision: 3, source: 'Conflicting finding',
    findings: [{ ...finding, content: 'A different practice under the same ID.' }] }), /finding ID.*different input/);
  assert.equal((await f.store.read(first.id)).revision, 3);
  await assert.rejects(f.store.update(first.id, { expectedRevision: 3, source: 'Missing evidence', findings: [{ ...finding, evidence: [] }] }));
  await assert.rejects(f.store.update(first.id, { expectedRevision: 3, source: 'Unsafe content',
    findings: [{ ...finding, content: 'Contact tester@example.org to disclose details.' }] }), /cannot be preserved/);
  assert.equal((await f.store.read(first.id)).revision, 3);
});
