import { createHash } from 'node:crypto';
import { z } from 'zod';

const LevelSchema = z.enum(['low', 'moderate', 'high']);
const NameSchema = z.string().trim().min(1);

export const ModelSelectionSchema = z.object({
  model: NameSchema,
  reasoningEffort: NameSchema,
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const RuntimeModelCapabilitySchema = z.object({
  id: NameSchema,
  supportedReasoningEfforts: z.array(NameSchema),
});
export type RuntimeModelCapability = z.infer<typeof RuntimeModelCapabilitySchema>;

/** Omitted traits are conservative; a task needs positive evidence before delegation. */
export const TaskRoutingInputSchema = z.object({
  taskClass: z.enum(['deterministic', 'implementation', 'review', 'research', 'defensive-security']),
  complexity: LevelSchema.default('high'),
  uncertainty: LevelSchema.default('high'),
  bounded: z.boolean().default(false),
  independentlyVerifiable: z.boolean().default(false),
  contextCoupling: LevelSchema.default('high'),
  risk: LevelSchema.default('high'),
  delegationBenefit: z.enum(['unknown', 'expected', 'observed']).default('unknown'),
  explicitRequestedModel: NameSchema.optional(),
  explicitRequestedReasoningEffort: NameSchema.optional(),
}).strict().refine(input => !input.explicitRequestedReasoningEffort || !!input.explicitRequestedModel, {
  message: 'An explicit reasoning effort requires an explicit model.',
  path: ['explicitRequestedModel'],
});
export type TaskRoutingInput = z.input<typeof TaskRoutingInputSchema>;

export const RoutingDecisionSchema = z.object({
  status: z.enum(['deterministic', 'candidate', 'blocked']),
  assignment: z.enum(['none', 'coordinator', 'delegate']),
  candidate: ModelSelectionSchema.nullable(),
  reason: z.string().min(1),
  rule: z.enum(['deterministic', 'defensive-primary', 'explicit-request', 'coordinator', 'bounded-implementation', 'separable-analysis']),
  policyVersion: z.string(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  // This label confirms catalog capability only, never task quality or quota savings.
  evidenceLevel: z.enum(['hypothesis', 'runtime-validated']),
  requiresCapabilityValidation: z.boolean(),
  capabilityValidation: z.enum(['not-required', 'pending', 'matched', 'unavailable']),
  fallback: z.object({ from: ModelSelectionSchema, to: ModelSelectionSchema, reason: z.string() }).nullable(),
  limits: z.object({
    automaticRetries: z.literal(0),
    automaticEscalation: z.literal(false),
    fixedModelChain: z.literal(false),
  }),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;
export interface RoutingPolicyOptions { coordinator?: ModelSelection }

export const ROUTING_POLICY_VERSION = '1.0.0';

/** Pure preflight policy. It makes no model calls, dispatches, retries, or authorization changes. */
export class RoutingPolicy {
  readonly version = ROUTING_POLICY_VERSION;
  readonly coordinator: Readonly<ModelSelection>;
  readonly hash: string;
  private readonly specialists = {
    implementation: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    analysis: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    defensive: { model: 'gpt-daybreak-blue-latest', reasoningEffort: 'high' },
  } as const;

  constructor(options: RoutingPolicyOptions = {}) {
    this.coordinator = Object.freeze(ModelSelectionSchema.parse(options.coordinator ?? {
      model: 'gpt-6-astra', reasoningEffort: 'ultra',
    }));
    this.hash = this.digest({ version: this.version, coordinator: this.coordinator, specialists: this.specialists });
  }

  decide(raw: TaskRoutingInput, availableModels?: readonly RuntimeModelCapability[]): RoutingDecision {
    const input = TaskRoutingInputSchema.parse(raw);
    const decision: RoutingDecision = {
      status: 'candidate', assignment: 'coordinator', candidate: { ...this.coordinator },
      reason: 'Keep the task with the configured coordinator; delegation has not met the required conditions.',
      rule: 'coordinator', policyVersion: this.version, policyHash: this.hash, inputHash: this.digest(input),
      evidenceLevel: 'hypothesis', requiresCapabilityValidation: true, capabilityValidation: 'pending',
      fallback: null, limits: { automaticRetries: 0, automaticEscalation: false, fixedModelChain: false },
    };

    if (input.taskClass === 'deterministic') {
      return { ...decision, status: 'deterministic', assignment: 'none', candidate: null, rule: 'deterministic',
        reason: 'Run the canonical deterministic check without a model; a model override does not change this route.',
        requiresCapabilityValidation: false, capabilityValidation: 'not-required' };
    }

    if (input.taskClass === 'defensive-security') {
      decision.rule = 'defensive-primary';
      decision.assignment = 'delegate';
      decision.candidate = { ...this.specialists.defensive };
      decision.reason = 'Daybreak Blue is the primary defensive specialist; no silent defensive fallback is allowed.';
      if (input.explicitRequestedModel && input.explicitRequestedModel !== this.specialists.defensive.model) {
        return { ...decision, status: 'blocked', assignment: 'none', candidate: null,
          reason: 'Defensive work requires Daybreak Blue. A different requested model needs separate defensive fallback authorization; this policy does not grant it.' };
      }
      if (input.explicitRequestedReasoningEffort) decision.candidate.reasoningEffort = input.explicitRequestedReasoningEffort;
    } else if (input.explicitRequestedModel) {
      decision.rule = 'explicit-request';
      decision.candidate = {
        model: input.explicitRequestedModel,
        reasoningEffort: input.explicitRequestedReasoningEffort ?? this.defaultEffort(input.explicitRequestedModel),
      };
      decision.assignment = decision.candidate.model === this.coordinator.model ? 'coordinator' : 'delegate';
      decision.reason = 'Use the explicitly requested model; no replacement is permitted if its capability is unavailable.';
    } else {
      const separable = input.bounded && input.independentlyVerifiable && input.contextCoupling === 'low';
      const benefit = input.delegationBenefit !== 'unknown';
      if (!separable) {
        decision.reason = 'Keep the task with the coordinator: delegation requires a bounded, independently verifiable task with low context coupling.';
      } else if (!benefit) {
        decision.reason = 'Keep the task with the coordinator: a delegation benefit has not been identified.';
      } else if (input.complexity === 'high' || input.uncertainty === 'high' || input.risk === 'high') {
        decision.reason = 'Keep this high-complexity, high-uncertainty, or high-risk task with the coordinator; define a smaller subtask before delegating.';
      } else if (input.taskClass === 'implementation' && input.complexity === 'low' && input.uncertainty === 'low' && input.risk === 'low') {
        decision.rule = 'bounded-implementation';
        decision.assignment = 'delegate';
        decision.candidate = { ...this.specialists.implementation };
        decision.reason = `Luna is a candidate for this bounded, low-risk implementation with independent verification and ${input.delegationBenefit} delegation benefit.`;
      } else if (input.taskClass === 'review' || input.taskClass === 'research') {
        decision.rule = 'separable-analysis';
        decision.assignment = 'delegate';
        decision.candidate = { ...this.specialists.analysis };
        decision.reason = `Sol is a candidate for this separable analysis or review of at most moderate complexity, uncertainty, and risk with ${input.delegationBenefit} delegation benefit.`;
      }
    }

    if (availableModels === undefined) return decision;
    const catalog = z.array(RuntimeModelCapabilitySchema).parse(availableModels);
    if (new Set(catalog.map(model => model.id)).size !== catalog.length) throw new Error('Runtime model catalog contains duplicate IDs.');
    const missing = this.missingCapability(decision.candidate!, catalog);
    if (!missing) return { ...decision, evidenceLevel: 'runtime-validated', requiresCapabilityValidation: false, capabilityValidation: 'matched' };

    // This is a preflight fallback, not permission to retry or change models during a run.
    const canReturnToCoordinator = decision.rule === 'bounded-implementation' || decision.rule === 'separable-analysis';
    if (canReturnToCoordinator && !this.missingCapability(this.coordinator, catalog)) {
      const from = decision.candidate!;
      const reason = `${missing} Keep the task with the configured strong coordinator; no smaller substitute was selected.`;
      return { ...decision, assignment: 'coordinator', candidate: { ...this.coordinator }, reason,
        evidenceLevel: 'runtime-validated', requiresCapabilityValidation: false, capabilityValidation: 'matched',
        fallback: { from, to: { ...this.coordinator }, reason } };
    }
    return { ...decision, status: 'blocked', assignment: 'none', candidate: null,
      reason: `${missing} No permitted fallback is available; a new routing decision is required before execution.`,
      requiresCapabilityValidation: false, capabilityValidation: 'unavailable' };
  }

  private defaultEffort(model: string): string {
    if (model === this.coordinator.model) return this.coordinator.reasoningEffort;
    return Object.values(this.specialists).find(candidate => candidate.model === model)?.reasoningEffort ?? this.coordinator.reasoningEffort;
  }

  private missingCapability(candidate: Readonly<ModelSelection>, catalog: RuntimeModelCapability[]): string | null {
    const model = catalog.find(model => model.id === candidate.model);
    if (!model) return `Requested model ${candidate.model} is absent from the supplied runtime catalog.`;
    return model.supportedReasoningEfforts.includes(candidate.reasoningEffort) ? null
      : `Requested effort ${candidate.reasoningEffort} is unavailable for ${candidate.model} in the supplied runtime catalog.`;
  }

  private digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
