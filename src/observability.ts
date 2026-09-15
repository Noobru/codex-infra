import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { StateStore, type Job, type JobStatus } from './state.js';
import { EvidenceSanitizer } from './evidence.js';
import { readJson, resolveRealSubPath } from './legacy/command-os-utils.js';
import { RoutingDecisionSchema } from './routing.js';
import {PerformanceScopeSchema} from './performance-scope.js';
import {WorkPopulations,WorkPopulationSchema,type WorkPopulation} from './work-population.js';
import {createHash} from 'node:crypto';
import {OutcomeCriterionSchema} from './outcome.js';

const shortText = z.string().transform(value => EvidenceSanitizer.text(value, 400));
const measuredNumber = z.number().finite().nonnegative();
const tokenUsage = z.object({
  inputTokens: measuredNumber.nullish(), cachedInputTokens: measuredNumber.nullish(),
  outputTokens: measuredNumber.nullish(), reasoningOutputTokens: measuredNumber.nullish(), totalTokens: measuredNumber.nullish(),
}).transform(value => Object.values(value).some(item => typeof item === 'number') ? value : null);
const quotaWindow = z.object({ usedPercent: measuredNumber, windowDurationMins: measuredNumber.nullish(), resetsAt: measuredNumber.nullish() });
const quotaBucket = z.object({ limitId: shortText.nullish(), primary: quotaWindow.nullish(), secondary: quotaWindow.nullish() });
const quota = z.object({ rateLimits: quotaBucket.nullish(), rateLimitsByLimitId: z.record(z.string(), quotaBucket).nullish() });
const workerSchema = z.object({
  status: shortText, threadId: shortText.nullish(), turnId: shortText.nullish(),
  receipt: z.object({
    startedAt: shortText.nullish(), finishedAt: shortText.nullish(), model: shortText.nullish(), reasoningEffort: shortText.nullish(),
    terminalStatus: shortText.nullish(), cleanupConfirmed: z.boolean().nullish(),
    tokenUsage: tokenUsage.nullish(), tokenUsageScope: shortText.nullish(), quotaAtAdmission: quota.nullish(), routingDecision: z.unknown().optional(),
  }).optional(),
});
const checksSchema = z.array(z.object({
  checkId: shortText, exitCode: z.number().int().nullable(), durationMs: measuredNumber.nullish(), cleanupFailed: z.boolean().optional(),
}));
const contractSchema = z.object({
  version: z.number().int(), hash: shortText, kind: z.enum(['checks', 'codex']), mode: z.enum(['read-only', 'workspace-write']),
  checkIds: z.array(shortText), requirementIds: z.array(shortText).optional(),
  details: z.object({ outcomeCriteria:z.array(OutcomeCriterionSchema).optional(),acceptanceCriteria: z.array(z.unknown()).optional(), constraints: z.array(z.unknown()).optional(), nonGoals: z.array(z.unknown()).optional(),performanceScope:PerformanceScopeSchema.optional() }).optional(),
}).transform(value => ({
  version: value.version, hash: value.hash, kind: value.kind, mode: value.mode,
  checkIds: value.checkIds.slice(0, 100), requirementIds: value.requirementIds?.slice(0, 100) ?? [],
  acceptanceCriteriaCount: value.details?.acceptanceCriteria?.length ?? null,
  performanceScope:value.details?.performanceScope??null,
  ...(value.details?.outcomeCriteria?{outcomeCriterionIds:value.details.outcomeCriteria.map(c=>c.id),outcomeContractHash:createHash('sha256').update(JSON.stringify(value.details.outcomeCriteria)).digest('hex')}:{}),
  constraintsCount: value.details?.constraints?.length ?? null, nonGoalsCount: value.details?.nonGoals?.length ?? null,
}));
const contextSchema = z.object({
  version: z.number().int(), hash: shortText, selectorVersion: shortText, capturedAt: shortText,
  taskContractHash: shortText, profileHash: shortText,
  sources: z.array(z.object({ label:shortText.optional(),sha256:shortText.optional(),selectionReason:shortText.optional(),requiresFullRead: z.boolean().optional() })), excludedSources: z.array(z.unknown()),
  governance:z.object({decisionRefs:z.object({unresolved:z.array(shortText)}),conflicts:z.array(z.object({sourceLabel:shortText,targetLabel:shortText,ordering:shortText,resolution:shortText})),diagnostics:z.array(shortText)}).optional(),
  budget: z.object({ limitChars: measuredNumber, includedChars: measuredNumber, availableChars: measuredNumber }),
}).transform(value => ({
  version: value.version, hash: value.hash, selectorVersion: value.selectorVersion, capturedAt: value.capturedAt,
  taskContractHash: value.taskContractHash, profileHash: value.profileHash, budget: value.budget,
  selectedSources: value.sources.length, excludedSources: value.excludedSources.length,
  sourcesRequiringFullRead: value.sources.filter(source => source.requiresFullRead).length,
  provenance:value.sources.slice(0,100),governance:value.governance??null,
}));
const capabilitySchema=z.object({version:z.number(),hash:shortText,
  capabilities:z.array(z.object({id:shortText,kind:shortText,purpose:shortText,stage:shortText,required:z.boolean(),availability:shortText,dependsOn:z.array(shortText)})).max(100),
  gates:z.array(z.object({stage:shortText,ready:z.boolean(),reasons:z.array(shortText)})),
  decisions:z.array(z.object({id:shortText,question:shortText,stage:shortText,status:shortText,material:z.boolean()})).max(40),
});
const policySchema=z.object({version:z.number(),policyVersion:shortText,effects:z.array(z.object({action:shortText,decision:shortText,reason:shortText,capturedAt:shortText,result:shortText.optional()})).max(500)});
const routingSchema = RoutingDecisionSchema.pick({
  status: true, assignment: true, candidate: true, reason: true, rule: true, policyVersion: true, policyHash: true,
  evidenceLevel: true, requiresCapabilityValidation: true, capabilityValidation: true,
}).transform(value => ({ ...value, reason: EvidenceSanitizer.text(value.reason, 1200),
  candidate: value.candidate ? { model: EvidenceSanitizer.text(value.candidate.model, 120), reasoningEffort: EvidenceSanitizer.text(value.candidate.reasoningEffort, 40) } : null,
}));
const manifestSchema = z.object({ kind: z.enum(['checks', 'codex']), checkIds: z.array(shortText), taskContract: contractSchema.optional() });
const knowledgeSchema=z.object({indexId:shortText,graph:z.object({maxHops:z.number(),expandedLabels:z.array(shortText),traversed:z.array(z.unknown())})})
  .transform(value=>({indexId:value.indexId,maxHops:value.graph.maxHops,expandedLabels:value.graph.expandedLabels,edgesTraversed:value.graph.traversed.length}));
