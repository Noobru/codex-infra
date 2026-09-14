import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeLearningStore, KnowledgeCandidateSchema, type KnowledgeCandidate } from '../src/knowledge-learning.js';
import { KnowledgeFiles } from '../src/knowledge-store.js';
import { InteractionStore } from '../src/interactions.js';
import { InteractionTelemetry, InteractionTelemetryReceiptSchema, type InteractionTelemetryReceipt } from '../src/interaction-telemetry.js';
import { LearningApplications, type LearningApplicationInput } from '../src/learning-applications.js';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222221';
const nextTurn = '22222222-2222-4222-8222-222222222222';
const thirdTurn = '22222222-2222-4222-8222-222222222223';
const fourthTurn = '22222222-2222-4222-8222-222222222224';
const at = (minute: number) => new Date(Date.UTC(2026, 8, 12, 12, minute)).toISOString();
const scope = { taskClass: 'bugfix', language: 'TypeScript', problemCategory: 'observability' };
const declaration = { author: { name: 'Fixture agent', role: 'model' as const }, source: 'Explicit fixture application', evidence: ['Fixture application evidence'] };
const owner = { author: { name: 'Fixture owner', role: 'owner' as const }, source: 'Explicit fixture decision', evidence: ['Fixture owner decision'] };

class ApplicationFixture {
  readonly files: KnowledgeFiles;
  readonly store: InteractionStore;
  readonly learning: KnowledgeLearningStore;
  readonly applications: LearningApplications;
  constructor(readonly root: string) {
    this.files = new KnowledgeFiles(root); this.store = new InteractionStore(root);
    this.learning = new KnowledgeLearningStore(root); this.applications = new LearningApplications(root);
  }
  static async create(t: TestContext) {
    const parent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'learning-applications-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fixture = new ApplicationFixture(root);
    await fixture.store.begin({ threadId, title: 'Application fixture', projectId: 'fixture', performanceScope: scope, source: 'Fixture entry' });
    return fixture;
  }
  async candidate(promoted = true) {
    const interaction = await this.store.read(InteractionStore.idFor({ threadId }));
    const proposed = await this.learning.propose({ projectId: 'fixture', title: 'Evidence-guided fix', kind: 'skill',
      content: 'Inspect the focused failure before proposing a correction.', origin: { interactionId: interaction.id, revision: 1 },
      author: declaration.author, source: 'Fixture proposal' });
    await fs.writeFile(path.join(this.root, proposed.artifactPath), JSON.stringify({ ...proposed, createdAt: at(-10), updatedAt: at(-10) }));
    if (!promoted) return this.learning.read(proposed.id);
    const release = `artifacts/learning/releases/${proposed.id}/revision-2/SKILL.md`;
    await this.files.writeNew(release, proposed.content);
    // A canonical lifecycle fixture isolates application binding; promotion gates are covered by knowledge.test.ts.
    const candidate = KnowledgeCandidateSchema.parse({ ...proposed, revision: 2, status: 'promoted', updatedAt: at(5),
      artifactPath: `artifacts/learning/candidates/${proposed.id}/revision-000002.json`,
      review: { ...owner, decision: 'approved', recordedAt: at(3) },
      shadow: { ...owner, jobId: thirdTurn, attempt: 1, evaluationId: fourthTurn, recordedAt: at(4), status: 'passed', contentBound: true, checkIds: ['fixture-check'] },
      promotion: { ...owner, recordedAt: at(5), path: release, contentHash: proposed.contentHash } });
    await this.files.writeJsonNew(candidate.artifactPath, candidate);
    return candidate;
  }
  async turn(id: string, start: number, total: number, extra: Partial<InteractionTelemetryReceipt> = {}) {
    const interactionId = InteractionStore.idFor({ threadId });
    const status = extra.status ?? 'complete';
    const receipt = InteractionTelemetryReceiptSchema.parse({ version: 1, interactionId, threadId, turnId: id,
      projectId: 'fixture', interactionRevision: 1, performanceScope: scope, assignment: 'interaction-revision',
      modelIdentity: {model:'fixture-model',effort:'medium'},
      status, startedAt: at(start), finishedAt: status === 'complete' ? at(start + 1) : null,
      tokens: { totalTokens: total, inputTokens: total - 10, cachedInputTokens: Math.floor(total / 2), outputTokens: 10,
        reasoningOutputTokens: 5, cacheWriteInputTokens: null },
      coverage: { baselineObserved: true, terminalObserved: status === 'complete', tokenEvents: 2, duplicateEvents: 0, counterResets: 0, limited: false },
      epoch: { start: 0, end: 0 }, source: { kind: 'codex-rollout-token-count/v1', fingerprint: 'a'.repeat(64), startLine: 1, endLine: 3, cursor: 200 },
      capturedAt: at(start + 2), artifactPath: `artifacts/telemetry/${interactionId}/turn-${id}${status === 'complete' ? '' : '.partial'}.json`, warnings: [], ...extra });
    await this.files.writeJsonNew(receipt.artifactPath, receipt);
    return receipt;
  }
  input(candidate: KnowledgeCandidate, id = turnId): LearningApplicationInput { return { ...declaration, candidateId: candidate.id, threadId, turnId: id }; }
}

