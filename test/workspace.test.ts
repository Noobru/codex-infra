import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProcessCleanupError, ProcessRunner, type CommandResult } from '../src/process.js';
import { WorkspaceManager } from '../src/workspace.js';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await new ProcessRunner().run('git', args, cwd);
  assert.equal(result.exitCode, 0, result.stderr || result.error);
  return result.stdout.trim();
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'codexinfra-workspace-'));
  const sourceRoot = path.join(root, 'source');
  const infraRoot = path.join(root, 'infra');
  await fs.mkdir(sourceRoot);
  await fs.mkdir(infraRoot);
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'codexinfra-workspace-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await git(sourceRoot, 'init', '-b', 'main');
  await git(sourceRoot, 'config', '--local', 'user.name', 'CodexInfra Fixture');
  await git(sourceRoot, 'config', '--local', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(sourceRoot, 'README.md'), 'Committed baseline\n');
  await git(sourceRoot, 'add', '--', 'README.md');
  await git(sourceRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture baseline');
  const sha = await git(sourceRoot, 'rev-parse', 'HEAD');
  return { root, sourceRoot, infraRoot, sha, manager: new WorkspaceManager(infraRoot) };
}

test('detached workspace preserves dirty source, branches and idempotent worktree edits', async (t) => {
  const { sourceRoot, infraRoot, sha, manager } = await fixture(t);
  await fs.writeFile(path.join(sourceRoot, 'README.md'), 'Staged source change\n');
  await git(sourceRoot, 'add', '--', 'README.md');
  await fs.writeFile(path.join(sourceRoot, 'README.md'), 'Unstaged source change\n');
  await fs.writeFile(path.join(sourceRoot, 'scratch.txt'), 'Untracked source file\n');
  const before = await git(sourceRoot, 'status', '--porcelain=v1', '--branch');
  const branches = await git(sourceRoot, 'show-ref', '--heads');
  const input = { projectId: 'fixture', sourceRoot, jobId: 'job-1', baseRef: 'main' };
  const prepared = await manager.prepare(input);
  assert.equal(prepared.created, true);
  assert.equal(prepared.baseSha, sha);
  assert.equal(prepared.root, path.join(infraRoot, 'workspaces', 'fixture', 'job-1'));
  assert.equal((await fs.readFile(path.join(prepared.root, 'README.md'), 'utf8')).trim(), 'Committed baseline');
  assert.equal(await git(prepared.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  await fs.writeFile(path.join(prepared.root, 'README.md'), 'Worktree change preserved\n');
  assert.deepEqual(await manager.prepare(input), { ...prepared, created: false });
  assert.equal(await fs.readFile(path.join(prepared.root, 'README.md'), 'utf8'), 'Worktree change preserved\n');
  assert.equal(await git(sourceRoot, 'status', '--porcelain=v1', '--branch'), before);
  assert.equal(await git(sourceRoot, 'show-ref', '--heads'), branches);
  assert.equal(await git(sourceRoot, 'rev-parse', 'HEAD'), sha);
  const metadata = JSON.parse(await fs.readFile(path.join(infraRoot, 'artifacts/workspaces/fixture/job-1.json'), 'utf8'));
  assert.equal(metadata.baseSha, sha);
  await assert.rejects(fs.access(path.join(prepared.root, 'workspace.json')));
});

test('missing refs and unowned destination collisions fail without changing source', async (t) => {
  const { sourceRoot, infraRoot, sha, manager } = await fixture(t);
  const before = await git(sourceRoot, 'status', '--porcelain=v1', '--branch');
  const input = { projectId: 'fixture', sourceRoot, jobId: 'collision', baseRef: 'main' };
  await assert.rejects(manager.prepare({ ...input, baseRef: 'missing-local-ref' }), /Git workspace operation failed/);
  const destination = path.join(infraRoot, 'workspaces/fixture/collision');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'keep.txt'), 'Preserve existing directory');
  await assert.rejects(manager.prepare(input), /no ownership metadata/);
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'Preserve existing directory');
  await assert.rejects(manager.prepare({ ...input, jobId: '../escape' }), /Invalid workspace job ID/);
  assert.equal(await git(sourceRoot, 'status', '--porcelain=v1', '--branch'), before);
  assert.equal(await git(sourceRoot, 'rev-parse', 'HEAD'), sha);
});

test('existing worktree with changed HEAD is retained but cannot be reused as the original base', async (t) => {
  const { sourceRoot, sha, manager } = await fixture(t);
  const input = { projectId: 'fixture', sourceRoot, jobId: 'changed-head', baseRef: sha };
  const prepared = await manager.prepare(input);
  // Commits are confined to this disposable test repository and its detached test worktree.
  await fs.writeFile(path.join(prepared.root, 'README.md'), 'New fixture commit\n');
  await git(prepared.root, 'add', '--', 'README.md');
  await git(prepared.root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'Detached fixture change');
  const changed = await git(prepared.root, 'rev-parse', 'HEAD');
  await assert.rejects(manager.prepare(input), /HEAD differs/);
  assert.equal(await git(prepared.root, 'rev-parse', 'HEAD'), changed);
  assert.equal(await git(sourceRoot, 'rev-parse', 'HEAD'), sha);
});

test('workspace Git failure preserves typed cleanup evidence instead of treating it as an ordinary command error', async () => {
  const result: CommandResult = { executable: 'git', args: [], cwd: process.cwd(), exitCode: null,
    stdout: '', stderr: '', durationMs: 1, error: 'timeout', cleanupFailed: true, ownedPid: 2147483000 };
  const manager = new WorkspaceManager(process.cwd(), { run: async () => result });
  await assert.rejects(manager.resolveBase(process.cwd(), 'main'), error => {
    assert.ok(error instanceof ProcessCleanupError);
    assert.equal(error.result, result);
    assert.equal(error.cleanupFailed, true);
    return true;
  });
});