const handoffSchema=z.object({jobId:shortText,handoffs:z.array(z.object({jobId:shortText,projectId:shortText,attempt:z.number(),summary:shortText,checksSha256:shortText}))});
const insightsSchema=z.object({version:z.literal(1),jobId:z.uuid(),attempt:z.number().int().positive(),recordedAt:shortText,
  status:z.enum(['processed','attention']),evaluationIds:z.array(z.uuid()),created:z.number().int().nonnegative(),reused:z.number().int().nonnegative(),warnings:z.array(shortText)});
const statuses: JobStatus[] = ['ready', 'running', 'validating', 'waiting_user', 'waiting_quota', 'failed', 'cancelled', 'completed'];

export interface ObservationSummary {
  id: string; projectId: string; objectiveExcerpt: string; mode: Job['mode']; status: JobStatus;
  createdAt: string; updatedAt: string; attempts: number; retriesObserved: number;
  completedTechnical: boolean; accepted: null; elapsedWallClockMs: number | null;
  durationBasis: 'created-to-last-update' | 'created-to-observation'; resultSummary: string | null; errorSummary: string | null;
}
export interface ObservationOverviewOptions { projectId?: string; population?:WorkPopulation; limit?: number; offset?: number; status?: string; query?: string; sort?: 'newest' | 'oldest' }
export interface ObservationRunOptions { afterEventId?: number; limit?: number }

/** Reads the canonical queue and bounded owned receipts. No writes, job dispatch, or acceptance inference. */
export class ObservationReader {
  private readonly state: StateStore;
  private readonly artifactsRoot: string;
  private readonly maxArtifactBytes = 8 * 1024 * 1024;
  private readonly maxAttempts = 50;

