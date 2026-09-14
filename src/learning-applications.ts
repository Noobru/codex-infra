import fs from 'node:fs/promises';
import { z } from 'zod';
import { KnowledgeLearningStore, type KnowledgeCandidate } from './knowledge-learning.js';
import { KnowledgeDecisionSchema, KnowledgeFiles, KnowledgeHashSchema, KnowledgeProjectSchema } from './knowledge-store.js';
import { InteractionIdSchema, InteractionStore } from './interactions.js';
import { InteractionTelemetry, InteractionTelemetryReceiptSchema, InteractionTokenDeltaSchema, type InteractionTelemetryReceipt } from './interaction-telemetry.js';
import { PerformanceScopeSchema } from './performance-scope.js';
import { deterministicUuid } from './legacy/command-os-utils.js';
import { TurnComparison } from './turn-comparison.js';

export const LearningApplicationInputSchema = KnowledgeDecisionSchema.extend({ candidateId: z.uuid(), threadId: z.uuid(), turnId: z.uuid() }).strict();
export const LearningApplicationReceiptSchema = LearningApplicationInputSchema.extend({
  version: z.literal(1), id: z.uuid(), recordedAt: z.iso.datetime(), artifactPath: z.string(),
  classification: z.literal('declared-application'),
  candidateRevision: z.number().int().positive(), candidateArtifactPath: z.string(), contentHash: KnowledgeHashSchema,
  promotion: z.object({ recordedAt: z.iso.datetime(), path: z.string(), contentHash: KnowledgeHashSchema }),
  interactionId: InteractionIdSchema, interactionRevision: z.number().int().positive().nullable(),
  projectId: KnowledgeProjectSchema.nullable(), performanceScope: PerformanceScopeSchema.nullable(),
  assignment: InteractionTelemetryReceiptSchema.shape.assignment, turnStartedAt: z.iso.datetime(),
  turnTelemetry: z.object({ artifactPath: z.string(), sourceFingerprint: KnowledgeHashSchema, statusAtCapture: InteractionTelemetryReceiptSchema.shape.status }),
});
export type LearningApplicationInput = z.input<typeof LearningApplicationInputSchema>;
export type LearningApplicationReceipt = z.output<typeof LearningApplicationReceiptSchema>;
type Scope = z.output<typeof PerformanceScopeSchema>;
type Metric = keyof z.output<typeof InteractionTokenDeltaSchema>;
const metricKeys = Object.keys(InteractionTokenDeltaSchema.shape) as Metric[];
const limits = { applications: 2000, candidateRevisions: 1000 };

export interface LearningTokenEffectGroup {
  id: string; status: 'pending' | 'observed'; projectId: string | null; performanceScope: Scope | null;
  modelIdentity: InteractionTelemetryReceipt['modelIdentity'];
  promotion: LearningApplicationReceipt['promotion'] & { candidateRevision: number; candidateArtifactPath: string };
  baseline: { n: number; before: string; turnIds: string[]; evidence: string[] };
  treatment: { n: number; turnIds: string[]; applicationIds: string[]; pendingApplicationIds: string[]; evidence: string[] };
  metrics: { metric: Metric; unit: 'tokens'; baselineN: number; treatmentN: number; baselineMean: number | null;
    treatmentMean: number | null; delta: number | null; deltaPercent: number | null }[];
  warnings: string[];
}

/** Declared use binds an existing release to an observed turn; it never proves correct execution or promotes content. */
export class LearningApplications {
  private readonly files: KnowledgeFiles;
  private readonly learning: KnowledgeLearningStore;
  private readonly telemetry: InteractionTelemetry;
  constructor(readonly root: string) {
    this.files = new KnowledgeFiles(root); this.learning = new KnowledgeLearningStore(root); this.telemetry = new InteractionTelemetry(root);
  }

