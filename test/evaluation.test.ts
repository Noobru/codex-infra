import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { StateStore } from '../src/state.js';
import { EvaluationStore, EvaluationInputSchema, type EvaluationInput } from '../src/evaluation.js';

class EvaluationFixture {
  constructor(readonly root: string, readonly jobId: string, readonly store: EvaluationStore) {}
  static async create(t: TestContext, exitCode: number | null = 0, writeChecks = true) {
    const fixtureParent = fileURLToPath(new URL('../../artifacts/test-fixtures/', import.meta.url));
    await fs.mkdir(fixtureParent, { recursive: true });
    const root = await fs.mkdtemp(path.join(fixtureParent, 'evaluation-'));
    const state = new StateStore(path.join(root, 'state/jobs.sqlite'));
    const job = state.create({ idempotencyKey: 'fixture', projectId: 'infra-fixture', objective: 'Evaluate an internal fixture', mode: 'read-only', profileHash: 'fixture-profile' });
    state.claim(job.id, process.pid);
    state.transition(job.id, 'validating');
    state.transition(job.id, 'completed');
    state.close();
    if (writeChecks) {
      const directory = path.join(root, 'artifacts/jobs', job.id, 'attempt-1');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'checks.json'), JSON.stringify([{ checkId: 'fixture-check', exitCode, durationMs: 10 }]));
    }
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return new EvaluationFixture(root, job.id, new EvaluationStore(root));
  }
  input(value = 100): EvaluationInput {
    return {
      jobId: this.jobId, attempt: 1, taskClass: 'fixture-checks',
      author: { name: 'Fixture reviewer', role: 'reviewer' }, source: 'test-fixture/v1', evidence: ['fixture-checks'],
      rubric: { id: 'fixture-rubric', version: '1', criteria: [{ id: 'correctness', checkId: 'fixture-check', critical: true }] },
      metrics: [{ id: 'elapsed', classification: 'observed', value, unit: 'ms', method: 'fixture-clock/v1',
        source: 'fixture-measurement', cohort: 'identical-fixture', window: { start: '2026-09-12T00:00:00Z', end: '2026-09-12T00:01:00Z' },
        version: '1', sample: { size: 4, representative: true, selection: 'All four cases in the declared fixture cohort.' } }],
    };
  }
}

test('records real checks without changing queue or inferring acceptance; reads an immutable versioned snapshot', async t => {
  const fixture = await EvaluationFixture.create(t);
  const dbPath = path.join(fixture.root, 'state/jobs.sqlite');
  const before = await fs.readFile(dbPath);
  const input = fixture.input();
  input.author.name = 'reviewer@example.com';
  const receipt = await fixture.store.record(input);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.technical.status, 'passed');
  assert.equal(receipt.technical.jobCompletedAtRecord, true);
  assert.equal(receipt.acceptance.status, 'not-recorded');
  assert.match(receipt.technical.checksEvidence!, /attempt-1\/checks.json$/);
  assert.ok(!JSON.stringify(receipt).includes('reviewer@example.com'));
  assert.deepEqual(await fixture.store.read(receipt.id), receipt);
  assert.deepEqual(await fs.readFile(dbPath), before);
  await assert.rejects(fixture.store.record({ ...input, attempt: 2 }), /no canonical observation/);
});

test('compares a compatible signal reproducibly while accepted delivery requires explicit owner evidence', async t => {
  const fixture = await EvaluationFixture.create(t);
  const acceptance = { status: 'accepted' as const, author: { name: 'Fixture owner', role: 'owner' as const }, source: 'fixture-owner-decision', evidence: ['fixture-decision-1'] };
  const baseline = await fixture.store.record({ ...fixture.input(100), acceptance });
  const treatment = await fixture.store.record({ ...fixture.input(80), acceptance });
  const input = { baselineId: baseline.id, treatmentId: treatment.id, metricId: 'elapsed' };
  const comparison = await fixture.store.compare(input);
  assert.equal(comparison.status, 'compared');
  assert.equal(comparison.absoluteDelta, -20);
  assert.equal(comparison.percentageChange, -20);
  assert.equal(comparison.acceptedDeliveryComparison, true);
  assert.deepEqual(await fixture.store.compare(input), comparison);
  const undeclared = await fixture.store.record(fixture.input(80));
  assert.equal((await fixture.store.compare({ ...input, treatmentId: undeclared.id })).acceptedDeliveryComparison, false);
  assert.equal(EvaluationInputSchema.safeParse({ ...fixture.input(), acceptance: { ...acceptance, author: { name: 'Model', role: 'model' } } }).success, false);
});