  constructor(readonly root: string) {
    this.state = new StateStore(path.join(root, 'state/jobs.sqlite'), { readOnly: true });
    this.artifactsRoot = path.join(root, 'artifacts/jobs');
  }

  async overview(options: ObservationOverviewOptions = {}) {
    const limit = this.pageNumber(options.limit, 20, 100, true);
    const offset = this.pageNumber(options.offset, 0, Number.MAX_SAFE_INTEGER);
    const observedAt = new Date().toISOString();
    const population=WorkPopulationSchema.parse(options.population??'all'),groups=await WorkPopulations.read(this.root);
    const scope = this.state.list().filter(job => options.projectId === undefined || job.projectId === options.projectId).reverse();
    const selected=scope.filter(job=>groups.includes(job.projectId,population));
    const byStatus = Object.fromEntries(statuses.map(status => [status, selected.filter(job => job.status === status).length])) as Record<JobStatus, number>;
    if (options.status && !['all', 'waiting', ...statuses].includes(options.status)) throw new Error('Invalid status filter');
    const matching = selected.filter(job => (!options.status || options.status === 'all' || (options.status === 'waiting' ? job.status.startsWith('waiting_') : job.status === options.status))
      && (!options.query || `${job.id} ${job.projectId} ${EvidenceSanitizer.text(job.objective, 400)}`.toLowerCase().includes(options.query.toLowerCase())));
    matching.sort((a, b) => (options.sort === 'oldest' ? 1 : -1) * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    return {
      observedAt, projectId: options.projectId ?? null,
      filters:{status:options.status??'all',query:options.query??'',sort:options.sort??'newest',population},
      populations:['operational','fixture','learning','unclassified'].map(category=>({category,total:scope.filter(job=>groups.category(job.projectId)===category).length,failed:scope.filter(job=>groups.category(job.projectId)===category&&job.status==='failed').length})),
      classificationWarnings:groups.warnings,
      scopeTotal: selected.length,
      page: { limit, offset, total: matching.length, nextOffset: offset + limit < matching.length ? offset + limit : null },
      counts: { byStatus, completedTechnical: byStatus.completed, accepted: null,
        retriesObserved: selected.reduce((count, job) => count + Math.max(0, job.attempts - 1), 0) },
      runs: matching.slice(offset, offset + limit).map(job => ({...this.summary(job, observedAt),population:groups.category(job.projectId)})),
      unknown: { ownerMinutes: null, cost: null, efficiency: null },
      limitations: ['Completion is the recorded technical state, not owner acceptance.', 'Duration is elapsed wall clock and includes waiting; it is not human effort or model compute time.', 'Model turns, tokens, and quota are shown only in run receipts when observed.'],
    };
  }

  async run(jobId: string, options: ObservationRunOptions = {}) {
    const limit = this.pageNumber(options.limit, 50, 200, true);
    const afterEventId = this.pageNumber(options.afterEventId, 0, Number.MAX_SAFE_INTEGER);
    const job = this.state.get(jobId);
    const observedAt = new Date().toISOString();
    const pendingEvents = this.state.events(job.id).filter(event => event.id > afterEventId);
    const events = pendingEvents.slice(0, limit).map(event => ({
      id: event.id, createdAt: event.createdAt, fromStatus: event.fromStatus, toStatus: event.toStatus,
      action: EvidenceSanitizer.text(event.detail.action, 80),
      fields: event.detail.fields?.slice(0, 20).map(field => EvidenceSanitizer.text(field, 80)) ?? [],
      reason: event.detail.reason ? EvidenceSanitizer.text(event.detail.reason, 400) : null,
    }));
    const evidence: string[] = [], warnings: string[] = [];
    const manifest = await this.artifact(job.id, 'manifest.json', manifestSchema, evidence, warnings);
    const preparedContext = await this.artifact(job.id, 'context-pack.json', contextSchema, evidence, warnings);
    const preparedCapability = await this.artifact(job.id, 'capability-plan.json', capabilitySchema, evidence, warnings);
    const attempts = [];
    for (let attempt = Math.max(1, job.attempts - this.maxAttempts + 1); attempt <= job.attempts; attempt++) {
      const prefix = `attempt-${attempt}/`;
      const worker = await this.artifact(job.id, prefix + 'worker.json', workerSchema, evidence, warnings);
      const checks = await this.artifact(job.id, prefix + 'checks.json', checksSchema, evidence, warnings);
      const contract = await this.artifact(job.id, prefix + 'task-contract.json', contractSchema, evidence, warnings);
      const context = await this.artifact(job.id, prefix + 'context-pack.json', contextSchema, evidence, warnings);
      const preparedRouting = await this.artifact(job.id, prefix + 'routing.json', routingSchema, evidence, warnings);
      const capabilityPlan = await this.artifact(job.id, prefix + 'capability-plan.json', capabilitySchema, evidence, warnings);
      const policy = await this.artifact(job.id, prefix + 'policy.json', policySchema, evidence, warnings);
      const knowledge=await this.artifact(job.id,prefix+'knowledge.json',knowledgeSchema,evidence,warnings);
      const handoffs=await this.artifact(job.id,prefix+'handoffs.json',handoffSchema,evidence,warnings);
      const insights=await this.artifact(job.id,prefix+'insights.json',insightsSchema,evidence,warnings);
      const outcome=await this.artifact(job.id,prefix+'outcome.json',z.object({version:z.literal(1),taskContractHash:shortText,status:z.enum(['passed','failed','not-recorded']),criteria:z.array(z.object({id:shortText,status:z.enum(['passed','failed']),reason:shortText})).max(40)}),evidence,warnings);
      const actualRouting = routingSchema.safeParse(worker?.receipt?.routingDecision);
      if (worker?.receipt?.routingDecision !== undefined && !actualRouting.success) warnings.push(`${prefix}worker.json: runtime routing evidence is invalid.`);
      const receipt = worker?.receipt;
      attempts.push({
        attempt,
        worker: worker ? {
          status: worker.status, threadId: worker.threadId ?? null, turnId: worker.turnId ?? null,
          model: receipt?.model ?? null, reasoningEffort: receipt?.reasoningEffort ?? null,
          startedAt: receipt?.startedAt ?? null, finishedAt: receipt?.finishedAt ?? null,
          elapsedWallClockMs: this.elapsed(receipt?.startedAt, receipt?.finishedAt),
          terminalStatus: receipt?.terminalStatus ?? null, cleanupConfirmed: receipt?.cleanupConfirmed ?? null,
          tokenUsage: receipt?.tokenUsage ?? null, tokenUsageScope: receipt?.tokenUsageScope ?? null,
          quotaAtAdmission: this.quotaObservation(receipt?.quotaAtAdmission),
        } : null,
        checks: checks?.slice(0, 100).map(check => ({
          checkId: check.checkId, exitCode: check.exitCode, durationMs: check.durationMs ?? null,
          passed: check.exitCode === 0 && check.cleanupFailed !== true, cleanupFailed: check.cleanupFailed ?? false,
        })) ?? null,
        checksObserved: checks?.length ?? null, checksTruncated: (checks?.length ?? 0) > 100,
        taskContract: contract, contextPack: context,capabilityPlan,policy,knowledge,handoffs,insights,outcome,
        routing: actualRouting.success ? actualRouting.data : preparedRouting,
        routingSource: actualRouting.success ? 'worker-receipt' as const : preparedRouting ? 'prepared-decision' as const : null,
      });
    }
    const turns = new Set(attempts.map(attempt => attempt.worker?.turnId).filter((id): id is string => !!id));
    if (job.attempts > this.maxAttempts) warnings.push(`Only the latest ${this.maxAttempts} attempts were inspected.`);
    return {
      observedAt, summary: this.summary(job, observedAt),
      events: { items: events, afterEventId, limit, nextAfterEventId: pendingEvents.length > limit ? events.at(-1)!.id : null },
      prepared: { kind: manifest?.kind ?? null, checkIds: manifest?.checkIds.slice(0, 100) ?? null,
        taskContract: manifest?.taskContract ?? null, contextPack: preparedContext,capabilityPlan:preparedCapability },
      attempts,
      observations: { modelTurnsObserved: turns.size, attemptsInspected: attempts.length, attemptsTruncated: job.attempts > this.maxAttempts,
        tokenReceiptsObserved: attempts.filter(attempt => attempt.worker?.tokenUsage != null).length,
        accepted: null, ownerMinutes: null, cost: null, efficiency: null },
      evidence, warnings,
      limitations: ['Receipts are observations, not estimates; missing tokens and quota stay unknown.', 'Thread-cumulative token receipts must not be summed across attempts or interpreted as per-attempt usage.', 'Admission quota is an account snapshot, not this task\'s consumption.', 'Model-turn counts cover distinct turn IDs in the inspected receipts, not unrecorded work.', 'Wall-clock duration includes waiting; technical completion does not establish owner acceptance.'],
    };
  }

  close(): void { this.state.close(); }

  projectActivity() {
    const jobs = this.state.list();
    return [...new Set(jobs.map(job => job.projectId))].map(projectId => {
      const selected = jobs.filter(job => job.projectId === projectId);
      const last = selected.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]!;
      return {projectId, total: selected.length, completed: selected.filter(job => job.status === 'completed').length,
        active: selected.filter(job => ['ready','running','validating','waiting_user','waiting_quota'].includes(job.status)).length,
        latestId: last.id, updatedAt: last.updatedAt};
    });
  }