  async record(raw: LearningApplicationInput): Promise<LearningApplicationReceipt> {
    const input = LearningApplicationInputSchema.parse(raw);
    const id = deterministicUuid('learning-application/v1', JSON.stringify([input.candidateId, input.threadId, input.turnId]));
    const artifactPath = this.applicationPath(id);
    const existing = (await this.files.names('artifacts/learning/applications')).includes(`${id}.json`)
      ? await this.files.read(artifactPath, LearningApplicationReceiptSchema) : null;
    if (existing) return this.sameInput(existing, input);
    const interactionId = InteractionStore.idFor({ threadId: input.threadId });
    const interaction = await new InteractionStore(this.root).read(interactionId);
    if (interaction.threadId !== input.threadId || interaction.locallyUpdatedAt === null) throw new Error('Application requires a locally entered registered interaction.');
    const inventory = await this.telemetry.read();
    const turn = inventory.turnReceipts.find(item => item.threadId === input.threadId && item.turnId === input.turnId);
    if (!turn || turn.interactionId !== interactionId) throw new Error('Application requires an existing telemetry receipt for the exact registered turn; capture it first.');
    const history = await this.candidateHistory(input.candidateId);
    const candidate = [...history].reverse().find(item => Date.parse(item.updatedAt) <= Date.parse(turn.startedAt));
    if (!candidate || candidate.status !== 'promoted' || !candidate.promotion || Date.parse(candidate.promotion.recordedAt) > Date.parse(turn.startedAt)) {
      throw new Error('Candidate was not an active promoted release when this turn started.');
    }
    if (turn.projectId !== null && turn.projectId !== candidate.projectId) throw new Error('Application turn belongs to another project.');
    const promotion = candidate.promotion;
    if (promotion.contentHash !== candidate.contentHash || KnowledgeFiles.hash(await fs.readFile(await this.files.file(promotion.path))) !== candidate.contentHash) {
      throw new Error('Promoted release content differs from its recorded hash.');
    }
    const receipt = LearningApplicationReceiptSchema.parse({ ...input, version: 1, id, recordedAt: new Date().toISOString(), artifactPath,
      classification: 'declared-application', candidateRevision: candidate.revision, candidateArtifactPath: candidate.artifactPath,
      contentHash: candidate.contentHash, promotion: { recordedAt: promotion.recordedAt, path: promotion.path, contentHash: promotion.contentHash },
      interactionId, interactionRevision: turn.interactionRevision, projectId: turn.projectId, performanceScope: turn.performanceScope,
      assignment: turn.assignment, turnStartedAt: turn.startedAt,
      turnTelemetry: { artifactPath: turn.artifactPath, sourceFingerprint: turn.source.fingerprint, statusAtCapture: turn.status },
    });
    try { await this.files.writeJsonNew(artifactPath, receipt); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.sameInput(await this.files.read(artifactPath, LearningApplicationReceiptSchema), input);
    }
    return receipt;
  }

  async read(raw: { projectId?: string } = {}) {
    const { projectId } = z.object({ projectId: KnowledgeProjectSchema.optional() }).strict().parse(raw);
    const applications: LearningApplicationReceipt[] = [], warnings: string[] = [];
    const names = (await this.files.names('artifacts/learning/applications')).filter(name => z.uuid().safeParse(name.replace(/\.json$/, '')).success && name.endsWith('.json'));
    const selected = names.slice(0, limits.applications), truncated = selected.length < names.length;
    for (const name of selected) {
      try {
        const receipt = await this.files.read(`artifacts/learning/applications/${name}`, LearningApplicationReceiptSchema);
        if (receipt.artifactPath !== this.applicationPath(receipt.id) || `${receipt.id}.json` !== name
          || receipt.interactionId !== InteractionStore.idFor({ threadId: receipt.threadId })) throw new Error('Application identity mismatch');
        if (projectId === undefined || receipt.projectId === projectId) applications.push(receipt);
      } catch { warnings.push('One learning application receipt is unavailable or invalid.'); }
    }
    if (truncated) warnings.push('Learning application inventory exceeded the read limit.');
    applications.sort((a, b) => b.turnStartedAt.localeCompare(a.turnStartedAt) || a.id.localeCompare(b.id));
    return { applications, warnings: [...new Set(warnings)], truncated };
  }

  async getEffects(candidateId: string) {
    z.uuid().parse(candidateId);
    const [history, declared, telemetry] = await Promise.all([this.candidateHistory(candidateId), this.read(), this.telemetry.read()]);
    return this.projectEffects(candidateId, history, declared, telemetry);
  }

