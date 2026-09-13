import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ObservationReader } from './observability.js';
import { EvidenceSanitizer } from './evidence.js';
import { atomicWriteJson, atomicWriteNew, deterministicUuid, readJson, resolveRealSubPath } from './legacy/command-os-utils.js';

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const text = z.string().trim().min(1).max(2000).transform(value => EvidenceSanitizer.text(value, 2000));
const evidence = z.array(text).min(1).max(50);
const author = z.object({ name: text, role: z.enum(['owner', 'reviewer', 'model']) });
const sample = z.object({ size: z.number().int().positive(), representative: z.boolean(), selection: text });
const window = z.object({ start: z.iso.datetime(), end: z.iso.datetime() })
  .refine(value => Date.parse(value.end) >= Date.parse(value.start), 'Window end precedes start.');
const metricMetadata = {
  id: identifier, unit: text, method: text, source: text, cohort: text,
  window, version: text, sample,
};

/** Missing measurements are represented explicitly; estimates require their hypothesis. */
export const EvaluationMetricSchema = z.discriminatedUnion('classification', [
  z.object({ ...metricMetadata, classification: z.literal('observed'), value: z.number().finite() }),
  z.object({ ...metricMetadata, classification: z.literal('estimated'), value: z.number().finite(), estimateBasis: text }),
  z.object({
    id: identifier, classification: z.literal('unknown'), value: z.null().default(null), reason: text,
    unit: text.nullable().default(null), method: text.nullable().default(null), source: text.nullable().default(null),
    cohort: text.nullable().default(null), window: window.nullable().default(null), version: text.nullable().default(null),
    sample: sample.nullable().default(null),
  }),
]);
export const EvaluationAcceptanceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-recorded') }),
  z.object({
    status: z.enum(['accepted', 'rejected']),
    author: z.object({ name: text, role: z.literal('owner') }), source: text, evidence,
  }),
]);
export const EvaluationRubricSchema = z.object({
  id: identifier, version: text,
  criteria: z.array(z.object({ id: identifier, checkId: identifier, critical: z.boolean() })).min(1).max(100),
}).refine(value => new Set(value.criteria.map(item => item.id)).size === value.criteria.length, 'Rubric criterion IDs must be unique.');
const inputFields = {
  jobId: z.uuid(), attempt: z.number().int().positive(), taskClass: identifier,
  author, source: text, evidence, rubric: EvaluationRubricSchema,
  acceptance: EvaluationAcceptanceSchema.default({ status: 'not-recorded' }),
  metrics: z.array(EvaluationMetricSchema).max(100).default([]),
};
export const EvaluationInputSchema = z.object(inputFields)
  .refine(value => new Set(value.metrics.map(item => item.id)).size === value.metrics.length, 'Metric IDs must be unique.');
const gateStatus = z.enum(['passed', 'failed', 'unknown']);
export const EvaluationReceiptSchema = z.object({
  ...inputFields, version: z.literal(1), id: z.uuid(), recordedAt: z.iso.datetime(), artifactPath: z.string(),
  projectId: text,
  technical: z.object({
    status: gateStatus, criticalGateStatus: gateStatus,
    jobStatusAtRecord: text, jobCompletedAtRecord: z.boolean(), observedAt: z.iso.datetime(),
    checksEvidence: text.nullable(), taskContractHash: text.nullable(),
    criteria: z.array(z.object({
      id: identifier, checkId: identifier, critical: z.boolean(), status: gateStatus,
      exitCode: z.number().int().nullable(), cleanupFailed: z.boolean().nullable(),
    })),
    warnings: z.array(text),
  }),
});
export const EvaluationCompareInputSchema = z.object({ baselineId: z.uuid(), treatmentId: z.uuid(), metricId: identifier });

export type EvaluationInput = z.input<typeof EvaluationInputSchema>;
export type EvaluationReceipt = z.output<typeof EvaluationReceiptSchema>;
export type EvaluationMetric = z.output<typeof EvaluationMetricSchema>;
export type EvaluationCompareInput = z.input<typeof EvaluationCompareInputSchema>;
export interface EvaluationComparison {
  version: 1; baselineId: string; treatmentId: string; metricId: string;
  status: 'compared' | 'not-comparable' | 'unknown'; reason: string;
  baseline: EvaluationMetric | null; treatment: EvaluationMetric | null;
  absoluteDelta: number | null; percentageChange: number | null; percentageReason: string;
  acceptedDeliveryComparison: boolean;
  method: 'treatment-minus-baseline/v1'; limitations: string[];
}

