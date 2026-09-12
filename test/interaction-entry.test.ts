import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { InteractionEntry } from '../src/interaction-entry.js';
import { StateStore } from '../src/state.js';
import { KnowledgeLearningStore } from '../src/knowledge-learning.js';

test('read-only conversation entry leaves no files, persistence reuses identity and does not create a queue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-entry-'));
  const entry = new InteractionEntry(root);
  const interaction = { threadId: randomUUID(), title: 'Conversation', source: 'owner request' };
  const preview = await entry.enter({ interaction, persist: false });
  assert.equal(preview.interaction, null);
  assert.equal(preview.telemetry,null);
  assert.deepEqual(await fs.readdir(root), []);
  const opened = await entry.enter({ interaction });
  assert.equal(opened.dispatchStarted, false);
  assert.equal(opened.projectContext, null);
  assert.equal(opened.telemetry?.enabled,false);
  const repeat = await entry.enter({ interaction });
  assert.equal(repeat.interaction!.id, opened.interaction!.id);
  assert.equal(repeat.interaction!.revision, 1);
  const done = await entry.record(opened.interaction!.id, { expectedRevision: 1, source: 'local result', status: 'completed', summary: 'Answer delivered' });
  assert.equal(done.revision, 2);
  await assert.rejects(fs.access(path.join(root, 'state/jobs.sqlite')));
});

test('entry verifies execution links and rejects cross-project links without writing a revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-entry-'));
  await fs.mkdir(path.join(root, 'profiles'));
  await fs.writeFile(path.join(root, 'profiles/registry.json'), JSON.stringify({ version: 1, projects: [
    { id: 'fixture', name: 'Fixture', root, status: 'active', stack: [], modes: ['read-only'], sourceRoots: [], sources: [], checks: [] },
  ] }));
  const state = new StateStore(path.join(root, 'state/jobs.sqlite'));
  let job;
  try { job = state.create({ projectId: 'another', objective: 'fixture only', mode: 'read-only', profileHash: 'fixture', idempotencyKey: 'fixture' }); }
  finally { state.close(); }
  const entry = new InteractionEntry(root);
  const opened = await entry.enter({ interaction: { threadId: randomUUID(), title: 'Direct', source: 'owner', projectId: 'fixture' }, includeProjectContext: false });
  await assert.rejects(entry.record(opened.interaction!.id, { expectedRevision: 1, source: 'reported', jobIds: [job.id] }), /another project/);
  assert.equal((await entry.interactions.read(opened.interaction!.id)).revision, 1);
});

class FindingFixture {
  readonly entry: InteractionEntry;
  readonly learning: KnowledgeLearningStore;
  constructor(readonly root: string) { this.entry = new InteractionEntry(root); this.learning = new KnowledgeLearningStore(root); }
  static async create(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-entry-findings-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return new FindingFixture(root);
  }
  async begin() {
    return (await this.entry.enter({ interaction: { threadId: randomUUID(), title: 'Finding fixture', source: 'Fixture request' } })).interaction!;
  }
  finding() {
    return { id: 'runtime-update', projectId: 'fixture', title: 'Verify loaded runtime after rebuilding', kind: 'practice' as const,
      content: 'Check the loaded build fingerprint after updating an observer service.', evidence: ['fixture runtime comparison'] };
  }
}

test('recorded findings become proposed candidates pinned to original revision and explicit evidence', async t => {
  const f = await FindingFixture.create(t), opened = await f.begin(), finding = f.finding();
  const saved = await f.entry.record(opened.id, { expectedRevision: opened.revision, source: 'Observed comparison',
    status: 'completed', performanceScope:{taskClass:'runtime-diagnostics',language:'TypeScript',problemCategory:'stale-observer'}, findings: [{...finding,impact:{problem:'Stale observer',expectedChange:'Avoid repeated invalid-manifest diagnoses',language:'TypeScript'}}], evidence: ['fixture summary receipt'] });
  assert.equal(saved.status, 'completed'); assert.equal(saved.revision, 2);
  assert.deepEqual(saved.findingProcessing.warnings, []); assert.equal(saved.findingProcessing.processed.length, 1);
  const candidate = await f.learning.read(saved.findingProcessing.processed[0]!.candidateId);
  assert.equal(candidate.status, 'proposed'); assert.equal(candidate.review, null); assert.equal(candidate.promotion, null);
  assert.equal(candidate.author.role, 'model');
  assert.deepEqual(candidate.origin, { interactionId: saved.id, revision: 2 });
  assert.deepEqual(candidate.originEvidence.checkResults, []);
  assert.deepEqual(candidate.originEvidence.refs, [saved.artifactPath, 'fixture summary receipt', ...finding.evidence]);
  assert.equal(candidate.content, finding.content);
  assert.equal(saved.performanceScope?.problemCategory,'stale-observer');
  assert.equal(candidate.impact?.problem,'Stale observer');

  const replay = await f.entry.reconcileFindings(saved.id);
  assert.equal(replay.revision, saved.revision);
  assert.deepEqual(replay.findingProcessing, saved.findingProcessing);
  const later = await f.entry.record(saved.id, { expectedRevision: saved.revision, source: 'Later revision', evidence: ['later receipt'] });
  assert.equal(later.revision, 3); assert.deepEqual(later.findingProcessing, saved.findingProcessing);
  assert.equal((await f.learning.list()).items.length, 1);
  assert.deepEqual((await f.learning.read(candidate.id)).originEvidence.refs, candidate.originEvidence.refs);
});

test('ordinary failures without explicit findings never manufacture learning candidates', async t => {
  const f = await FindingFixture.create(t), opened = await f.begin();
  const saved = await f.entry.record(opened.id, { expectedRevision: 1, source: 'Fixture result', status: 'blocked', summary: 'Check failed.' });
  assert.deepEqual(saved.findings, []);
  assert.deepEqual(saved.findingProcessing, { processed: [], warnings: [] });
  assert.deepEqual((await f.entry.reconcileFindings(saved.id)).findingProcessing, saved.findingProcessing);
  assert.deepEqual((await f.learning.list()).items, []);
});

test('candidate processing failure does not fail a saved interaction and can be replayed after recovery', async t => {
  const f = await FindingFixture.create(t), opened = await f.begin();
  const blocked = path.join(f.root, 'artifacts/learning');
  await fs.writeFile(blocked, 'fixture filesystem obstruction');
  const saved = await f.entry.record(opened.id, { expectedRevision: 1, source: 'Recorded before processing', findings: [f.finding()] });
  assert.equal(saved.revision, 2); assert.equal(saved.findings[0]!.recordedRevision, 2);
  assert.equal(saved.findingProcessing.processed.length, 0);
  assert.match(saved.findingProcessing.warnings[0]!, /remains recorded; candidate processing failed/);
  assert.equal((await f.entry.interactions.read(saved.id)).revision, 2);
  await fs.rename(blocked, path.join(f.root, 'artifacts/learning-obstruction.txt'));
  const recovered = await f.entry.reconcileFindings(saved.id);
  assert.equal(recovered.revision, 2); assert.equal(recovered.findingProcessing.processed.length, 1);
  assert.deepEqual(recovered.findingProcessing.warnings, []);
  assert.equal((await f.learning.list()).items.length, 1);
});
