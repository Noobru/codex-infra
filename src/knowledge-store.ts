import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProfileSchema } from './registry.js';
import { EvaluationReceiptSchema } from './evaluation.js';
import { EvidenceSanitizer } from './evidence.js';
import { atomicWriteNew, isSubPath, readJson, resolveRealSubPath } from './legacy/command-os-utils.js';

export const KnowledgeTextSchema = EvaluationReceiptSchema.shape.source;
export const KnowledgeAuthorSchema = EvaluationReceiptSchema.shape.author;
export const KnowledgeEvidenceSchema = EvaluationReceiptSchema.shape.evidence;
export const KnowledgeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const KnowledgeProjectSchema = ProfileSchema.shape.id;
export const KnowledgeKindSchema = z.enum(['script', 'skill', 'practice']);
export const KnowledgeImpactSchema = z.object({
  problem: KnowledgeTextSchema, language: KnowledgeTextSchema.optional(), expectedChange: KnowledgeTextSchema,
  baselineEvaluationIds: z.array(z.uuid()).max(20).default([]),
  affectedCheckIds: z.array(z.string().min(1).max(160)).max(100).default([]),
}).strict();
export const KnowledgeContentSchema = z.string().min(1).max(64000)
  .refine(value => EvidenceSanitizer.text(value, 64000) === value,
    'Proposal content contains material that cannot be preserved in ordinary evidence.');
export const KnowledgeSourceSchema = ProfileSchema.shape.sources.element.omit({ maxChars: true }).extend({
  sha256: KnowledgeHashSchema, modifiedAt: z.iso.datetime(), totalChars: z.number().int().nonnegative(),
  excerpt: z.string().max(64000).transform(value => EvidenceSanitizer.text(value, 64000)), truncated: z.boolean(),
});
export const KnowledgeDecisionSchema = z.object({
  author: KnowledgeAuthorSchema, source: KnowledgeTextSchema, evidence: KnowledgeEvidenceSchema,
});
export const KnowledgeOwnerDecisionSchema = KnowledgeDecisionSchema.refine(value => value.author.role === 'owner', 'An explicit owner decision is required.');

/** Exclusive immutable records supplement the existing atomic mutable JSON writer. */
export class KnowledgeFiles {
  constructor(readonly root: string) {}
  static hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
  static samePath(left: string, right: string): boolean {
    return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
  }
  async file(relative: string): Promise<string> {
    const candidate = path.resolve(this.root, relative);
    if (!isSubPath(candidate, path.join(this.root, 'artifacts'))) throw new Error('Knowledge records must remain inside owned artifacts.');
    const owned = await resolveRealSubPath(candidate, this.root);
    if (!owned) throw new Error('Knowledge artifact is missing or outside the infrastructure root.');
    return owned;
  }
  async read<T>(relative: string, schema: z.ZodType<T>): Promise<T> {
    const file = await this.file(relative);
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('Knowledge record exceeds the read budget.');
    return schema.parse(await readJson(file, null));
  }
  async writeNew(relative: string, content: string): Promise<void> {
    const target = path.resolve(this.root, relative);
    if (!isSubPath(target, path.join(this.root, 'artifacts'))) throw new Error('Knowledge destination must remain inside owned artifacts.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const directory = await resolveRealSubPath(path.dirname(target), this.root);
    if (!directory) throw new Error('Knowledge destination escapes the infrastructure root.');
    await atomicWriteNew(path.join(directory, path.basename(target)), content);
  }
  async writeJsonNew(relative: string, value: unknown): Promise<void> {
    await this.writeNew(relative, JSON.stringify(value, null, 2) + '\n');
  }
  /** Retry immutable materialization without silently replacing content already at the destination. */
  async writeVerified(relative: string, content: string): Promise<void> {
    try { await this.writeNew(relative, content); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (KnowledgeFiles.hash(await fs.readFile(await this.file(relative))) !== KnowledgeFiles.hash(content))
        throw new Error('Immutable knowledge content differs from the existing artifact.');
    }
  }
  async names(relative: string): Promise<string[]> {
    try { await fs.stat(path.join(this.root, relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return (await fs.readdir(await this.file(relative))).sort();
  }
}
