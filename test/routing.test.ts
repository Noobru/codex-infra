import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ROUTING_CONFIGURATION, RoutingConfigurationSchema, RoutingDecisionSchema, RoutingPolicy, TaskRoutingInputSchema, type RuntimeModelCapability, type TaskRoutingInput } from '../src/routing.js';

const policy = new RoutingPolicy();
const small: TaskRoutingInput = {
  taskClass: 'implementation', complexity: 'low', uncertainty: 'low', bounded: true,
  independentlyVerifiable: true, contextCoupling: 'low', risk: 'low', delegationBenefit: 'expected',
};
const catalog: RuntimeModelCapability[] = [
  { id: 'gpt-6-astra', supportedReasoningEfforts: ['high', 'ultra'] },
  { id: 'gpt-5.6-luna', supportedReasoningEfforts: ['low', 'medium'] },
  { id: 'gpt-5.6-sol', supportedReasoningEfforts: ['medium', 'high'] },
  { id: 'gpt-daybreak-blue-latest', supportedReasoningEfforts: ['high'] },
];

test('canonical checks never select a model or need model discovery', () => {
  const decision = policy.decide({ taskClass: 'deterministic', explicitRequestedModel: 'gpt-6-astra' }, []);
  assert.equal(decision.status, 'deterministic');
  assert.equal(decision.assignment, 'none');
  assert.equal(decision.candidate, null);
  assert.equal(decision.requiresCapabilityValidation, false);
});

test('the coordinator is Astra Ultra and uncertain or coupled work stays with it', () => {
  for (const input of [
    { taskClass: 'implementation' } as TaskRoutingInput,
    { ...small, contextCoupling: 'high' } as const,
    { ...small, uncertainty: 'high' } as const,
    { ...small, risk: 'high' } as const,
    { ...small, bounded: false },
    { ...small, independentlyVerifiable: false },
    { ...small, delegationBenefit: 'unknown' } as const,
  ]) {
    const decision = policy.decide(input, catalog);
    assert.equal(decision.assignment, 'coordinator');
    assert.deepEqual(decision.candidate, { model: 'gpt-6-astra', reasoningEffort: 'ultra' });
  }
});

test('small independently verifiable implementation is a Luna hypothesis until catalog validation', () => {
  const hypothesis = policy.decide(small);
  assert.equal(hypothesis.candidate?.model, 'gpt-5.6-luna');
  assert.equal(hypothesis.evidenceLevel, 'hypothesis');
  assert.equal(hypothesis.requiresCapabilityValidation, true);
  const validated = policy.decide(small, catalog);
  assert.equal(validated.evidenceLevel, 'runtime-validated');
  assert.equal(validated.capabilityValidation, 'matched');
  assert.equal(validated.requiresCapabilityValidation, false);
});

test('bounded low retrieval uses Luna low effort', () => {
  const input: TaskRoutingInput = { ...small, taskClass: 'retrieval' };
  const decision = policy.decide(input, catalog);
  assert.deepEqual(decision.candidate, { model: 'gpt-5.6-luna', reasoningEffort: 'low' });
  assert.equal(decision.rule, 'bounded-retrieval');
  assert.equal(decision.capabilityValidation, 'matched');
});

test('bounded low review and research use Sol medium analysis', () => {
  for (const taskClass of ['review', 'research'] as const) {
    const decision = policy.decide({ ...small, taskClass }, catalog);
    assert.deepEqual(decision.candidate, { model: 'gpt-5.6-sol', reasoningEffort: 'medium' });
    assert.equal(decision.rule, 'separable-analysis');
  }
});

test('separable review and research route directly to Sol without a mandatory model chain', () => {
  for (const taskClass of ['review', 'research'] as const) {
    const decision = policy.decide({ ...small, taskClass, complexity: 'moderate', uncertainty: 'moderate', risk: 'moderate' }, catalog);
    assert.equal(decision.candidate?.model, 'gpt-5.6-sol');
    assert.equal(decision.fallback, null);
    assert.deepEqual(decision.limits, { automaticRetries: 0, automaticEscalation: false, fixedModelChain: false });
  }
});

test('missing delegate or effort blocks without silently escalating to the coordinator', () => {
  for (const available of [
    catalog.filter(model => model.id !== 'gpt-5.6-luna'),
    catalog.map(model => model.id === 'gpt-5.6-luna' ? { ...model, supportedReasoningEfforts: ['low'] } : model),
  ]) {
    const decision = policy.decide(small, available);
    assert.equal(decision.status, 'blocked');
    assert.equal(decision.assignment, 'none');
    assert.equal(decision.candidate, null);
    assert.equal(decision.fallback, null);
    assert.match(decision.reason, /No permitted fallback is available/);
    assert.equal(decision.limits.automaticRetries, 0);
  }
});