  private summary(job: Job, observedAt: string): ObservationSummary {
    const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
    return {
      id: job.id, projectId: job.projectId, objectiveExcerpt: EvidenceSanitizer.text(job.objective, 400),
      mode: job.mode, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, attempts: job.attempts,
      retriesObserved: Math.max(0, job.attempts - 1), completedTechnical: job.status === 'completed', accepted: null,
      elapsedWallClockMs: this.elapsed(job.createdAt, terminal ? job.updatedAt : observedAt),
      durationBasis: terminal ? 'created-to-last-update' : 'created-to-observation',
      resultSummary: job.result === null ? null : EvidenceSanitizer.text(job.result, 1500),
      errorSummary: job.error === null ? null : EvidenceSanitizer.text(job.error, 1000),
    };
  }

  private quotaObservation(value: z.infer<typeof quota> | null | undefined) {
    if (!value) return null;
    const entries = value.rateLimitsByLimitId ? Object.entries(value.rateLimitsByLimitId).slice(0, 20)
      : value.rateLimits ? [[value.rateLimits.limitId ?? 'unknown', value.rateLimits] as const] : [];
    return entries.length ? entries.map(([id, bucket]) => ({
      limitId: EvidenceSanitizer.text(id, 120), primary: bucket.primary ?? null, secondary: bucket.secondary ?? null,
    })) : null;
  }

