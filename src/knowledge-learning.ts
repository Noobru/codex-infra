import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvaluationStore } from './evaluation.js';
import { ObservationReader } from './observability.js';
import { InteractionIdSchema, InteractionStore } from './interactions.js';
import type { ContextSource, ProjectContext } from './registry.js';
import { EvidenceSanitizer } from './evidence.js';
import { isSubPath } from './legacy/command-os-utils.js';
import { KnowledgeFiles, KnowledgeAuthorSchema, KnowledgeDecisionSchema, KnowledgeOwnerDecisionSchema,
  KnowledgeTextSchema, KnowledgeEvidenceSchema, KnowledgeHashSchema, KnowledgeProjectSchema } from './knowledge-store.js';

export const KnowledgeJobOriginSchema = z.object({ jobId: z.uuid(), attempt: z.number().int().positive(), evaluationId: z.uuid().optional() }).strict();
export const KnowledgeInteractionOriginSchema = z.object({ interactionId: InteractionIdSchema, revision: z.number().int().positive() }).strict();
export const KnowledgeOriginSchema = z.union([KnowledgeJobOriginSchema, KnowledgeInteractionOriginSchema]);
export const KnowledgeProposalSchema = z.object({
  projectId: KnowledgeProjectSchema, origin: KnowledgeOriginSchema, title: KnowledgeTextSchema,
  kind: z.enum(['script', 'skill', 'practice']), content: z.string().min(1).max(64000),
  author: KnowledgeAuthorSchema, source: KnowledgeTextSchema,
});
export const KnowledgeReviewSchema = KnowledgeDecisionSchema.extend({ decision: z.enum(['approved', 'rejected']) });
export const KnowledgeShadowSchema = KnowledgeDecisionSchema.extend({ jobId: z.uuid(), attempt: z.number().int().positive(), evaluationId: z.uuid() });
export const KnowledgeCandidateSchema = KnowledgeProposalSchema.extend({
  version: z.literal(1), id: z.uuid(), revision: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(['proposed', 'reviewed', 'rejected', 'shadow-passed', 'shadow-failed', 'promoted', 'reverted']),
  contentHash: KnowledgeHashSchema, contentPath: z.string(), artifactPath: z.string(),
  originEvidence: z.object({ refs: z.array(z.string()), checkResults: z.array(z.object({ checkId: z.string(), passed: z.boolean() })), jobStatusAtCapture: z.string() }),
  review: KnowledgeReviewSchema.extend({ recordedAt: z.iso.datetime() }).nullable(),
  shadow: KnowledgeShadowSchema.extend({ recordedAt: z.iso.datetime(), status: z.enum(['passed', 'failed']), contentBound: z.literal(true), checkIds: z.array(z.string()) }).nullable(),
  promotion: KnowledgeDecisionSchema.extend({ recordedAt: z.iso.datetime(), path: z.string(), contentHash: KnowledgeHashSchema }).nullable(),
  reversal: KnowledgeDecisionSchema.extend({ recordedAt: z.iso.datetime(), previousPromotionRevision: z.number().int().positive() }).nullable(),
});
export type KnowledgeCandidate = z.output<typeof KnowledgeCandidateSchema>;
export type KnowledgeProposal = z.input<typeof KnowledgeProposalSchema>;

/** Candidates and releases are inert local artifacts; state changes require explicit calls. */
export class KnowledgeLearningStore {
  private readonly files: KnowledgeFiles;
  private readonly evaluations: EvaluationStore;
  constructor(readonly root: string) { this.files = new KnowledgeFiles(root); this.evaluations = new EvaluationStore(root); }

  async propose(input: KnowledgeProposal): Promise<KnowledgeCandidate> {
    const proposal = KnowledgeProposalSchema.parse(input);
    if (EvidenceSanitizer.text(proposal.content, 64000) !== proposal.content) throw new Error('Proposal content contains material that cannot be preserved in ordinary evidence.');
    const originEvidence = await this.originEvidence(proposal);
    const id = randomUUID(), recordedAt = new Date().toISOString();
    const contentPath = `artifacts/learning/candidates/${id}/proposal.txt`;
    const candidate = KnowledgeCandidateSchema.parse({ ...proposal, version: 1, id, revision: 1, createdAt: recordedAt, updatedAt: recordedAt,
      status: 'proposed', contentHash: KnowledgeFiles.hash(proposal.content), contentPath, artifactPath: this.revisionPath(id, 1),
      originEvidence,
      review: null, shadow: null, promotion: null, reversal: null });
    await this.files.writeNew(contentPath, candidate.content);
    await this.files.writeJsonNew(candidate.artifactPath, candidate);
    return candidate;
  }