/** Explicit evaluations are immutable files; queue and attempt evidence are read-only. */
export class EvaluationStore {
  private readonly directory: string;
  constructor(readonly root: string) { this.directory = path.join(root, 'artifacts/evaluations'); }

  async record(input: EvaluationInput): Promise<EvaluationReceipt> {
    const receipt = await this.buildReceipt(input, randomUUID());
    await atomicWriteJson(await this.destination(receipt.id), receipt);
    return receipt;
  }

  /** A source-derived key makes repeated hooks/backfills exclusive without changing explicit recordings. */
  async recordOnce(input: EvaluationInput, idempotencyKey: string): Promise<{receipt: EvaluationReceipt; created: boolean}> {
    z.string().min(1).max(2000).parse(idempotencyKey);
    const id = deterministicUuid('evaluation/v1', idempotencyKey);
    const parsed = EvaluationInputSchema.parse(input);
    const existing = async () => {
      const receipt = await this.read(id);
      if (JSON.stringify(EvaluationInputSchema.parse(receipt)) !== JSON.stringify(parsed)) {
        throw new Error('Evaluation idempotency key is already bound to different input.');
      }
      return {receipt, created: false};
    };
    try { await fs.access(path.join(this.directory, `${id}.json`)); return await existing(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const receipt = await this.buildReceipt(parsed, id);
    try { await atomicWriteNew(await this.destination(id), JSON.stringify(receipt, null, 2) + '\n'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return existing(); throw error; }
    return {receipt, created: true};
  }

  private async destination(id: string): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true });
    const ownedDirectory = await resolveRealSubPath(this.directory, this.root);
    if (!ownedDirectory) throw new Error('Evaluation directory must remain inside the infrastructure root.');
    return path.join(ownedDirectory, `${id}.json`);
  }

  private async buildReceipt(input: EvaluationInput, id: string): Promise<EvaluationReceipt> {
    const parsed = EvaluationInputSchema.parse(input);
    const reader = new ObservationReader(this.root);
    let observation;
    try { observation = await reader.run(parsed.jobId); }
    finally { reader.close(); }
    const attempt = observation.attempts.find(item => item.attempt === parsed.attempt);
    if (!attempt) throw new Error('The requested attempt has no canonical observation; no evaluation was written.');
    const criteria = parsed.rubric.criteria.map(criterion => {
      const matches = attempt.checks?.filter(check => check.checkId === criterion.checkId) ?? [];
      const check = matches.length === 1 ? matches[0] : undefined;
      return {
        ...criterion, status: check ? check.passed ? 'passed' as const : 'failed' as const : 'unknown' as const,
        exitCode: check?.exitCode ?? null, cleanupFailed: check?.cleanupFailed ?? null,
      };
    });
    const checksReference = `artifacts/jobs/${parsed.jobId}/attempt-${parsed.attempt}/checks.json`;
    const receipt = EvaluationReceiptSchema.parse({
      ...parsed, version: 1, id, recordedAt: new Date().toISOString(),
      artifactPath: `artifacts/evaluations/${id}.json`, projectId: observation.summary.projectId,
      technical: {
        status: this.gateStatus(criteria), criticalGateStatus: this.gateStatus(criteria.filter(criterion => criterion.critical)),
        jobStatusAtRecord: observation.summary.status, jobCompletedAtRecord: observation.summary.completedTechnical,
        observedAt: observation.observedAt,
        checksEvidence: observation.evidence.includes(checksReference) ? checksReference : null,
        taskContractHash: attempt.taskContract?.hash ?? null, criteria, warnings: observation.warnings,
      },
    });
    return receipt;
  }

  async read(id: string): Promise<EvaluationReceipt> {
    z.uuid().parse(id);
    const file = await resolveRealSubPath(path.join(this.directory, `${id}.json`), this.root);
    if (!file) throw new Error('Evaluation receipt was not found inside the infrastructure root.');
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Evaluation receipt exceeds the read budget.');
    const receipt = EvaluationReceiptSchema.parse(await readJson(file, null));
    if (receipt.id !== id) throw new Error('Evaluation receipt ID does not match its file.');
    return receipt;
  }