  private elapsed(from: string | null | undefined, to: string | null | undefined): number | null {
    if (!from || !to) return null;
    const elapsed = Date.parse(to) - Date.parse(from);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  private pageNumber(value: number | undefined, fallback: number, max: number, positive = false): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new Error('Pagination requires a nonnegative integer, with a positive limit.');
    return Math.min(value, max);
  }

  private async artifact<T>(jobId: string, relative: string, schema: z.ZodType<T>, evidence: string[], warnings: string[]): Promise<T | null> {
    const candidate = path.join(this.artifactsRoot, jobId, relative);
    const reference = path.posix.join('artifacts/jobs', jobId, relative);
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) { warnings.push(`${reference}: not a receipt file.`); return null; }
      const owned = await resolveRealSubPath(candidate, this.artifactsRoot);
      if (!owned) { warnings.push(`${reference}: receipt is outside the owned artifact directory.`); return null; }
      evidence.push(reference);
      if (stat.size > this.maxArtifactBytes) { warnings.push(`${reference}: exceeds the ${this.maxArtifactBytes}-byte observation limit.`); return null; }
      const parsed = schema.safeParse(await readJson(owned, null));
      if (!parsed.success) { warnings.push(`${reference}: receipt fields could not be validated.`); return null; }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${reference}: receipt could not be read.`);
      return null;
    }
  }
}

export type ObservationOverview = Awaited<ReturnType<ObservationReader['overview']>>;
export type RunObservation = Awaited<ReturnType<ObservationReader['run']>>;