test('missing coordinator effort blocks instead of silently lowering effort or choosing another model', () => {
  const available = catalog.map(model => model.id === 'gpt-6-astra' ? { ...model, supportedReasoningEfforts: ['high'] } : model);
  const decision = policy.decide({ taskClass: 'implementation' }, available);
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.candidate, null);
  assert.equal(decision.capabilityValidation, 'unavailable');
  assert.match(decision.reason, /effort ultra is unavailable/);
});

test('defensive work selects Blue and missing Blue cannot silently fall back to Astra', () => {
  const input = { taskClass: 'defensive-security' } as const;
  assert.equal(policy.decide(input, catalog).candidate?.model, 'gpt-daybreak-blue-latest');
  const decision = policy.decide(input, catalog.filter(model => model.id !== 'gpt-daybreak-blue-latest'));
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.candidate, null);
  assert.equal(decision.fallback, null);
  assert.match(decision.reason, /gpt-daybreak-blue-latest/);
  assert.equal(policy.decide({ ...input, explicitRequestedModel: 'gpt-6-astra' }, catalog).status, 'blocked');
});

test('an explicit ordinary model request is honored only for its exact catalog capability', () => {
  const input = { ...small, explicitRequestedModel: 'owner-selected-model', explicitRequestedReasoningEffort: 'high' };
  const available = [...catalog, { id: 'owner-selected-model', supportedReasoningEfforts: ['high'] }];
  assert.deepEqual(policy.decide(input, available).candidate, { model: 'owner-selected-model', reasoningEffort: 'high' });
  const missing = policy.decide(input, catalog);
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.fallback, null);
  assert.equal(policy.decide({ ...input, explicitRequestedReasoningEffort: 'ultra' }, available).status, 'blocked');
});

test('new catalog models do not change the coordinator without explicit configuration', () => {
  const available = [...catalog, { id: 'future-strong-model', supportedReasoningEfforts: ['ultra'] }];
  assert.equal(policy.decide({ taskClass: 'research' }, available).candidate?.model, 'gpt-6-astra');
  const changed = new RoutingPolicy({ coordinator: { model: 'future-strong-model', reasoningEffort: 'ultra' } });
  assert.equal(changed.decide({ taskClass: 'research' }, available).candidate?.model, 'future-strong-model');
  assert.notEqual(changed.hash, policy.hash);
});

test('an explicit model without effort keeps the effort qualified for the task', () => {
  assert.deepEqual(policy.decide({ ...small, taskClass: 'retrieval', explicitRequestedModel: 'gpt-5.6-sol' }).candidate,
    { model: 'gpt-5.6-sol', reasoningEffort: 'low' });
  assert.deepEqual(policy.decide({ ...small, taskClass: 'research', complexity: 'moderate', explicitRequestedModel: 'gpt-5.6-sol' }).candidate,
    { model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  assert.equal(policy.decide({ ...small, explicitRequestedModel: 'future-model' }).candidate?.reasoningEffort, 'medium');
});

test('a validated custom configuration changes specialists and is represented by its schema', () => {
  const configuration = {
    ...DEFAULT_ROUTING_CONFIGURATION,
    specialists: {
      ...DEFAULT_ROUTING_CONFIGURATION.specialists,
      retrieval: { model: 'custom-retriever', reasoningEffort: 'low' },
    },
  };
  assert.deepEqual(RoutingConfigurationSchema.parse(configuration), configuration);
  const changed = new RoutingPolicy({ configuration });
  const decision = changed.decide({ ...small, taskClass: 'retrieval' }, [
    ...catalog, { id: 'custom-retriever', supportedReasoningEfforts: ['low'] },
  ]);
  assert.deepEqual(decision.candidate, { model: 'custom-retriever', reasoningEffort: 'low' });
  assert.notEqual(changed.hash, policy.hash);
});

test('receipts have stable policy and input identities and reject ambiguous capability catalogs', () => {
  const decision = policy.decide(small, catalog);
  assert.deepEqual(RoutingDecisionSchema.parse(decision), decision);
  assert.deepEqual(policy.decide(small, catalog), new RoutingPolicy().decide({ ...small }, catalog));
  assert.equal(policy.decide({ taskClass: 'research' }).inputHash, policy.decide(TaskRoutingInputSchema.parse({ taskClass: 'research' })).inputHash);
  assert.notEqual(policy.decide({ ...small, risk: 'high' }).inputHash, decision.inputHash);
  assert.throws(() => policy.decide(small, [...catalog, catalog[0]!]), /duplicate IDs/);
});
