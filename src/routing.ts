import { createHash } from 'node:crypto';
import { z } from 'zod';

const LevelSchema = z.enum(['low', 'moderate', 'high']);
const NameSchema = z.string().trim().min(1);
const ExecutionTargetSchema = z.enum(['coordinator', 'worker']);
const EvidenceRefsSchema = z.array(z.string().trim().min(1).max(2000)).max(40);

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
  taskClass: z.enum(['deterministic', 'retrieval', 'implementation', 'review', 'research', 'defensive-security']),
  complexity: LevelSchema.default('high'),
  uncertainty: LevelSchema.default('high'),
  bounded: z.boolean().default(false),
  independentlyVerifiable: z.boolean().default(false),
  contextCoupling: LevelSchema.default('high'),
  risk: LevelSchema.default('high'),
  delegationBenefit: z.enum(['unknown', 'expected', 'observed']).default('unknown'),
  executionTarget: ExecutionTargetSchema.optional(),
  evidenceRefs: EvidenceRefsSchema.optional(),
  rationale: z.string().trim().min(1).max(2000).optional(),
  explicitRequestedModel: NameSchema.optional(),
  explicitRequestedReasoningEffort: NameSchema.optional(),
}).strict().refine(input => !input.explicitRequestedReasoningEffort || !!input.explicitRequestedModel, {
  message: 'An explicit reasoning effort requires an explicit model.',
  path: ['explicitRequestedModel'],
});
export type TaskRoutingInput = z.input<typeof TaskRoutingInputSchema>;

/** The orchestrator supplies these judgments; the owner never has to classify subtasks. */
export const TaskQualificationSchema = z.object({
  taskClass: z.enum(['retrieval', 'implementation', 'review', 'research', 'defensive-security']),
  complexity: LevelSchema, uncertainty: LevelSchema, risk: LevelSchema,
  bounded: z.boolean(), independentlyVerifiable: z.boolean(), contextCoupling: LevelSchema,
  delegationBenefit: z.enum(['unknown', 'expected', 'observed']),
  executionTarget: ExecutionTargetSchema.optional(), evidenceRefs: EvidenceRefsSchema.optional(),
  rationale: z.string().trim().min(1).max(2000),
  explicitRequestedModel: NameSchema.optional(), explicitRequestedReasoningEffort: NameSchema.optional(),
}).strict().refine(input => !input.explicitRequestedReasoningEffort || !!input.explicitRequestedModel, {
  message: 'An explicit reasoning effort requires an explicit model.', path: ['explicitRequestedModel'],
});
export type TaskQualification = z.infer<typeof TaskQualificationSchema>;

export const RoutingConfigurationSchema = z.object({
  version: z.literal(1), coordinator: ModelSelectionSchema,
  specialists: z.object({
    retrieval: ModelSelectionSchema, implementation: ModelSelectionSchema,
    analysisLow: ModelSelectionSchema, analysis: ModelSelectionSchema, defensive: ModelSelectionSchema,
  }).strict(),
}).strict();
export type RoutingConfiguration = z.infer<typeof RoutingConfigurationSchema>;
export const DEFAULT_ROUTING_CONFIGURATION: RoutingConfiguration = {
  version: 1, coordinator: { model: 'gpt-6-astra', reasoningEffort: 'ultra' },
  specialists: {
    retrieval: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    implementation: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    analysisLow: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    analysis: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    defensive: { model: 'gpt-daybreak-blue-latest', reasoningEffort: 'high' },
  },
};

