import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProfileSchema, ProjectRegistry } from './registry.js';
import { atomicWriteJson, resolveRealSubPath } from './legacy/command-os-utils.js';
import { z } from 'zod';

export const SNAPSHOT_MANIFEST = 'snapshot-manifest.json';
export const RESTORE_METADATA_PATH = 'recovery/RESTORE.json';

export interface SnapshotFile { path: string; sha256: string; bytes: number }
export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  sourceRoot: string;
  files: SnapshotFile[];
  database: 'state/jobs.sqlite' | null;
  restorePolicy: { requiresReconciliation: true; automaticReplay: false };
}
export interface RestoreResult {
  target: string;
  restoredAt: string;
  snapshot: string;
  files: number;
  requiresReconciliation: true;
  automaticReplay: false;
  dispatchEnabled: false;
  metadataPath: string;
}

export interface ActivationResult {
  target: string;
  sourceRoot: string;
  activatedAt: string;
  dispatchEnabled: true;
  activatedProjectIds: string[];
  metadataPath: string;
  changedPaths: string[];
  profileMappings: { projectId: string; previousRoot: string; root: string; overridden: boolean }[];
}

const sourceDirectories = ['profiles', 'schemas', 'src', 'test', 'plugins', 'scripts', 'docs', 'artifacts', 'ui', 'imports', 'fixtures'] as const;
const sourceFiles = ['package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'CHECKPOINT.md', 'tsconfig.json', '.gitignore'] as const;
const databasePath = 'state/jobs.sqlite';
const excludedNames = new Set(['node_modules', 'dist', '.git', '.codex', 'codex-home', 'codex_home', '.ssh', '.aws', '.azure', 'secrets', 'logs', 'runtime']);

/** Portable source and evidence snapshots. Nothing here installs dependencies or starts workers. */
export class RecoveryManager {
  private readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
    if (!lstatSync(this.root).isDirectory()) throw new Error('Recovery root must be a directory');
  }

  /** Inspect local manifest metadata and dated verification receipts; never restore or activate. */
  async observations(limit = 20) {
    z.number().int().min(1).max(50).parse(limit);
    const warnings: string[] = [];
    const snapshots: {name:string; createdAt:string; files:number; bytes:number; manifestSha256:string; evidence:string}[] = [];
    const backups = join(this.root, 'recovery/backups');
    const names = existsSync(backups) ? readdirSync(backups).sort().reverse() : [];
    for (const name of names.slice(0, limit)) {
      try {
        const directory = await resolveRealSubPath(join(backups, name), backups);
        const file = directory && await resolveRealSubPath(join(directory, SNAPSHOT_MANIFEST), backups);
        if (!directory || !file || !lstatSync(file).isFile() || lstatSync(file).size > 8 * 1024 * 1024) throw new Error('Invalid manifest');
        const manifest = this.readManifest(directory);
        snapshots.push({name, createdAt: manifest.createdAt, files: manifest.files.length,
          bytes: manifest.files.reduce((sum, item) => sum + item.bytes, 0),
          manifestSha256: createHash('sha256').update(readFileSync(file)).digest('hex'), evidence: `recovery/backups/${name}/${SNAPSHOT_MANIFEST}`});
      } catch { warnings.push(`${name}: recovery manifest unavailable or invalid.`); }
    }
    const receiptSchema = z.object({capturedAt:z.iso.datetime(),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),
      files:z.number().int().nonnegative(),recoveredJobs:z.number().int().nonnegative(),restoredJobId:z.uuid(),
      sourceStatePreserved:z.boolean(),sourceRegistryPreserved:z.boolean().optional(),copyUsesOwnCli:z.boolean(),
      uiBuild:z.object({status:z.string(),sourcesPreserved:z.boolean().optional()}).optional(),
      activationValidation:z.object({scope:z.string(),activatedProjectIds:z.array(z.string()),externalProjectChecksExecuted:z.boolean()}).optional()});
    const verifications: (z.output<typeof receiptSchema> & {evidence:string})[] = [];
    const integration = join(this.root, 'artifacts/integration');
    const receipts = existsSync(integration) ? readdirSync(integration).filter(name => /^recovery-.*\.json$/.test(name) && !name.includes('failed')).sort().reverse() : [];
    for (const name of receipts.slice(0, limit)) {
      try {
        const file = await resolveRealSubPath(join(integration,name), integration);
        if (!file || !lstatSync(file).isFile() || lstatSync(file).size > 8 * 1024 * 1024) throw new Error('Invalid recovery receipt');
        const receipt = receiptSchema.parse(JSON.parse(readFileSync(file,'utf8')));
        verifications.push({...receipt, evidence:`artifacts/integration/${name}`});
      } catch { warnings.push(`${name}: verification receipt unavailable or incompatible.`); }
    }
    verifications.sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt));
    return {snapshots, verifications, warnings, totalSnapshots:names.length, truncated:names.length>limit || receipts.length>limit,
      scope:'owned local recovery directories', limitations:['Manifest metadata is not a fresh verification of every backup byte.', 'A successful dated test is separate from current host readiness, cleanup and human acceptance.', 'Copies on the same disk do not cover physical loss of that disk.']};
  }

  snapshot(destination: string): SnapshotManifest {
    const target = this.newTarget(destination);
    if (sourceDirectories.some((directory) => this.within(join(this.root, directory), target)) || this.within(join(this.root, 'state'), target)) {
      throw new Error('Snapshot destination cannot be inside a copied source directory');
    }
    const sourcePaths: string[] = [];
    for (const directory of sourceDirectories) this.collect(join(this.root, directory), directory, sourcePaths);
    for (const file of sourceFiles) this.collect(join(this.root, file), file, sourcePaths);
    const sourceDatabase = join(this.root, databasePath);
    const hasDatabase = existsSync(sourceDatabase);
    if (hasDatabase && (!lstatSync(sourceDatabase).isFile() || lstatSync(sourceDatabase).isSymbolicLink())) {
      throw new Error('State database must be a regular local file');
    }
    this.createTarget(target);
    const files: SnapshotFile[] = [];
    for (const path of sourcePaths.sort()) {
      const content = readFileSync(join(this.root, path));
      this.writeNew(target, path, content);
      files.push(this.fileRecord(path, content));
    }
    if (hasDatabase) {
      const backupPath = join(target, databasePath);
      mkdirSync(dirname(backupPath), { recursive: true });
      const source = new DatabaseSync(sourceDatabase, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 5000');
        // SQLite produces one consistent database including committed WAL contents.
        // Binding the destination avoids SQL interpolation and creates no source copy of sidecars.
        source.prepare('VACUUM INTO ?').run(backupPath);
      } finally { source.close(); }
      files.push(this.fileRecord(databasePath, readFileSync(backupPath)));
    }
    const manifest: SnapshotManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceRoot: this.root,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      database: hasDatabase ? databasePath : null,
      restorePolicy: { requiresReconciliation: true, automaticReplay: false },
    };
    // The manifest is the completion marker. A failed snapshot deliberately remains incomplete.
    this.writeNew(target, SNAPSHOT_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    return manifest;
  }

  restore(snapshot: string, destination: string): RestoreResult {
    const snapshotRoot = realpathSync(snapshot);
    const target = this.newTarget(destination);
    if (this.within(snapshotRoot, target)) throw new Error('Restore destination cannot be inside its snapshot');
    const manifest = this.readManifest(snapshotRoot);
    // Validate the complete input before creating a destination or restoring any file.
    for (const file of manifest.files) this.verifyFile(snapshotRoot, file);
    this.createTarget(target);
    for (const file of manifest.files) {
      const sourcePath = join(snapshotRoot, file.path);
      const targetPath = join(target, file.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
      this.verifyFile(target, file);
    }
    const result: RestoreResult = {
      target,
      restoredAt: new Date().toISOString(),
      snapshot: snapshotRoot,
      files: manifest.files.length,
      requiresReconciliation: true,
      automaticReplay: false,
      dispatchEnabled: false,
      metadataPath: join(target, RESTORE_METADATA_PATH),
    };
    this.writeNew(target, 'recovery/SNAPSHOT.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    this.writeNew(target, RESTORE_METADATA_PATH, Buffer.from(JSON.stringify(result, null, 2) + '\n'));
    return result;
  }

  /** Rebind this copy, validating only selected projects. Dispatch must respect activatedProjectIds. */
  async activate(profileRootOverrides: Record<string, string> = {}, projectIds?: string[]): Promise<ActivationResult> {
    const metadataPath = this.ownFile(RESTORE_METADATA_PATH);
    const snapshotPath = this.ownFile('recovery/SNAPSHOT.json');
    const registryPath = this.ownFile('profiles/registry.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    if (metadata.requiresReconciliation !== false) throw new Error('Reconcile the restored jobs before activation');
    if (typeof metadata.dispatchEnabled !== 'boolean') throw new Error('Restored dispatch state is invalid');
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotManifest;
    if (snapshot.version !== 1 || typeof snapshot.sourceRoot !== 'string' || !isAbsolute(snapshot.sourceRoot)) {
      throw new Error('Restored snapshot sourceRoot is invalid');
    }
    const sourceRoot = resolve(snapshot.sourceRoot);
    const rebind = (value: string): string => isAbsolute(value) && this.within(sourceRoot, value)
      ? join(this.root, relative(sourceRoot, value)) : value;
    const registry = new ProjectRegistry(registryPath);
    const profiles = await registry.list();
    if (projectIds !== undefined && (!Array.isArray(projectIds) || projectIds.length === 0
      || projectIds.some(id => typeof id !== 'string' || !profiles.some(profile => profile.id === id))
      || new Set(projectIds).size !== projectIds.length)) {
      throw new Error('Activation project IDs must be a non-empty list of unique known IDs');
    }
    const selectedIds = new Set(projectIds ?? profiles.map(profile => profile.id));
    const activatedProjectIds = profiles.filter(profile => selectedIds.has(profile.id)).map(profile => profile.id);
    for (const id of Object.keys(profileRootOverrides)) {
      if (!profiles.some(profile => profile.id === id)) throw new Error(`Unknown project root override: ${id}`);
      if (!selectedIds.has(id)) throw new Error(`Project root override requires selecting the project: ${id}`);
    }
    const profileMappings: ActivationResult['profileMappings'] = [];
    const reboundProfiles = [];
    for (const profile of profiles) {
      const selected = selectedIds.has(profile.id);
      const override = profileRootOverrides[profile.id];
      const root = override ?? rebind(profile.root);
      let resolvedRoot = root;
      if (selected) {
        if (!isAbsolute(root)) throw new Error(`Project root must be absolute: ${profile.id}`);
        try {
          resolvedRoot = realpathSync(root);
          if (!lstatSync(resolvedRoot).isDirectory()) throw new Error('Not a directory');
        } catch { throw new Error(`Project root is unavailable: ${profile.id}; provide an existing root override`); }
      }
      const rebound = ProfileSchema.parse({
        ...profile, root: resolvedRoot,
        sourceRoots: profile.sourceRoots.map(rebind),
        sources: profile.sources.map(source => ({ ...source, path: rebind(source.path) })),
        checks: profile.checks.map(check => ({ ...check, executable: rebind(check.executable), args: check.args.map(rebind), environmentPaths: check.environmentPaths.map(rebind) })),
      });
      // Preserve unselected profiles and their internal rebindings without requiring their products or runtimes.
      reboundProfiles.push(rebound);
      profileMappings.push({ projectId: profile.id, previousRoot: profile.root, root: resolvedRoot, overridden: override !== undefined });
      if (!selected) continue;
      // Confirm all references before the first mutation. Existing external paths are never rewritten.
      for (const sourceRootPath of rebound.sourceRoots) {
        if (!isAbsolute(sourceRootPath) || !existsSync(sourceRootPath) || !lstatSync(realpathSync(sourceRootPath)).isDirectory()) {
          throw new Error(`Project source root is unavailable: ${profile.id}`);
        }
      }
      for (const source of rebound.sources) {
        const candidate = isAbsolute(source.path) ? source.path : resolve(rebound.root, source.path);
        let permitted: string | null = null;
        for (const allowedRoot of [rebound.root, ...rebound.sourceRoots]) {
          permitted = await resolveRealSubPath(candidate, allowedRoot);
          if (permitted) break;
        }
        if (!permitted || !lstatSync(permitted).isFile()) throw new Error(`Project context source is unavailable or outside its roots: ${profile.id}/${source.label}`);
      }
      for (const check of rebound.checks) {
        await registry.resolveEnvironmentPaths(rebound, check);
        if (isAbsolute(check.executable) && (!existsSync(check.executable) || !lstatSync(realpathSync(check.executable)).isFile())) {
          throw new Error(`Project check executable is unavailable: ${profile.id}/${check.id}`);
        }
        if (!await resolveRealSubPath(resolve(rebound.root, check.relativeCwd), rebound.root)) {
          throw new Error(`Project check directory is unavailable or outside its root: ${profile.id}/${check.id}`);
        }
      }
    }
    const rawRegistry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    const reboundRegistry = { ...rawRegistry, projects: reboundProfiles };
    const changes: { path: string; value: unknown }[] = [];
    if (JSON.stringify(rawRegistry) !== JSON.stringify(reboundRegistry)) changes.push({ path: 'profiles/registry.json', value: reboundRegistry });
    const mcpRelativePath = 'plugins/codex-infra/.mcp.json';
    if (existsSync(join(this.root, mcpRelativePath))) {
      const mcpPath = this.ownFile(mcpRelativePath);
      const originalMcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      const mcp = structuredClone(originalMcp);
      const server = mcp?.mcpServers?.['codex-infra'];
      if (!server || typeof server.command !== 'string' || !Array.isArray(server.args)
        || !server.args.every((arg: unknown) => typeof arg === 'string')
        || typeof server.env?.CODEX_INFRA_ROOT !== 'string') throw new Error('Restored personal MCP configuration is incomplete');
      const mcpRoot = rebind(server.env.CODEX_INFRA_ROOT);
      if (!isAbsolute(mcpRoot) || relative(this.root, mcpRoot) !== '') throw new Error('Personal MCP points to another infrastructure root');
      server.command = rebind(server.command);
      server.args = server.args.map(rebind);
      server.env.CODEX_INFRA_ROOT = this.root;
      if (JSON.stringify(originalMcp) !== JSON.stringify(mcp)) changes.push({ path: mcpRelativePath, value: mcp });
    }
    // Re-activation may inspect an already active copy, but cannot silently remap it while dispatch is enabled.
    const previousProjectIds = metadata.activatedProjectIds ?? profiles.map(profile => profile.id);
    const selectionChanged = JSON.stringify(previousProjectIds) !== JSON.stringify(activatedProjectIds);
    if (metadata.dispatchEnabled === true && (changes.length || selectionChanged)) throw new Error('Disable dispatch before remapping or changing project activation in an already active restore');
    for (const change of changes) this.ownFile(change.path);
    for (const change of changes) await atomicWriteJson(join(this.root, change.path), change.value);
    const result: ActivationResult = {
      target: this.root, sourceRoot, activatedAt: new Date().toISOString(), dispatchEnabled: true, activatedProjectIds,
      metadataPath, changedPaths: [...changes.map(change => change.path), RESTORE_METADATA_PATH], profileMappings,
    };
    // This completion marker is written last. Failed writes leave dispatch disabled.
    await atomicWriteJson(metadataPath, { ...metadata, target: this.root, dispatchEnabled: true, activatedProjectIds, activation: result });
    return result;
  }

  private ownFile(path: string): string {
    let current = this.root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Restore activation cannot write through symbolic links');
    }
    if (!lstatSync(current).isFile()) throw new Error(`Restore activation requires a regular file: ${path}`);
    return current;
  }

  private collect(absolute: string, path: string, output: string[]): void {
    if (!existsSync(absolute) || !this.allowed(path)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) this.collect(join(absolute, name), `${path}/${name}`, output);
    } else if (stat.isFile()) output.push(path);
  }

  private allowed(path: string): boolean {
    const parts = path.split('/');
    if (parts.some((part) => excludedNames.has(part.toLowerCase()) || /^\.env(?:\.|$)|^auth\.json$|^credentials(?:\.|$)|\.(?:pem|key)$|^id_(?:rsa|ed25519)(?:\.|$)/i.test(part))) return false;
    return path === databasePath || sourceFiles.some((file) => file === path) || sourceDirectories.some((directory) => parts[0] === directory);
  }

  private readManifest(root: string): SnapshotManifest {
    const raw: unknown = JSON.parse(readFileSync(join(root, SNAPSHOT_MANIFEST), 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('Invalid snapshot manifest');
    const manifest = raw as SnapshotManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.files) ||
      (manifest.database !== null && manifest.database !== databasePath) ||
      manifest.restorePolicy?.requiresReconciliation !== true || manifest.restorePolicy?.automaticReplay !== false) {
      throw new Error('Invalid snapshot manifest');
    }
    const seen = new Set<string>();
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || file.path.includes('\0') ||
        isAbsolute(file.path) || file.path.split('/').some((part) => !part || part === '.' || part === '..') || !this.allowed(file.path)) {
        throw new Error('Invalid snapshot file path');
      }
      if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid snapshot file hash or size');
      const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
      if (seen.has(key)) throw new Error('Duplicate snapshot file path');
      seen.add(key);
    }
    if ((manifest.database !== null) !== manifest.files.some((file) => file.path === databasePath)) throw new Error('Snapshot database entry does not match its manifest');
    return manifest;
  }

  private verifyFile(root: string, file: SnapshotFile): void {
    const path = join(root, file.path);
    let current = root;
    for (const part of file.path.split('/')) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Snapshot symbolic links are not supported');
    }
    if (!lstatSync(path).isFile()) throw new Error(`Snapshot file is not regular: ${file.path}`);
    const actual = this.fileRecord(file.path, readFileSync(path));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`Snapshot hash mismatch: ${file.path}`);
  }

  private fileRecord(path: string, content: Buffer): SnapshotFile {
    return { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
  }

  private writeNew(root: string, path: string, content: Buffer): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: 'wx' });
  }

  private newTarget(path: string): string {
    const absolute = resolve(path);
    if (existsSync(absolute)) throw new Error(`Recovery destination already exists: ${absolute}`);
    const suffix: string[] = [];
    let ancestor = absolute;
    while (!existsSync(ancestor)) {
      suffix.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('Recovery destination has no existing parent');
      ancestor = parent;
    }
    return join(realpathSync(ancestor), ...suffix);
  }

  private createTarget(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(target);
  }

  private within(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  }
}
