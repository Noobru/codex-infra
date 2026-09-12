import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EvidenceSanitizer } from './evidence.js';
import { KnowledgeFiles } from './knowledge-store.js';
import { ObservationReader, type RunObservation } from './observability.js';
import { OperationalInsights, type AttemptExecutionEvidence } from './operational-insights.js';
import { isSubPath } from './legacy/command-os-utils.js';

const policyVersion = 'rework-discovery/v1';
const optionsSchema = z.object({ projectId: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
const checksSchema = z.array(z.object({
  checkId: z.string().min(1).max(160), exitCode: z.number().int().nullable(),
  stdout: z.string().default(''), stderr: z.string().default(''), error: z.string().optional(),
  outputFiles: z.object({ stdout: z.string(), stderr: z.string() }).optional(), outputTruncated: z.boolean().optional(),
})).max(100);
const occurrenceSchema = z.object({ jobId: z.uuid(), attempt: z.number().int().positive(), checkId: z.string(), evidence: z.array(z.string()), diagnostic: z.string().optional() });
export const ReworkClusterSchema = z.object({
  id: z.string().regex(/^rework_[a-f0-9]{32}$/), projectId: z.string(), signature: z.string(), language: z.string().optional(),
  problemCategory: z.string(), summary: z.string(), occurrences: z.array(occurrenceSchema), distinctJobs: z.number().int().min(2), recommendation: z.string(),
});
const captureSchema = z.object({ version: z.literal(1), policyVersion: z.literal(policyVersion), recordedAt: z.iso.datetime(), cluster: ReworkClusterSchema });
export type ReworkCluster = z.output<typeof ReworkClusterSchema>;
export interface ReworkScan {
  clusters: ReworkCluster[]; jobsInspected: number; failuresInspected: number; unclassifiedFailures: number; warnings: string[]; truncated: boolean;
}
export interface ReworkCapture extends ReworkScan {
  captures: { clusterId: string; artifactPath: string; created: boolean }[]; created: number; reused: number;
}
type Diagnostic = { language: string; code: string; message: string; problemCategory: string };
type Budget = { bytes: number; truncated: boolean };

/** Evidence discovery across jobs. Diagnostic recurrence is a reason to investigate, never a proven common cause or fix. */
export class ReworkDiscovery {
  private readonly files: KnowledgeFiles;
  private readonly insights: OperationalInsights;
  constructor(readonly root: string) { this.files = new KnowledgeFiles(root); this.insights = new OperationalInsights(root); }

  /** Bounded read only: no evaluations, learning proposals, queue changes or command execution. */
  async scan(raw: { projectId?: string; limit?: number } = {}): Promise<ReworkScan> {
    const options = optionsSchema.parse(raw), reader = new ObservationReader(this.root);
    const result: ReworkScan = { clusters: [], jobsInspected: 0, failuresInspected: 0, unclassifiedFailures: 0, warnings: [], truncated: false };
    const grouped = new Map<string, Omit<ReworkCluster, 'distinctJobs'>>(), budget: Budget = { bytes: 8 * 1024 * 1024, truncated: false };
    try {
      const overview = await reader.overview(options); result.truncated = overview.page.nextOffset !== null;
      for (const job of overview.runs) {
        if (budget.bytes <= 0) { budget.truncated = true; break; }
        result.jobsInspected++;
        if (!job.attempts) continue;
        try {
          // The canonical processor supplies terminal windows and captured scopes; historical titles are never scopes.
          const execution = await this.insights.executionEvidence(job.id), run = await reader.run(job.id);
          result.warnings.push(...execution.warnings); result.truncated ||= execution.truncated;
          for (const attempt of execution.attempts) {
            if (!attempt.window) continue;
            const observed = run.attempts.find(item => item.attempt === attempt.attempt);
            if (!observed?.checks || observed.checksTruncated) { result.truncated ||= observed?.checksTruncated === true; continue; }
            const failedIds = observed.checks.filter(check => !check.passed).map(check => check.checkId);
            if (!failedIds.length) continue;
            await this.inspectAttempt(run, attempt, failedIds, grouped, budget, result);
          }
        } catch (error) { result.warnings.push(`${job.id}: ${this.error(error)}`); }
      }
    } finally { reader.close(); }
    result.clusters = [...grouped.values()].map(cluster => ({ ...cluster, distinctJobs: new Set(cluster.occurrences.map(item => item.jobId)).size }))
      .filter(cluster => cluster.distinctJobs >= 2)
      .map(cluster => ({ ...cluster, occurrences: cluster.occurrences.sort((a, b) => a.jobId.localeCompare(b.jobId) || a.attempt - b.attempt || a.checkId.localeCompare(b.checkId)) }))
      .map(cluster => ReworkClusterSchema.parse(cluster))
      .sort((a, b) => b.distinctJobs - a.distinctJobs || a.id.localeCompare(b.id));
    result.truncated ||= budget.truncated || result.clusters.length > options.limit;
    result.clusters = result.clusters.slice(0, options.limit);
    if (budget.truncated) result.warnings.push('Diagnostic output exceeded the bounded read budget; unobserved output remains unknown.');
    result.warnings = [...new Set(result.warnings)];
    return result;
  }

  /** Explicit/post-execution reconciliation persists immutable snapshots; the stable cluster ID survives additional jobs. */
  async reconcile(raw: { projectId?: string; limit?: number } = {}): Promise<ReworkCapture> {
    const result: ReworkCapture = { ...await this.scan(raw), captures: [], created: 0, reused: 0 };
    for (const cluster of result.clusters) {
      const artifactPath = `artifacts/rework/${cluster.id}/${KnowledgeFiles.hash(JSON.stringify(cluster))}.json`;
      let created = true;
      try { await this.files.writeJsonNew(artifactPath, { version: 1, policyVersion, recordedAt: new Date().toISOString(), cluster }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { result.warnings.push(`${cluster.id}: ${this.error(error)}`); continue; }
        const previous = await this.files.read(artifactPath, captureSchema);
        if (JSON.stringify(previous.cluster) !== JSON.stringify(cluster)) throw new Error('Rework snapshot identity differs from its evidence.');
        created = false;
      }
      result.captures.push({ clusterId: cluster.id, artifactPath, created });
      if (created) result.created++; else result.reused++;
    }
    return result;
  }

  private async inspectAttempt(run: RunObservation, attempt: AttemptExecutionEvidence, failedIds: string[],
    grouped: Map<string, Omit<ReworkCluster, 'distinctJobs'>>, budget: Budget, result: ReworkScan): Promise<void> {
    const prefix = `artifacts/jobs/${attempt.jobId}/attempt-${attempt.attempt}`, receiptPath = `${prefix}/checks.json`;
    const file = await this.files.file(receiptPath), size = (await fs.stat(file)).size;
    if (size > 4 * 1024 * 1024 || size > budget.bytes) { budget.truncated = true; return; }
    budget.bytes -= size;
    const checks = await this.files.read(receiptPath, checksSchema);
    for (const checkId of new Set(failedIds)) {
      result.failuresInspected++;
      const matches = checks.filter(check => check.checkId === checkId), check = matches.length === 1 ? matches[0] : null;
      if (!check) { result.unclassifiedFailures++; continue; }
      const evidence = [receiptPath, ...attempt.evidence.filter(ref => ref.endsWith('/task-contract.json'))];
      let output = [check.stdout, check.stderr, check.error ?? ''].map(text => this.preview(text, budget)).join('\n');
      if (check.outputFiles) {
        for (const log of [check.outputFiles.stdout, check.outputFiles.stderr]) {
          try {
            const read = await this.logPreview(log, prefix, budget); output += '\n' + read.text; evidence.push(read.reference);
          } catch (error) { result.warnings.push(`${attempt.jobId}/attempt-${attempt.attempt}/${checkId}: ${this.error(error)}`); }
        }
      } else if (check.outputTruncated) budget.truncated = true;
      const diagnostics = this.diagnostics(output, attempt.performanceScope?.language, budget);
      if (!diagnostics.length) result.unclassifiedFailures++;
      for (const diagnostic of diagnostics) {
        // Exact actionable diagnostic text can connect different check contracts. Language remains an explicit boundary.
        const signature = `${diagnostic.language}:${diagnostic.code}:${diagnostic.message}`;
        const id = 'rework_' + KnowledgeFiles.hash(JSON.stringify({ policyVersion, projectId: run.summary.projectId, signature })).slice(0, 32);
        const cluster = grouped.get(id) ?? { id, projectId: run.summary.projectId, signature, language: diagnostic.language,
          problemCategory: diagnostic.problemCategory, summary: `${diagnostic.code}: ${diagnostic.message}`, occurrences: [],
          recommendation: 'Compare the linked failures across tasks, reproduce the shared diagnostic in a small fixture, and identify a reusable prevention or check. Recurrence is evidence for investigation; review and validation are required before proposing or promoting a fix.' };
        if (!cluster.occurrences.some(item => item.jobId === attempt.jobId && item.attempt === attempt.attempt && item.checkId === checkId)) {
          cluster.occurrences.push({ jobId: attempt.jobId, attempt: attempt.attempt, checkId: EvidenceSanitizer.text(checkId, 160),
            evidence: [...new Set(evidence)], diagnostic: `${diagnostic.code}: ${diagnostic.message}` });
        }
        grouped.set(id, cluster);
      }
    }
  }

  private preview(value: string, budget: Budget): string {
    const limit = 64 * 1024;
    if (value.length > limit) budget.truncated = true;
    const clipped = value.length > limit ? value.slice(0, limit).replace(/[^\n]*$/, '') : value;
    return EvidenceSanitizer.text(clipped, limit).replace(/\u001b\[[0-9;]*m/g, '');
  }

  private async logPreview(log: string, attemptPrefix: string, budget: Budget): Promise<{ text: string; reference: string }> {
    // Paths in a command receipt are data. Only logs in that exact owned attempt can contribute evidence.
    const relative = path.relative(this.root, path.resolve(this.root, log));
    if (!isSubPath(path.resolve(this.root, relative), path.join(this.root, attemptPrefix))) throw new Error('Output log is outside its recorded attempt.');
    const file = await this.files.file(relative), attemptRoot = await this.files.file(attemptPrefix);
    if (!isSubPath(file, attemptRoot)) throw new Error('Output log resolves outside its recorded attempt.');
    const handle = await fs.open(file, 'r');
    try {
      const size = (await handle.stat()).size, keep = Math.min(size, 64 * 1024, budget.bytes);
      if (keep < size) budget.truncated = true;
      const buffer = Buffer.alloc(keep), first = Math.ceil(keep / 2);
      await handle.read(buffer, 0, first, 0);
      await handle.read(buffer, first, keep - first, Math.max(first, size - (keep - first)));
      budget.bytes -= keep;
      // Drop clipped partial lines; fragments must not manufacture a shared diagnostic.
      const text = keep === size ? buffer.toString('utf8') : buffer.subarray(0, first).toString('utf8').replace(/[^\n]*$/, '')
        + '\n' + buffer.subarray(first).toString('utf8').replace(/^[^\n]*\n?/, '');
      return { text: this.preview(text, budget), reference: relative.replaceAll('\\', '/') };
    } finally { await handle.close(); }
  }

  private diagnostics(output: string, declaredLanguage: string | undefined, budget: Budget): Diagnostic[] {
    const declared = declaredLanguage?.trim().toLowerCase(), python = declared === 'python' || declared === 'py' || /Traceback \(most recent call last\):/.test(output);
    const javascript = ['javascript', 'typescript', 'js', 'ts', 'jsx', 'tsx'].includes(declared ?? '') || /\bat .+\.[cm]?js:\d+:\d+\)?/m.test(output);
    const diagnostics = new Map<string, Diagnostic>();
    const lines = output.split(/\r?\n/);
    if (lines.length > 4000) budget.truncated = true;
    for (const line of lines.length <= 4000 ? lines : [...lines.slice(0, 2000), ...lines.slice(-2000)]) {
      let diagnostic: Diagnostic | undefined, match: RegExpMatchArray | null;
      if ((match = line.match(/(?:^|[\s:-])(?:error\s+)?(TS\d{4,5}):\s*(.+)$/))) {
        diagnostic = { language: 'typescript', code: match[1]!, message: match[2]!, problemCategory: Number(match[1]!.slice(2)) < 2000 ? 'syntax' : 'typecheck' };
      } else if ((match = line.match(/\berror\s+(CS\d{4}):\s*(.+)$/))) {
        diagnostic = { language: 'csharp', code: match[1]!, message: match[2]!, problemCategory: 'compile' };
      } else if ((match = line.match(/^\s*error\[(E\d{4})\]:\s*(.+)$/))) {
        diagnostic = { language: 'rust', code: match[1]!, message: match[2]!, problemCategory: 'compile' };
      } else if ((match = line.match(/^\s*(SyntaxError|IndentationError|TabError|TypeError|ReferenceError|RangeError|NameError|ModuleNotFoundError|ImportError|AttributeError|KeyError|ValueError|ZeroDivisionError):\s*(.+)$/))) {
        // SyntaxError/TypeError alone occur in multiple runtimes. Never infer their language from a task title.
        const language = python ? 'python' : javascript ? 'javascript' : null;
        if (language) diagnostic = { language, code: match[1]!, message: match[2]!, problemCategory: /SyntaxError|IndentationError|TabError/.test(match[1]!) ? 'syntax' : 'runtime' };
      }
      if (!diagnostic) continue;
      diagnostic.message = this.normalize(diagnostic.message);
      // Redaction/truncation can collapse distinct failures. Such text cannot establish an actionable shared signature.
      if (!diagnostic.message || diagnostic.message.length > 800 || /\[(?:credential|email|token) redacted\]|\[redacted\]/.test(diagnostic.message)) continue;
      if (diagnostics.size >= 20 && !diagnostics.has(JSON.stringify(diagnostic))) { budget.truncated = true; break; }
      diagnostics.set(JSON.stringify(diagnostic), diagnostic);
    }
    return [...diagnostics.values()];
  }

  private normalize(message: string): string {
    return EvidenceSanitizer.text(message, 2000)
      .replace(/(['"])(?:[A-Za-z]:[\\/]|\/(?:[^\s'"/]+\/)|\.\.?[\\/])[^'"\r\n]*\1/g, '$1<path>$1')
      .replace(/\b[A-Za-z]:[\\/][^\s'"<>]+/g, '<path>')
      .replace(/\s*\(?(?:at )?line \d+(?:,? (?:column|col) \d+)?\)?/gi, '')
      .replace(/\s*\[\d+,\s*\d+\]\s*$/, '')
      .replace(/\b0x[\da-f]+\b/gi, '<address>')
      .replace(/\s+/g, ' ').trim();
  }

  private error(error: unknown): string { return EvidenceSanitizer.text(error instanceof Error ? error.message : 'Rework evidence unavailable.', 400); }
}