export const RoutingDecisionSchema = z.object({
  status: z.enum(['deterministic', 'candidate', 'blocked']),
  assignment: z.enum(['none', 'coordinator', 'delegate']),
  candidate: ModelSelectionSchema.nullable(),
  reason: z.string().min(1),
  rule: z.enum(['deterministic', 'defensive-primary', 'explicit-request', 'coordinator', 'bounded-retrieval', 'bounded-implementation', 'separable-analysis', 'separable-strong-worker']),
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
export interface RoutingPolicyOptions { coordinator?: ModelSelection; configuration?: RoutingConfiguration; configurationSource?: 'profile-file' | 'built-in-default' | 'snapshot' }

export const ROUTING_POLICY_VERSION = '3.0.0';

/** Pure preflight policy. It makes no model calls, dispatches, retries, or authorization changes. */
export class RoutingPolicy {
  readonly version = ROUTING_POLICY_VERSION;
  readonly coordinator: Readonly<ModelSelection>;
  readonly hash: string;
  readonly configuration: RoutingConfiguration;
  readonly configurationSource: NonNullable<RoutingPolicyOptions['configurationSource']>;
  private readonly specialists: RoutingConfiguration['specialists'];

  constructor(options: RoutingPolicyOptions = {}) {
    this.configuration = RoutingConfigurationSchema.parse(options.configuration ?? DEFAULT_ROUTING_CONFIGURATION);
    this.configurationSource = options.configurationSource ?? (options.configuration ? 'snapshot' : 'built-in-default');
    if (options.coordinator) this.configuration.coordinator = ModelSelectionSchema.parse(options.coordinator);
    if (this.configuration.specialists.defensive.model !== 'gpt-daybreak-blue-latest') {
      throw new Error('Routing configuration cannot replace the primary defensive specialist.');
    }
    this.specialists = this.configuration.specialists;
    this.coordinator = Object.freeze({ ...this.configuration.coordinator });
    this.hash = this.digest({ version: this.version, coordinator: this.coordinator, specialists: this.specialists });
  }

  decide(raw: TaskRoutingInput, availableModels?: readonly RuntimeModelCapability[]): RoutingDecision {
    const input = TaskRoutingInputSchema.parse(raw);
    const workerRequirementFailure = input.executionTarget === 'worker' ? this.workerRequirementFailure(input) : null;
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
    } else if (workerRequirementFailure) {
      if(input.explicitRequestedModel)return {...decision,status:'blocked',assignment:'none',candidate:null,reason:workerRequirementFailure+' The explicitly requested model was not replaced.'};
      decision.reason = workerRequirementFailure;
    } else if (input.explicitRequestedModel) {
      decision.rule = 'explicit-request';
      decision.candidate = {
        model: input.explicitRequestedModel,
        reasoningEffort: input.explicitRequestedReasoningEffort ?? this.decide({
          ...input, explicitRequestedModel: undefined, explicitRequestedReasoningEffort: undefined,
        }).candidate!.reasoningEffort,
      };
      decision.assignment = decision.candidate.model === this.coordinator.model ? 'coordinator' : 'delegate';
      decision.reason = 'Use the explicitly requested model; no replacement is permitted if its capability is unavailable.';
      if (input.executionTarget === 'worker') decision.assignment = 'delegate';
    } else if (input.executionTarget === 'coordinator') {
      decision.reason = 'Keep the task with the coordinator because the qualified execution target is coordinator.';
    } else {
      const separable = input.bounded && input.independentlyVerifiable && input.contextCoupling === 'low';
      const benefit = input.delegationBenefit !== 'unknown';
      if (!separable) {
        decision.reason = 'Keep the task with the coordinator: delegation requires a bounded, independently verifiable task with low context coupling.';
      } else if (!benefit) {
        decision.reason = 'Keep the task with the coordinator: a delegation benefit has not been identified.';
      } else if (input.executionTarget === 'worker' && (input.complexity === 'high' || input.uncertainty === 'high') && input.risk !== 'high') {
        decision.rule = 'separable-strong-worker';
        decision.assignment = 'delegate';
        decision.candidate = { ...this.coordinator };
        decision.reason = 'Use the configured strong model as a bounded worker executor for separable high-complexity or high-uncertainty work. The caller remains the coordinator; this is not an owner model override.';
      } else if (input.complexity === 'high' || input.uncertainty === 'high' || input.risk === 'high') {
        decision.reason = 'Keep this high-complexity, high-uncertainty, or high-risk task with the coordinator; define a smaller subtask before delegating.';
      } else if (input.taskClass === 'retrieval' && input.complexity === 'low' && input.uncertainty === 'low' && input.risk === 'low') {
        decision.rule = 'bounded-retrieval';
        decision.assignment = 'delegate';
        decision.candidate = { ...this.specialists.retrieval };
        decision.reason = 'Use the configured retrieval specialist for bounded source lookup/extraction with independent verification. Deterministic lookups should use a tool directly.';
      } else if (input.taskClass === 'implementation' && input.complexity === 'low' && input.uncertainty === 'low' && input.risk === 'low') {
        decision.rule = 'bounded-implementation';
        decision.assignment = 'delegate';
        decision.candidate = { ...this.specialists.implementation };
        decision.reason = `Use the configured implementation specialist for bounded, low-risk work with independent verification and ${input.delegationBenefit} delegation benefit.`;
      } else if (['retrieval', 'review', 'research', 'implementation'].includes(input.taskClass)) {
        decision.rule = 'separable-analysis';
        decision.assignment = 'delegate';
        const low = input.complexity === 'low' && input.uncertainty === 'low' && input.risk === 'low';
        decision.candidate = { ...(low ? this.specialists.analysisLow : this.specialists.analysis) };
        decision.reason = `Use the configured ${low ? 'low-complexity' : 'moderate-complexity'} analysis specialist for this separable task with ${input.delegationBenefit} delegation benefit.`;
      }
    }

    if (availableModels === undefined) return decision;
    const catalog = z.array(RuntimeModelCapabilitySchema).parse(availableModels);
    if (new Set(catalog.map(model => model.id)).size !== catalog.length) throw new Error('Runtime model catalog contains duplicate IDs.');
    const missing = this.missingCapability(decision.candidate!, catalog);
    if (!missing) return { ...decision, evidenceLevel: 'runtime-validated', requiresCapabilityValidation: false, capabilityValidation: 'matched' };

    // An unavailable executor must not silently change either the selected model or execution role.
    return { ...decision, status: 'blocked', assignment: 'none', candidate: null,
      reason: `${missing} No permitted fallback is available; a new routing decision is required before execution.`,
      requiresCapabilityValidation: false, capabilityValidation: 'unavailable' };
  }

  private workerRequirementFailure(input: z.output<typeof TaskRoutingInputSchema>): string | null {
    if (input.risk === 'high') return 'Keep the task with the coordinator: high-risk work must not open a worker.';
    if (input.contextCoupling !== 'low') return `Keep the task with the coordinator: worker execution requires low context coupling; received ${input.contextCoupling}.`;
    if (!input.bounded) return 'Keep the task with the coordinator: worker execution requires a bounded task.';
    if (!input.independentlyVerifiable) return 'Keep the task with the coordinator: worker execution requires an independently verifiable result.';
    if (input.delegationBenefit === 'unknown') return 'Keep the task with the coordinator: worker execution requires a known delegation benefit.';
    if (!input.evidenceRefs?.length) return 'Keep the task with the coordinator: worker execution requires concrete evidence references.';
    return null;
  }

  private missingCapability(candidate: Readonly<ModelSelection>, catalog: RuntimeModelCapability[]): string | null {
    const model = catalog.find(model => model.id === candidate.model);
    if (!model) return `Requested model ${candidate.model} is absent from the supplied runtime catalog.`;
    return model.supportedReasoningEfforts.includes(candidate.reasoningEffort) ? null
      : `Requested effort ${candidate.reasoningEffort} is unavailable for ${candidate.model} in the supplied runtime catalog.`;
  }

  private digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