test('application records immutable exact release and turn provenance with idempotent concurrent replay', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate();
  const turn = await fixture.turn(turnId, 10, 80);
  const [first, same] = await Promise.all([fixture.applications.record(fixture.input(candidate)), fixture.applications.record(fixture.input(candidate))]);
  assert.deepEqual(first, same); assert.equal(first.classification, 'declared-application');
  assert.equal(first.contentHash, candidate.contentHash); assert.equal(first.promotion.path, candidate.promotion!.path);
  assert.equal(first.candidateRevision, 2); assert.equal(first.candidateArtifactPath, candidate.artifactPath);
  assert.equal(first.interactionId, turn.interactionId); assert.equal(first.projectId, 'fixture'); assert.deepEqual(first.performanceScope, scope);
  assert.equal(first.turnTelemetry.sourceFingerprint, turn.source.fingerprint); assert.deepEqual(first.evidence, declaration.evidence);
  const file = path.join(fixture.root, first.artifactPath), stat = await fs.stat(file);
  assert.deepEqual(await fixture.applications.record(fixture.input(candidate)), first); assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.equal((await fixture.applications.read()).applications.length, 1);
  assert.equal((await fixture.applications.read({ projectId: 'other' })).applications.length, 0);
  assert.equal((await fixture.learning.read(candidate.id)).revision, 2);
  await assert.rejects(fixture.applications.record({ ...fixture.input(candidate), evidence: ['Different declaration'] }), /different declaration/);
  await assert.rejects(fixture.applications.record({ ...fixture.input(candidate, nextTurn), evidence: [] }), /Too small/);
});

test('application requires an existing exact turn, active promotion at its start, matching project and intact content', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate();
  await assert.rejects(fixture.applications.record(fixture.input(candidate)), /exact registered turn/);
  await fixture.turn(turnId, 2, 100);
  await assert.rejects(fixture.applications.record(fixture.input(candidate)), /not an active promoted release/);
  await fixture.turn(nextTurn, 10, 80, { projectId: 'other' });
  await assert.rejects(fixture.applications.record(fixture.input(candidate, nextTurn)), /another project/);
  await fixture.turn(thirdTurn, 10, 80);
  await fs.writeFile(path.join(fixture.root, candidate.promotion!.path), 'Changed release');
  await assert.rejects(fixture.applications.record(fixture.input(candidate, thirdTurn)), /recorded hash/);
  const proposed = await fixture.candidate(false);
  await assert.rejects(fixture.applications.record(fixture.input(proposed, thirdTurn)), /not an active promoted release/);
  assert.equal((await fixture.applications.read()).applications.length, 0);
});

test('historical use is allowed before reversal while later use is rejected, with no current-project rebinding', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate();
  const reversed = await fixture.learning.revert(candidate.id, owner);
  await fs.writeFile(path.join(fixture.root, reversed.artifactPath), JSON.stringify({ ...reversed, updatedAt: at(20), reversal: { ...reversed.reversal, recordedAt: at(20) } }));
  await fixture.turn(turnId, 10, 80);
  await fixture.turn(nextTurn, 21, 60);
  const interaction = await fixture.store.read(InteractionStore.idFor({ threadId }));
  await fixture.store.update(interaction.id, { expectedRevision: 1, source: 'Fixture rebind', projectId: 'new-project', performanceScope: { taskClass: 'other' } });
  const application = await fixture.applications.record(fixture.input(candidate));
  assert.equal(application.candidateRevision, 2); assert.equal(application.projectId, 'fixture'); assert.deepEqual(application.performanceScope, scope);
  await assert.rejects(fixture.applications.record(fixture.input(candidate, nextTurn)), /not an active promoted release/);
});

