import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ContextPackBuilder } from './context-pack.js';
import { ProfileSchema, ProjectRegistry, type Profile, type ProjectContext } from './registry.js';
import type { TaskContract } from './task-contract.js';
import { resolveRealSubPath } from './legacy/command-os-utils.js';
import { KnowledgeLearningStore } from './knowledge-learning.js';
import { KnowledgeFiles, KnowledgeHashSchema, KnowledgeProjectSchema, KnowledgeSourceSchema } from './knowledge-store.js';

const edgeSchema = z.object({ from: KnowledgeHashSchema, to: KnowledgeHashSchema,
  kind: z.enum(['canonical-link', 'shared-decision', 'declared-conflict']), reference: z.string() });
export const KnowledgeIndexSchema = z.object({
  version: z.literal(1), id: KnowledgeHashSchema, projectId: KnowledgeProjectSchema, projectRoot: z.string(), profileHash: KnowledgeHashSchema,
  capturedAt: z.iso.datetime(), git: z.object({ head: z.string().nullable(), status: z.string(), error: z.string().nullable() }),
  nodes: z.array(KnowledgeSourceSchema.extend({ id: KnowledgeHashSchema })).max(1000), edges: z.array(edgeSchema),
  unresolvedLinks: z.array(z.object({ sourceId: KnowledgeHashSchema, reference: z.string(), reason: z.enum(['unregistered', 'ambiguous']) })),
});
export const KnowledgeSearchOptionsSchema = z.object({
  maxHops: z.number().int().min(0).max(3).default(1), budgetChars: z.number().int().min(1).max(120000).optional(),
  asOf: z.iso.datetime().optional(),
});
export type KnowledgeIndexRecord = z.output<typeof KnowledgeIndexSchema>;

/** Explicit source graph over an already authorized capture, never a product/vault crawler. */
export class KnowledgeIndex {
  private readonly files: KnowledgeFiles;
  private readonly packs = new ContextPackBuilder();
  private readonly learning: KnowledgeLearningStore;
  constructor(readonly root: string) { this.files = new KnowledgeFiles(root); this.learning = new KnowledgeLearningStore(root); }