  /** Dashboard aggregation shares the application and telemetry inventories across all requested candidates. */
  async readEffects(raw: string[]) {
    const candidateIds = [...new Set(z.array(z.uuid()).max(100).parse(raw))];
    const [declared, telemetry] = await Promise.all([this.read(), this.telemetry.read()]);
    const results = await Promise.allSettled(candidateIds.map(async candidateId =>
      this.projectEffects(candidateId, await this.candidateHistory(candidateId), declared, telemetry)));
    const effects: ReturnType<LearningApplications['projectEffects']>[] = [], warnings: string[] = [...declared.warnings, ...telemetry.warnings];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') effects.push(result.value);
      else warnings.push(`Candidate ${candidateIds[index]}: learning token effects could not be read.`);
    }
    return { effects, warnings: [...new Set(warnings)] };
  }

  private projectEffects(candidateId: string, history: KnowledgeCandidate[], declared: Awaited<ReturnType<LearningApplications['read']>>,
    telemetry: Awaited<ReturnType<InteractionTelemetry['read']>>) {
    const firstPromotion = history.find(item => item.status === 'promoted' && item.promotion !== null);
    const applications = declared.applications.filter(item => item.candidateId === candidateId), groups: LearningTokenEffectGroup[] = [];
    const complete = TurnComparison.unique(telemetry.turnReceipts.filter(turn => TurnComparison.complete(turn)));
    const byTurn = new Map(complete.map(turn => [JSON.stringify([turn.threadId, turn.turnId]), turn]));
    const grouped = new Map<string, LearningApplicationReceipt[]>();
    for (const application of applications) {
      const turn = byTurn.get(JSON.stringify([application.threadId, application.turnId]));
      const key = JSON.stringify([application.promotion.path, application.contentHash, application.projectId, application.performanceScope, turn ? TurnComparison.cohort(turn) : null]);
      grouped.set(key, [...(grouped.get(key) ?? []), application]);
    }
    for (const [key, uses] of grouped) {
      const exemplar = uses[0]!, before = firstPromotion?.promotion?.recordedAt ?? exemplar.promotion.recordedAt;
      const observedTurn = byTurn.get(JSON.stringify([exemplar.threadId, exemplar.turnId]));
      const cohort = observedTurn ? TurnComparison.cohort(observedTurn) : null;
      const validScope = exemplar.projectId !== null && exemplar.performanceScope !== null && cohort !== null;
      const baseline = validScope ? complete.filter(turn => turn.projectId === exemplar.projectId && this.sameScope(turn.performanceScope, exemplar.performanceScope)
        && TurnComparison.cohort(turn) === cohort
        && Date.parse(turn.finishedAt!) < Date.parse(before)) : [];
      const measured: { application: LearningApplicationReceipt; turn: InteractionTelemetryReceipt }[] = [];
      const pending: string[] = [];
      for (const application of uses) {
        const turn = byTurn.get(JSON.stringify([application.threadId, application.turnId]));
        if (validScope && turn && turn.projectId === application.projectId && this.sameScope(turn.performanceScope, application.performanceScope)
          && TurnComparison.cohort(turn) === cohort
          && turn.startedAt === application.turnStartedAt && Date.parse(turn.startedAt) >= Date.parse(application.promotion.recordedAt)) measured.push({ application, turn });
        else pending.push(application.id);
      }
      const metrics = TurnComparison.compare(baseline, measured.map(item => item.turn));
      const comparableMetric = metrics.some(metric => metric.baselineN > 0 && metric.treatmentN > 0);
      groups.push({ id: KnowledgeFiles.hash(key), status: comparableMetric ? 'observed' : 'pending',
        projectId: exemplar.projectId, performanceScope: exemplar.performanceScope,
        modelIdentity: observedTurn?.modelIdentity ?? null,
        promotion: { ...exemplar.promotion, candidateRevision: exemplar.candidateRevision, candidateArtifactPath: exemplar.candidateArtifactPath },
        baseline: { n: baseline.length, before, turnIds: baseline.map(turn => turn.turnId), evidence: baseline.map(turn => turn.artifactPath) },
        treatment: { n: measured.length, turnIds: measured.map(item => item.turn.turnId), applicationIds: uses.map(item => item.id),
          pendingApplicationIds: pending, evidence: [...new Set([...uses.flatMap(item => [item.artifactPath, item.candidateArtifactPath, item.promotion.path, ...item.evidence]),
            ...measured.map(item => item.turn.artifactPath)])] }, metrics,
        warnings: [...(!validScope ? ['A project, declared performance scope and observed model/effort are required for comparable token measurements.'] : []),
          ...(!baseline.length ? ['No complete comparable baseline turn was observed before the first promotion.'] : []),
          ...(!measured.length ? ['No complete comparable turn with an explicit application was observed.'] : []),
          ...(baseline.length && measured.length && !comparableMetric ? ['No token metric was observed in both baseline and treatment.'] : [])] });
    }
    return { candidateId, status: groups.some(group => group.status === 'observed') ? 'observed' as const : 'pending' as const,
      groups, coverage: { applications: applications.length, completeTurns: complete.length, truncated: declared.truncated || telemetry.truncated },
      warnings: [...new Set([...declared.warnings, ...telemetry.warnings, ...(!firstPromotion ? ['Candidate has no recorded promotion.'] : []),
        ...(!applications.length ? ['No explicit application has been recorded for this candidate.'] : [])])],
      limitations: ['Application is a declaration supported by supplied evidence; it does not prove correct execution or acceptance.',
        'Before/after means use distinct complete turn deltas within the same project and exact declared performance scope. Each metric has its own sample count; missing values remain unknown.',
        'Baseline turns must finish before the first promotion, including after later re-promotions. Post-promotion turns require an explicit application of the corresponding release.',
        'Token differences are observed associations, not causal effects. Other changes, task difficulty, quality and acceptance are not controlled by this comparison.',
        'Tokens are not account quota, currency or verified savings. Negative deltas mean fewer observed tokens per turn, not proven improvement.'] };
  }

  private sameInput(existing: LearningApplicationReceipt, input: z.output<typeof LearningApplicationInputSchema>) {
    if (JSON.stringify(LearningApplicationInputSchema.strip().parse(existing)) !== JSON.stringify(input)) throw new Error('Application identity is already bound to different declaration input.');
    return existing;
  }
  private applicationPath(id: string) { return `artifacts/learning/applications/${id}.json`; }
  private sameScope(left: Scope | null, right: Scope | null) { return JSON.stringify(left) === JSON.stringify(right); }
  private async candidateHistory(candidateId: string): Promise<KnowledgeCandidate[]> {
    const latest = await this.learning.read(candidateId);
    if (latest.revision > limits.candidateRevisions) throw new Error('Candidate history exceeds the learning application read limit.');
    const records: KnowledgeCandidate[] = [];
    for (let revision = 1; revision <= latest.revision; revision++) records.push(revision === latest.revision ? latest : await this.learning.read(candidateId, revision));
    return records;
  }
}