test('effects require explicit applications, exact declared scope and completed baselines before promotion', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate();
  const baseline = await fixture.turn(turnId, 1, 200), treatment = await fixture.turn(nextTurn, 10, 100);
  await fixture.turn(thirdTurn, 11, 20); // A cheap but undeclared post-promotion turn must not enter treatment.
  await fixture.turn(fourthTurn, 2, 1000, { performanceScope: { ...scope, language: 'Python' } });
  const initial = await fixture.applications.getEffects(candidate.id);
  assert.equal(initial.status, 'pending'); assert.equal(initial.groups.length, 0);
  const application = await fixture.applications.record(fixture.input(candidate, nextTurn));
  const result = await fixture.applications.getEffects(candidate.id), group = result.groups[0]!;
  assert.equal(result.status, 'observed'); assert.equal(group.baseline.n, 1); assert.equal(group.treatment.n, 1);
  assert.deepEqual(group.baseline.turnIds, [baseline.turnId]); assert.deepEqual(group.treatment.turnIds, [treatment.turnId]);
  assert.deepEqual(group.treatment.applicationIds, [application.id]);
  const total = group.metrics.find(metric => metric.metric === 'totalTokens')!;
  assert.deepEqual(total, { metric: 'totalTokens', unit: 'tokens', baselineN: 1, treatmentN: 1, baselineMean: 200, treatmentMean: 100, delta: -100, deltaPercent: -50 });
  const missing = group.metrics.find(metric => metric.metric === 'cacheWriteInputTokens')!;
  assert.equal(missing.baselineN, 0); assert.equal(missing.treatmentN, 0); assert.equal(missing.delta, null);
  assert.ok(group.baseline.evidence.includes(baseline.artifactPath)); assert.ok(group.treatment.evidence.includes(treatment.artifactPath));
  assert.ok(group.treatment.evidence.includes(application.artifactPath)); assert.match(result.limitations.join(' '), /not causal effects/);
});

test('partial applications remain pending until complete telemetry appears, and missing scope is never inferred', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate();
  await fixture.turn(turnId, 1, 200);
  await fixture.turn(nextTurn, 10, 60, { status: 'partial' });
  const application = await fixture.applications.record(fixture.input(candidate, nextTurn));
  const before = await fixture.applications.getEffects(candidate.id);
  assert.equal(before.status, 'pending'); assert.equal(before.groups[0]!.treatment.n, 0);
  assert.deepEqual(before.groups[0]!.treatment.pendingApplicationIds, [application.id]);
  await fixture.turn(nextTurn, 10, 100);
  assert.equal((await fixture.applications.getEffects(candidate.id)).status, 'observed');
  assert.deepEqual(await fixture.applications.record(fixture.input(candidate, nextTurn)), application);
  await fixture.turn(thirdTurn, 11, 50, { projectId: null, performanceScope: null, interactionRevision: null, assignment: 'not-recorded-at-turn-time' });
  const unassigned = await fixture.applications.record(fixture.input(candidate, thirdTurn));
  assert.equal(unassigned.projectId, null); assert.equal(unassigned.performanceScope, null);
  const group = (await fixture.applications.getEffects(candidate.id)).groups.find(item => item.projectId === null)!;
  assert.equal(group.status, 'pending'); assert.equal(group.baseline.n, 0); assert.equal(group.treatment.n, 0);
});

test('batched effects read shared inventories once and keep observed metric samples when total tokens are absent', async t => {
  const fixture = await ApplicationFixture.create(t), candidate = await fixture.candidate(), other = await fixture.candidate();
  const tokens = { inputTokens: 100, outputTokens: 20, totalTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, cacheWriteInputTokens: null };
  await fixture.turn(turnId, 1, 200, { tokens });
  await fixture.turn(nextTurn, 10, 100, { tokens: { ...tokens, inputTokens: 60, outputTokens: null } });
  await fixture.applications.record(fixture.input(candidate, nextTurn));
  await fixture.applications.record(fixture.input(other, nextTurn));
  let applicationReads = 0, telemetryReads = 0;
  const readApplications = fixture.applications.read.bind(fixture.applications), readTelemetry = InteractionTelemetry.prototype.read;
  t.mock.method(fixture.applications, 'read', async (...args: Parameters<LearningApplications['read']>) => { applicationReads++; return readApplications(...args); });
  t.mock.method(InteractionTelemetry.prototype, 'read', async function(this: InteractionTelemetry, ...args: Parameters<InteractionTelemetry['read']>) {
    telemetryReads++; return readTelemetry.apply(this, args);
  });
  const batch = await fixture.applications.readEffects([candidate.id, other.id, candidate.id, fourthTurn]);
  assert.equal(applicationReads, 1); assert.equal(telemetryReads, 1); assert.equal(batch.effects.length, 2);
  assert.match(batch.warnings.join(' '), /could not be read/);
  const effect = batch.effects.find(item => item.candidateId === candidate.id)!;
  assert.equal(effect.status, 'observed'); assert.equal(effect.groups[0]!.baseline.n, 1); assert.equal(effect.groups[0]!.treatment.n, 1);
  const input = effect.groups[0]!.metrics.find(item => item.metric === 'inputTokens')!;
  assert.equal(input.baselineN, 1); assert.equal(input.treatmentN, 1); assert.equal(input.delta, -40);
  const output = effect.groups[0]!.metrics.find(item => item.metric === 'outputTokens')!;
  assert.equal(output.baselineN, 1); assert.equal(output.treatmentN, 0); assert.equal(output.delta, null);
  const total = effect.groups[0]!.metrics.find(item => item.metric === 'totalTokens')!;
  assert.equal(total.baselineN, 0); assert.equal(total.treatmentN, 0); assert.equal(total.delta, null);
});