  /** A bounded inventory of persisted evaluations; malformed records remain visible as warnings. */
  async list(options: {projectId?: string; includeProject?:(id:string)=>boolean; limit?: number; offset?: number} = {}) {
    const limit = z.number().int().min(1).max(100).parse(options.limit ?? 50);
    const offset = z.number().int().nonnegative().parse(options.offset ?? 0);
    const warnings: string[] = [];
    const records: EvaluationReceipt[] = [];
    let names: string[];
    try { names = (await fs.readdir(this.directory)).filter(name => z.uuid().safeParse(name.replace(/\.json$/, '')).success && name.endsWith('.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {items: records, total: 0, offset, limit, nextOffset: null, warnings, truncated: false}; throw error; }
    const entries = await Promise.all(names.map(async name => ({name, modified: (await fs.stat(path.join(this.directory, name))).mtimeMs})));
    entries.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    const inspected = entries.slice(0, 500);
    for (const entry of inspected) {
      try { const receipt = await this.read(entry.name.slice(0, -5)); if ((!options.projectId || receipt.projectId === options.projectId)&&(!options.includeProject||options.includeProject(receipt.projectId))) records.push(receipt); }
      catch { warnings.push(`${entry.name}: evaluation could not be read.`); }
    }
    records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
    return {items: records.slice(offset, offset + limit), total: records.length, offset, limit,
      nextOffset: offset + limit < records.length ? offset + limit : null, warnings, truncated: names.length > inspected.length};
  }

  async compare(input: EvaluationCompareInput): Promise<EvaluationComparison> {
    const parsed = EvaluationCompareInputSchema.parse(input);
    const [baseline, treatment] = await Promise.all([this.read(parsed.baselineId), this.read(parsed.treatmentId)]);
    const left = baseline.metrics.find(metric => metric.id === parsed.metricId) ?? null;
    const right = treatment.metrics.find(metric => metric.id === parsed.metricId) ?? null;
    const comparison: EvaluationComparison = {
      version: 1, ...parsed, status: 'unknown', reason: 'The selected metric is absent or unknown.',
      baseline: left, treatment: right, absoluteDelta: null, percentageChange: null,
      percentageReason: 'A comparable, observed, representative and positive baseline is required.',
      acceptedDeliveryComparison: false,
      method: 'treatment-minus-baseline/v1',
      limitations: ['A difference is descriptive, not proof of causal improvement or quota savings.',
        'Owner acceptance is an explicit sourced declaration, not inferred from job completion or model judgment.',
        'No composite score, weighting, promotion or policy change is performed.'],
    };
    if ([baseline, treatment].some(receipt => receipt.technical.criticalGateStatus === 'failed')) {
      return { ...comparison, status: 'not-comparable', reason: 'A critical gate failed; a metric cannot compensate for it.' };
    }
    if ([baseline, treatment].some(receipt => receipt.technical.criticalGateStatus === 'unknown')) {
      return { ...comparison, reason: 'Critical gate evidence is unknown.' };
    }
    if (!left || !right || left.classification === 'unknown' || right.classification === 'unknown') return comparison;
    if (baseline.taskClass !== treatment.taskClass || baseline.rubric.id !== treatment.rubric.id || baseline.rubric.version !== treatment.rubric.version
      || left.classification !== right.classification || left.cohort !== right.cohort || left.unit !== right.unit
      || left.method !== right.method || left.version !== right.version) {
      return { ...comparison, status: 'not-comparable', reason: 'Task class, rubric, measurement class, cohort, unit, method and version must match.' };
    }
    const absoluteDelta = right.value - left.value;
    const percentageChange = left.classification === 'observed' && left.value > 0 && left.sample.representative
      ? absoluteDelta / left.value * 100 : null;
    return {
      ...comparison, status: 'compared', reason: 'Compatible signal snapshots; delta is treatment minus baseline.',
      absoluteDelta, percentageChange,
      acceptedDeliveryComparison: baseline.acceptance.status === 'accepted' && treatment.acceptance.status === 'accepted'
        && baseline.technical.status === 'passed' && treatment.technical.status === 'passed',
      percentageReason: percentageChange === null ? comparison.percentageReason : 'Observed positive baseline; sample representativeness was explicitly declared with its selection method.',
    };
  }

  private gateStatus(criteria: { status: z.infer<typeof gateStatus> }[]): z.infer<typeof gateStatus> {
    if (criteria.some(criterion => criterion.status === 'failed')) return 'failed';
    return criteria.some(criterion => criterion.status === 'unknown') ? 'unknown' : 'passed';
  }
}