  async read(id: string, revision?: number): Promise<KnowledgeCandidate> {
    z.uuid().parse(id);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const names = revision === undefined ? await this.files.names(`artifacts/learning/candidates/${id}`) : [];
    const revisions = names.filter(name => /^revision-\d{6}\.json$/.test(name));
    const relative = revision === undefined ? `artifacts/learning/candidates/${id}/${revisions.at(-1) ?? 'missing.json'}` : this.revisionPath(id, revision);
    const candidate = await this.files.read(relative, KnowledgeCandidateSchema);
    if (candidate.id !== id || (revision !== undefined && candidate.revision !== revision)) throw new Error('Candidate identity differs from its record.');
    return candidate;
  }

  async list(projectId?: string): Promise<{ items: KnowledgeCandidate[]; warnings: string[] }> {
    if (projectId) KnowledgeProjectSchema.parse(projectId);
    const items: KnowledgeCandidate[] = [], warnings: string[] = [];
    for (const id of await this.files.names('artifacts/learning/candidates')) {
      if (!z.uuid().safeParse(id).success) continue;
      try { const item = await this.read(id); if (!projectId || item.projectId === projectId) items.push(item); }
      catch { warnings.push(`${id}: candidate record unavailable.`); }
    }
    return { items, warnings };
  }

  async review(id: string, input: z.input<typeof KnowledgeReviewSchema>): Promise<KnowledgeCandidate> {
    const decision = KnowledgeReviewSchema.parse(input), current = await this.read(id);
    if (current.status === 'promoted') throw new Error('Revert the active release before revising its review.');
    return this.append(current, { status: decision.decision === 'approved' ? 'reviewed' : 'rejected',
      review: { ...decision, recordedAt: new Date().toISOString() }, shadow: null });
  }

  async shadow(id: string, input: z.input<typeof KnowledgeShadowSchema>): Promise<KnowledgeCandidate> {
    const request = KnowledgeShadowSchema.parse(input), current = await this.read(id);
    if (current.status === 'promoted' || current.review?.decision !== 'approved') throw new Error('Shadow validation requires an approved review of an inactive candidate.');
    const evaluation = await this.boundEvaluation(current.projectId, request);
    const observation = await this.observation(request.jobId);
    const attempt = observation.attempts.find(item => item.attempt === request.attempt);
    const contextPath = `artifacts/jobs/${request.jobId}/attempt-${request.attempt}/context-pack.json`;
    const context = await this.files.read(contextPath, z.object({ sources: z.array(z.object({ path: z.string(), sha256: KnowledgeHashSchema })) }));
    const candidatePath = await this.files.file(current.contentPath);
    await this.verifyContent(current);
    if (!context.sources.some(source => KnowledgeFiles.samePath(source.path, candidatePath) && source.sha256 === current.contentHash)) {
      throw new Error('Shadow attempt did not capture the exact candidate content.');
    }
    const criteria = evaluation.technical.criteria;
    const confirmed = criteria.length > 0 && criteria.every(criterion => {
      const matching = attempt?.checks?.filter(check => check.checkId === criterion.checkId) ?? [];
      return matching.length === 1 && matching[0]!.passed && matching[0]!.exitCode === criterion.exitCode;
    });
    const passed = evaluation.technical.status === 'passed' && evaluation.technical.criticalGateStatus === 'passed' && confirmed;
    return this.append(current, { status: passed ? 'shadow-passed' : 'shadow-failed', shadow: { ...request,
      recordedAt: new Date().toISOString(), status: passed ? 'passed' : 'failed', contentBound: true, checkIds: criteria.map(item => item.checkId) } });
  }

  async promote(id: string, input: z.input<typeof KnowledgeOwnerDecisionSchema>): Promise<KnowledgeCandidate> {
    const decision = KnowledgeOwnerDecisionSchema.parse(input), current = await this.read(id);
    if (current.status !== 'shadow-passed' || current.review?.decision !== 'approved' || current.shadow?.status !== 'passed') throw new Error('Promotion requires approved review and confirmed shadow validation.');
    await this.verifyContent(current);
    const extension = current.kind === 'script' ? 'script.txt' : current.kind === 'skill' ? 'SKILL.md' : 'practice.md';
    const releasePath = `artifacts/learning/releases/${id}/revision-${current.revision + 1}/${extension}`;
    await this.files.writeNew(releasePath, current.content);
    return this.append(current, { status: 'promoted', reversal: null, promotion: { ...decision, path: releasePath,
      contentHash: current.contentHash, recordedAt: new Date().toISOString() } });
  }

  async revert(id: string, input: z.input<typeof KnowledgeOwnerDecisionSchema>): Promise<KnowledgeCandidate> {
    const decision = KnowledgeOwnerDecisionSchema.parse(input), current = await this.read(id);
    if (current.status !== 'promoted') throw new Error('Only an active promoted candidate can be reverted.');
    return this.append(current, { status: 'reverted', reversal: { ...decision, recordedAt: new Date().toISOString(), previousPromotionRevision: current.revision } });
  }

