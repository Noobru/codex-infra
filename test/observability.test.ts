import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { StateStore, type Job } from '../src/state.js';
import { ObservationReader } from '../src/observability.js';
import { RoutingPolicy } from '../src/routing.js';

class ObservationFixture {
  private readonly readers: ObservationReader[] = [];
  constructor(readonly root: string, readonly state: StateStore) {}
  static async create(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-observation-'));
    const fixture = new ObservationFixture(root, new StateStore(path.join(root, 'state/jobs.sqlite')));
    t.after(async () => { for (const reader of fixture.readers) reader.close(); fixture.state.close(); await fs.rm(root, { recursive: true, force: true }); });
    return fixture;
  }
  job(key: string, projectId = 'project-a'): Job {
    return this.state.create({ idempotencyKey: key, projectId, objective: 'Inspect a fixture for owner@example.com ' + 'context '.repeat(300), mode: 'read-only', profileHash: 'profile' });
  }
  async artifact(jobId: string, relative: string, value: unknown) {
    const file = path.join(this.root, 'artifacts/jobs', jobId, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  }
  reader(t: TestContext): ObservationReader {
    this.state.close();
    const reader = new ObservationReader(this.root);
    this.readers.push(reader);
    return reader;
  }
}

test('overview filters and paginates the canonical queue without changing state or claiming acceptance', async t => {
  const fixture = await ObservationFixture.create(t);
  const first = fixture.job('first');
  fixture.state.claim(first.id, process.pid);
  fixture.state.transition(first.id, 'failed');
  fixture.state.transition(first.id, 'ready');
  fixture.state.claim(first.id, process.pid);
  fixture.state.transition(first.id, 'validating');
  fixture.state.transition(first.id, 'completed');
  const second = fixture.job('second');
  fixture.state.transition(second.id, 'waiting_user');
  fixture.job('other', 'project-b');
  const expectedJobs = fixture.state.list();
  const expectedEvents = fixture.state.events(first.id);
  const reader = fixture.reader(t);
  const dbPath = path.join(fixture.root, 'state/jobs.sqlite');
  const before = await fs.readFile(dbPath);
  const firstPage = await reader.overview({ projectId: 'project-a', limit: 1 });
  assert.equal(firstPage.page.total, 2);
  assert.equal(firstPage.page.nextOffset, 1);
  assert.equal(firstPage.runs[0]?.id, second.id);
  assert.equal(firstPage.counts.completedTechnical, 1);
  assert.equal(firstPage.counts.retriesObserved, 1);
  assert.equal(firstPage.counts.accepted, null);
  assert.deepEqual(firstPage.unknown, { ownerMinutes: null, cost: null, efficiency: null });
  const next = await reader.overview({ projectId: 'project-a', limit: 1, offset: firstPage.page.nextOffset! });
  assert.equal(next.runs[0]?.id, first.id);
  assert.equal(next.page.nextOffset, null);
  assert.equal(next.runs[0]?.durationBasis, 'created-to-last-update');
  assert.ok(!JSON.stringify(firstPage).includes('owner@example.com'));
  assert.ok(firstPage.runs[0]!.objectiveExcerpt.length <= 400);
  reader.close();
  assert.deepEqual(await fs.readFile(dbPath), before);
  const reopened = new StateStore(dbPath, { readOnly: true });
  try { assert.deepEqual(reopened.list(), expectedJobs); assert.deepEqual(reopened.events(first.id), expectedEvents); }
  finally { reopened.close(); }
});

test('run observations show real turns, known usage, check results and runtime routing without raw prompts or output', async t => {
  const fixture = await ObservationFixture.create(t);
  const job = fixture.job('receipts');
  fixture.state.claim(job.id, process.pid);
  fixture.state.transition(job.id, 'failed', { error: 'Bearer private-value' });
  fixture.state.transition(job.id, 'ready');
  fixture.state.claim(job.id, process.pid);
  fixture.state.transition(job.id, 'validating');
  fixture.state.transition(job.id, 'completed', { result: 'Complete for owner@example.com' });
  const policy = new RoutingPolicy();
  const preparedRouting = policy.decide({ taskClass: 'implementation' });
  const actualRouting = policy.decide({ taskClass: 'implementation' }, [{ id: 'gpt-6-astra', supportedReasoningEfforts: ['ultra'] }]);
  const contract = { version: 1, hash: 'contract-hash', objective: 'FULL PRIVATE PROMPT', kind: 'codex', mode: 'read-only',
    checkIds: ['typecheck'], requirementIds: ['IG-09'], details: { acceptanceCriteria: ['SECRET CRITERION'], nonGoals: ['SECRET NON-GOAL'] } };
  const context = { version: 1, hash: 'pack-hash', selectorVersion: 'lexical-v1', capturedAt: '2026-09-12T00:00:00Z',
    taskContractHash: 'contract-hash', profileHash: 'profile-hash', budget: { limitChars: 4000, includedChars: 100, availableChars: 200 },
    sources: [{ requiresFullRead: true, excerpt: 'FULL PRIVATE SOURCE', path: 'fixture-private/source.md' }], excludedSources: [] };
  await fixture.artifact(job.id, 'manifest.json', { kind: 'codex', checkIds: ['typecheck'], taskContract: contract, context: 'FULL PRIVATE CONTEXT' });
  await fixture.artifact(job.id, 'context-pack.json', context);
  await fixture.artifact(job.id, 'attempt-1/worker.json', { status: 'failed', turnId: 'turn-one', receipt: { model: 'gpt-6-astra' } });
  await fixture.artifact(job.id, 'attempt-2/task-contract.json', contract);
  await fixture.artifact(job.id, 'attempt-2/context-pack.json', context);
  await fixture.artifact(job.id, 'attempt-2/routing.json', preparedRouting);
  await fixture.artifact(job.id, 'attempt-2/worker.json', { status: 'completed', threadId: 'thread-one', turnId: 'turn-two',
    summary: 'RAW WORKER SUMMARY', receipt: { model: 'gpt-6-astra', reasoningEffort: 'ultra',
      startedAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T00:00:05Z', cleanupConfirmed: true, routingDecision: actualRouting,
      tokenUsage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 }, tokenUsageScope: 'thread-cumulative',
      quotaAtAdmission: { rateLimits: { limitId: 'codex', primary: { usedPercent: 90, windowDurationMins: 300 } }, secret: 'SECRET ACCOUNT VALUE' },
      prompt: 'FULL PRIVATE PROMPT', cwd: 'fixture-private/working-tree' } });
  await fixture.artifact(job.id, 'attempt-2/checks.json', [{ checkId: 'typecheck', exitCode: 0, durationMs: 250, stdout: 'RAW COMMAND OUTPUT', args: ['PRIVATE ARGUMENT'] }]);
  const reader = fixture.reader(t);
  const detail = await reader.run(job.id, { limit: 2 });
  assert.equal(detail.summary.completedTechnical, true);
  assert.equal(detail.observations.accepted, null);
  assert.equal(detail.observations.modelTurnsObserved, 2);
  assert.equal(detail.observations.tokenReceiptsObserved, 1);
  assert.equal(detail.attempts[0]?.worker?.tokenUsage, null);
  assert.equal(detail.attempts[1]?.worker?.tokenUsage?.totalTokens, undefined);
  assert.equal(detail.attempts[1]?.worker?.tokenUsageScope, 'thread-cumulative');
  assert.equal(detail.attempts[1]?.worker?.elapsedWallClockMs, 5000);
  assert.equal(detail.attempts[1]?.checks?.[0]?.passed, true);
  assert.equal(detail.attempts[1]?.routingSource, 'worker-receipt');
  assert.equal(detail.attempts[1]?.routing?.evidenceLevel, 'runtime-validated');
  assert.equal(detail.attempts[1]?.contextPack?.sourcesRequiringFullRead, 1);
  assert.equal(detail.attempts[1]?.taskContract?.acceptanceCriteriaCount, 1);
  assert.deepEqual(detail.attempts[1]?.worker?.quotaAtAdmission?.[0]?.primary, { usedPercent: 90, windowDurationMins: 300 });
  assert.ok(detail.events.nextAfterEventId !== null);
  const nextEvents = await reader.run(job.id, { afterEventId: detail.events.nextAfterEventId!, limit: 2 });
  assert.ok(nextEvents.events.items.every(event => event.id > detail.events.items.at(-1)!.id));
  assert.ok(detail.evidence.every(reference => reference.startsWith(`artifacts/jobs/${job.id}/`) && !path.isAbsolute(reference)));
  for (const value of ['FULL PRIVATE', 'SECRET ', 'RAW ', 'PRIVATE ARGUMENT', 'fixture-private', 'owner@example.com', 'private-value']) {
    assert.ok(!JSON.stringify(detail).includes(value), `Unexpected raw evidence: ${value}`);
  }
});

test('missing and invalid receipts remain unknown while pagination is bounded', async t => {
  const fixture = await ObservationFixture.create(t);
  const job = fixture.job('incomplete');
  fixture.state.claim(job.id, process.pid);
  fixture.state.transition(job.id, 'failed');
  await fixture.artifact(job.id, 'attempt-1/worker.json', { badReceipt: true });
  const reader = fixture.reader(t);
  const detail = await reader.run(job.id, { limit: 10000 });
  assert.equal(detail.events.limit, 200);
  assert.equal(detail.attempts[0]?.worker, null);
  assert.equal(detail.attempts[0]?.checks, null);
  assert.equal(detail.observations.modelTurnsObserved, 0);
  assert.equal(detail.observations.cost, null);
  assert.ok(detail.warnings.some(warning => warning.includes('worker.json')));
  assert.equal((await reader.overview({ limit: 10000 })).page.limit, 100);
  await assert.rejects(reader.run(job.id, { afterEventId: -1 }), /Pagination/);
  await assert.rejects(reader.overview({ offset: 0.5 }), /Pagination/);
});
