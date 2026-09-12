import fs from 'node:fs/promises';
import path from 'node:path';
import { ProcessCleanupError, ProcessRunner } from './process.js';
import { ProfileSchema } from './registry.js';
import { atomicWriteJson, makeId, readJson, resolveRealSubPath } from './legacy/command-os-utils.js';

export interface PrepareWorkspaceInput {
  projectId: string;
  sourceRoot: string;
  jobId: string;
  baseRef: string;
}

export interface PreparedWorkspace {
  root: string;
  sourceRoot: string;
  baseRef: string;
  baseSha: string;
  created: boolean;
}

interface WorkspaceRecord extends Omit<PreparedWorkspace, 'created'> {
  version: 1;
  projectId: string;
  jobId: string;
  gitCommonDir: string;
  createdAt: string;
}

/** Detached, explicitly based worktrees; source checkout state is never rewritten. */
export class WorkspaceManager {
  constructor(private readonly infraRoot: string, private readonly runner = new ProcessRunner()) {}

  async resolveBase(sourceRoot: string, baseRef: string): Promise<string> {
    if (typeof baseRef !== 'string' || !baseRef.trim()) throw new Error('An explicit baseRef is required');
    const sha = await this.git(sourceRoot, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('baseRef did not resolve to one local commit');
    return sha;
  }

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    ProfileSchema.shape.id.parse(input.projectId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.jobId)) throw new Error('Invalid workspace job ID');
    if ([input.projectId, input.jobId].some((id) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id))) throw new Error('Workspace ID is reserved by Windows');
    if (typeof input.baseRef !== 'string' || !input.baseRef.trim()) throw new Error('An explicit baseRef is required');
    const infraRoot = await fs.realpath(this.infraRoot);
    const sourceRoot = await fs.realpath(input.sourceRoot);
    await this.assertRoot(sourceRoot);
    const gitCommonDir = await this.commonDir(sourceRoot);
    const baseSha = await this.resolveBase(sourceRoot, input.baseRef);
    const workspaceParent = await this.ownedDirectory(infraRoot, ['workspaces', input.projectId]);
    const artifactParent = await this.ownedDirectory(infraRoot, ['artifacts', 'workspaces', input.projectId]);
    const root = path.join(workspaceParent, input.jobId);
    const recordPath = path.join(artifactParent, `${input.jobId}.json`);
    const record = await readJson(recordPath, null) as WorkspaceRecord | null;
    const existing = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (!record) throw new Error('Existing workspace has no ownership metadata; refusing to replace it');
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Existing workspace is not an owned directory');
      if (record.version !== 1 || record.projectId !== input.projectId || record.jobId !== input.jobId ||
        record.baseRef !== input.baseRef || record.baseSha !== baseSha || path.relative(record.root, root) !== '' ||
        path.relative(record.sourceRoot, sourceRoot) !== '' || path.relative(record.gitCommonDir, gitCommonDir) !== '') {
        throw new Error('Workspace metadata does not match the requested source and base');
      }
      await this.assertRoot(root);
      if (path.relative(await this.commonDir(root), gitCommonDir) !== '' || await this.git(root, ['rev-parse', 'HEAD']) !== baseSha) {
        throw new Error('Existing workspace repository or HEAD differs from its recorded base');
      }
      return { root, sourceRoot, baseRef: input.baseRef, baseSha, created: false };
    }
    if (record) throw new Error('Recorded workspace directory is missing; refusing implicit recreation');
    // An absent, unique hooks directory suppresses post-checkout hooks without changing repository config.
    const disabledHooks = path.join(infraRoot, makeId('.disabled-hooks'));
    await this.git(sourceRoot, ['-c', `core.hooksPath=${disabledHooks}`, 'worktree', 'add', '--detach', '--', root, baseSha], 120000);
    await this.assertRoot(root);
    if (path.relative(await this.commonDir(root), gitCommonDir) !== '' || await this.git(root, ['rev-parse', 'HEAD']) !== baseSha) {
      throw new Error('Created worktree does not match the requested repository and commit');
    }
    const metadata: WorkspaceRecord = {
      version: 1, projectId: input.projectId, jobId: input.jobId, root, sourceRoot,
      baseRef: input.baseRef, baseSha, gitCommonDir, createdAt: new Date().toISOString(),
    };
    await atomicWriteJson(recordPath, metadata);
    return { root, sourceRoot, baseRef: input.baseRef, baseSha, created: true };
  }

  private async ownedDirectory(root: string, segments: string[]): Promise<string> {
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try { await fs.mkdir(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      const real = await resolveRealSubPath(current, root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !real) throw new Error('Workspace storage directory is outside owned infrastructure');
      current = real;
    }
    return current;
  }

  private async assertRoot(root: string): Promise<void> {
    const top = await fs.realpath(await this.git(root, ['rev-parse', '--show-toplevel']));
    if (path.relative(root, top) !== '') throw new Error('sourceRoot must identify the Git checkout root');
  }

  private async commonDir(root: string): Promise<string> {
    return fs.realpath(path.resolve(root, await this.git(root, ['rev-parse', '--git-common-dir'])));
  }

  private async git(cwd: string, args: string[], timeoutMs = 10000): Promise<string> {
    const result = await this.runner.run('git', ['--no-lazy-fetch', '--no-optional-locks', ...args], cwd, timeoutMs);
    if (result.cleanupFailed) throw new ProcessCleanupError(result);
    if (result.exitCode !== 0) throw new Error(`Git workspace operation failed: ${result.stderr.trim() || result.error || 'unknown error'}`);
    return result.stdout.trim();
  }
}