  async shadowSource(id: string): Promise<ContextSource> {
    const candidate = await this.read(id);
    await this.verifyContent(candidate);
    return this.source(candidate, candidate.contentPath, `Shadow candidate ${id}`, 'research');
  }

  async promotedSources(projectId: string): Promise<ContextSource[]> {
    const inventory = await this.list(projectId);
    if (inventory.warnings.length) throw new Error('Promoted candidate inventory is incomplete.');
    const sources: ContextSource[] = [];
    for (const candidate of inventory.items.filter(item => item.status === 'promoted')) {
      const promoted = candidate.promotion!;
      const file = await this.files.file(promoted.path);
      if (KnowledgeFiles.hash(await fs.readFile(file)) !== candidate.contentHash) throw new Error('Promoted content has changed; review a new candidate.');
      sources.push(this.source(candidate, promoted.path, `Learned ${candidate.title} [${candidate.id}]`, 'pattern'));
    }
    return sources;
  }

  async augmentContext(context: ProjectContext): Promise<ProjectContext> {
    const sources = await this.promotedSources(context.projectId);
    const original = context.sources.filter(source => !isSubPath(source.path, path.join(this.root, 'artifacts/learning/releases')));
    return { ...context, sources: [...original, ...sources.filter(source => !original.some(existing => KnowledgeFiles.samePath(existing.path, source.path)))] };
  }

  private source(candidate: KnowledgeCandidate, relative: string, label: string, knowledgeClass: 'research' | 'pattern'): ContextSource {
    return { path: path.resolve(this.root, relative), label, kind: 'reference', sha256: candidate.contentHash,
      modifiedAt: candidate.updatedAt, totalChars: candidate.content.length, excerpt: candidate.content.slice(0, 12000),
      truncated: candidate.content.length > 12000, knowledgeStatus: 'active', knowledgeClass };
  }
  private async originEvidence(proposal: KnowledgeProposal): Promise<KnowledgeCandidate['originEvidence']> {
    const origin = proposal.origin;
    if ('interactionId' in origin) {
      const interaction = await new InteractionStore(this.root).read(origin.interactionId, origin.revision);
      if (interaction.projectId !== null && interaction.projectId !== proposal.projectId) throw new Error('Candidate origin belongs to another project.');
      // A general conversation can inform a proposed destination. This explicit project is the
      // author's intent, not evidence of applicability or technical acceptance for that project.
      return {refs: [...new Set([interaction.artifactPath, ...interaction.evidence])], checkResults: [],
        jobStatusAtCapture: 'interaction-declared:' + interaction.status};
    }
    const observation = await this.observation(origin.jobId);
    if (observation.summary.projectId !== proposal.projectId) throw new Error('Candidate origin belongs to another project.');
    const attempt = observation.attempts.find(item => item.attempt === origin.attempt);
    if (!attempt) throw new Error('Candidate origin attempt was not observed.');
    if (origin.evaluationId) await this.boundEvaluation(proposal.projectId, origin);
    const refs = observation.evidence.filter(ref => ref.includes(`/attempt-${origin.attempt}/`));
    if (origin.evaluationId) refs.push(`artifacts/evaluations/${origin.evaluationId}.json`);
    return {refs, checkResults: attempt.checks?.map(check => ({checkId: check.checkId, passed: check.passed})) ?? [],
      jobStatusAtCapture: observation.summary.status};
  }
  private async observation(jobId: string) { const reader = new ObservationReader(this.root); try { return await reader.run(jobId); } finally { reader.close(); } }
  private async boundEvaluation(projectId: string, origin: { jobId: string; attempt: number; evaluationId?: string }) {
    if (!origin.evaluationId) throw new Error('An evaluation receipt is required.');
    const evaluation = await this.evaluations.read(origin.evaluationId);
    if (evaluation.projectId !== projectId || evaluation.jobId !== origin.jobId || evaluation.attempt !== origin.attempt) throw new Error('Evaluation does not match the candidate project and attempt.');
    return evaluation;
  }
  private async verifyContent(candidate: KnowledgeCandidate): Promise<void> {
    if (KnowledgeFiles.hash(await fs.readFile(await this.files.file(candidate.contentPath))) !== candidate.contentHash) throw new Error('Candidate content changed after its recorded proposal.');
  }
  private revisionPath(id: string, revision: number): string { return `artifacts/learning/candidates/${id}/revision-${String(revision).padStart(6, '0')}.json`; }
  private async append(current: KnowledgeCandidate, patch: Partial<KnowledgeCandidate>): Promise<KnowledgeCandidate> {
    const next = KnowledgeCandidateSchema.parse({ ...current, ...patch, revision: current.revision + 1,
      updatedAt: new Date().toISOString(), artifactPath: this.revisionPath(current.id, current.revision + 1) });
    await this.files.writeJsonNew(next.artifactPath, next);
    return next;
  }
}