  async build(rawProfile: Profile, context: ProjectContext): Promise<KnowledgeIndexRecord> {
    const profile = ProfileSchema.parse(rawProfile);
    const registry = new ProjectRegistry(path.join(this.root, 'profiles/registry.json'));
    if (profile.id !== context.projectId || registry.hash(profile) !== context.profileHash || !KnowledgeFiles.samePath(profile.root, context.root)) {
      throw new Error('Knowledge capture must match its resolved profile and context hash.');
    }
    const promoted = await this.learning.promotedSources(profile.id);
    const nodes: KnowledgeIndexRecord['nodes'] = [];
    for (const source of context.sources) {
      let configured: Profile['sources'][number] | undefined;
      for (const candidate of profile.sources.filter(candidate => candidate.label === source.label)) {
        const canonical = await fs.realpath(path.resolve(profile.root, candidate.path)).catch(() => null);
        if (canonical && KnowledgeFiles.samePath(canonical, source.path)) { configured = candidate; break; }
      }
      const release = promoted.find(candidate => candidate.path === source.path && candidate.sha256 === source.sha256);
      if (!configured && !release) throw new Error('Knowledge source is not registered or currently promoted: ' + source.label);
      let permitted: string | null = null;
      for (const allowed of release ? [this.root] : [profile.root, ...profile.sourceRoots]) {
        permitted = await resolveRealSubPath(source.path, allowed); if (permitted) break;
      }
      if (!permitted || !(await fs.stat(permitted)).isFile()) throw new Error('Knowledge source is not an allowed file: ' + source.label);
      nodes.push(KnowledgeSourceSchema.extend({ id: KnowledgeHashSchema }).parse({ ...source,
        ...(configured ?? release), path: permitted, id: KnowledgeFiles.hash(permitted + '\n' + source.label) }));
    }
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('Knowledge sources must be distinct.');
    const edges: KnowledgeIndexRecord['edges'] = [], unresolvedLinks: KnowledgeIndexRecord['unresolvedLinks'] = [];
    const connect = (from: typeof nodes[number], to: typeof nodes[number], kind: z.infer<typeof edgeSchema>['kind'], reference: string) => {
      if (from.id !== to.id && !edges.some(edge => edge.from === from.id && edge.to === to.id && edge.kind === kind && edge.reference === reference)) edges.push({ from: from.id, to: to.id, kind, reference });
    };
    const link = (node: typeof nodes[number], reference: string, kind: z.infer<typeof edgeSchema>['kind']) => {
      const normalized = reference.split('#')[0]!.trim();
      let targetPath: string | null = null;
      let vaultSuffix: string | null = null;
      if (normalized && !/^[a-z][a-z0-9+.-]*:/i.test(normalized)) targetPath = path.resolve(path.dirname(node.path), normalized);
      if (normalized.startsWith('obsidian://')) {
        try { const url = new URL(normalized), vault = url.searchParams.get('vault'), file = url.searchParams.get('file');
          if (vault && file) vaultSuffix = '/' + vault + '/' + file.replace(/\\/g, '/').replace(/\.md$/, '') + '.md';
        } catch { /* Unresolved reference is retained below. */ }
      }
      const matches = nodes.filter(candidate => candidate.label === normalized || path.basename(candidate.path, path.extname(candidate.path)) === normalized
        || (targetPath !== null && (KnowledgeFiles.samePath(candidate.path, targetPath) || KnowledgeFiles.samePath(candidate.path, targetPath + '.md')))
        || (vaultSuffix !== null && candidate.path.replace(/\\/g, '/').endsWith(vaultSuffix)));
      if (matches.length === 1) {
        connect(node, matches[0]!, kind, reference);
        if (kind === 'declared-conflict') connect(matches[0]!, node, kind, reference);
      } else unresolvedLinks.push({ sourceId: node.id, reference, reason: matches.length ? 'ambiguous' : 'unregistered' });
    };
    for (const node of nodes) {
      for (const label of node.conflictsWith ?? []) link(node, label, 'declared-conflict');
      for (const match of node.excerpt.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) link(node, match[1]!, 'canonical-link');
      for (const match of node.excerpt.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"([^"]+)")?\)/g)) {
        // Relative Markdown links are explicit references; remote URLs are never fetched.
        if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1]!) || match[1]!.startsWith('obsidian://')) link(node, match[1]!, 'canonical-link');
      }
      for (const reference of node.decisionRefs ?? []) {
        for (const target of nodes.filter(candidate => candidate.decisionRefs?.includes(reference))) connect(node, target, 'shared-decision', reference);
      }
    }
    edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const body = { version: 1 as const, projectId: profile.id, projectRoot: context.root, profileHash: context.profileHash,
      capturedAt: context.capturedAt, git: context.git, nodes, edges, unresolvedLinks };
    const index = KnowledgeIndexSchema.parse({ ...body, id: KnowledgeFiles.hash(JSON.stringify(body)) });
    const relative = this.indexPath(index.id);
    try { await this.files.writeJsonNew(relative, index); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const existing = await this.read(index.id); if (JSON.stringify(existing) !== JSON.stringify(index)) throw new Error('Knowledge index identity collision.'); }
    return index;
  }

  async read(indexId: string): Promise<KnowledgeIndexRecord> {
    KnowledgeHashSchema.parse(indexId);
    const index = await this.files.read(this.indexPath(indexId), KnowledgeIndexSchema);
    const { id, ...body } = index;
    if (id !== indexId || KnowledgeFiles.hash(JSON.stringify(body)) !== id) throw new Error('Knowledge index hash does not match its content.');
    return index;
  }

  async search(indexId: string, contract: TaskContract, rawOptions: z.input<typeof KnowledgeSearchOptionsSchema> = {}) {
    const options = KnowledgeSearchOptionsSchema.parse(rawOptions), index = await this.read(indexId);
    if (index.projectId !== contract.projectId) throw new Error('Knowledge search project differs from the task contract.');
    if (options.budgetChars !== undefined && options.budgetChars !== contract.details.contextBudgetChars) {
      throw new Error('Knowledge budget must match the explicit task contract budget.');
    }
    const context: ProjectContext = { projectId: index.projectId, root: index.projectRoot, profileHash: index.profileHash,
      capturedAt: options.asOf ?? new Date().toISOString(), git: index.git, sources: index.nodes.map(({ id: _, ...source }) => source) };
    const seedPack = this.packs.build(context, contract);
    const eligible = new Set([...seedPack.sources.map(source => source.path),
      ...seedPack.excludedSources.filter(source => ['no-lexical-match', 'context-budget'].includes(source.reason)).map(source => source.path)]);
    const seedIds = index.nodes.filter(node => seedPack.sources.some(source => source.path === node.path)).map(node => node.id);
    const visited = new Set(seedIds), traversed: KnowledgeIndexRecord['edges'] = [];
    let frontier = seedIds;
    for (let hop = 0; hop < options.maxHops; hop++) {
      const next: string[] = [];
      for (const edge of index.edges.filter(edge => frontier.includes(edge.from))) {
        const target = index.nodes.find(node => node.id === edge.to)!;
        if (!eligible.has(target.path) || visited.has(target.id)) continue;
        visited.add(target.id); next.push(target.id); traversed.push(edge);
      }
      frontier = next;
    }
    const additionalSourceLabels = index.nodes.filter(node => visited.has(node.id) && !seedIds.includes(node.id)).map(node => node.label);
    const pack = this.packs.build(context, contract, { additionalSourceLabels });
    return { version: 1 as const, indexId, indexCapturedAt: index.capturedAt, searchedAt: context.capturedAt, pack,
      graph: { maxHops: options.maxHops, seedIds, traversed, expandedLabels: additionalSourceLabels.filter(label => pack.sources.some(source => source.label === label)),
        unresolvedLinks: index.unresolvedLinks },
      freshness: { sourceContent: 'captured-snapshot' as const, liveContentChecked: false, capturedAt: index.capturedAt,
        excludedExpired: pack.excludedSources.filter(source => source.reason === 'source-expired').map(source => source.label) },
      limitations: ['Graph links express declared relationships, not authority or resolution of conflicts.',
        'The index covers registered captured excerpts; links outside this capture are not followed.',
        'Each worktree/context keeps its immutable index ID; rebuild from the canonical current context to observe content changes.'] };
  }

  private indexPath(id: string): string { return `artifacts/knowledge/indexes/${id}.json`; }
}