test('failed critical checks cannot be compensated by a perfect score or declared acceptance', async t => {
  const fixture = await EvaluationFixture.create(t, 1);
  const input = fixture.input(100);
  input.acceptance = { status: 'accepted', author: { name: 'Fixture owner', role: 'owner' }, source: 'fixture-decision', evidence: ['decision'] };
  const receipt = await fixture.store.record(input);
  assert.equal(receipt.technical.status, 'failed');
  assert.equal(receipt.technical.jobCompletedAtRecord, true);
  assert.equal(receipt.acceptance.status, 'accepted');
  const comparison = await fixture.store.compare({ baselineId: receipt.id, treatmentId: receipt.id, metricId: 'elapsed' });
  assert.equal(comparison.status, 'not-comparable');
  assert.equal(comparison.absoluteDelta, null);
  assert.equal(comparison.acceptedDeliveryComparison, false);
});

test('missing checks and measurements remain unknown; explicit rejection is retained separately', async t => {
  const fixture = await EvaluationFixture.create(t, 0, false);
  const receipt = await fixture.store.record({ ...fixture.input(), metrics: [{ id: 'owner-minutes', classification: 'unknown', reason: 'No owner effort measurement.' }],
    acceptance: { status: 'rejected', author: { name: 'Fixture owner', role: 'owner' }, source: 'fixture-review', evidence: ['rejection'] } });
  assert.equal(receipt.technical.status, 'unknown');
  assert.equal(receipt.acceptance.status, 'rejected');
  assert.equal(receipt.metrics[0]?.value, null);
  assert.equal(receipt.metrics[0]?.sample, null);
  const comparison = await fixture.store.compare({ baselineId: receipt.id, treatmentId: receipt.id, metricId: 'cost' });
  assert.equal(comparison.status, 'unknown');
  assert.equal(comparison.absoluteDelta, null);
  assert.equal(comparison.percentageChange, null);
});

test('comparison rejects incompatible methods and excludes zero or unrepresentative baselines from percentages', async t => {
  const fixture = await EvaluationFixture.create(t);
  const baseline = await fixture.store.record(fixture.input(100));
  const changed = fixture.input(80);
  changed.metrics![0]!.method = 'different-method/v1';
  const treatment = await fixture.store.record(changed);
  assert.equal((await fixture.store.compare({ baselineId: baseline.id, treatmentId: treatment.id, metricId: 'elapsed' })).status, 'not-comparable');
  for (const value of [0, 100]) {
    const input = fixture.input(value);
    input.metrics![0]!.sample!.representative = false;
    const receipt = await fixture.store.record(input);
    const comparison = await fixture.store.compare({ baselineId: receipt.id, treatmentId: baseline.id, metricId: 'elapsed' });
    assert.equal(comparison.status, 'compared');
    assert.equal(comparison.percentageChange, null);
  }
  const estimated = fixture.input(80);
  const metric = estimated.metrics![0]!;
  assert.equal(metric.classification, 'observed');
  if (metric.classification !== 'observed') throw new Error('Unexpected fixture metric.');
  estimated.metrics = [{ ...metric, classification: 'estimated', estimateBasis: 'Hypothetical saved work; no measured counterfactual.' }];
  const estimate = await fixture.store.record(estimated);
  const estimateComparison = await fixture.store.compare({ baselineId: estimate.id, treatmentId: estimate.id, metricId: 'elapsed' });
  assert.equal(estimateComparison.percentageChange, null);
  assert.equal((await fixture.store.compare({ baselineId: baseline.id, treatmentId: estimate.id, metricId: 'elapsed' })).status, 'not-comparable');
});
