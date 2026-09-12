import fs from 'node:fs/promises';
import path from 'node:path';
import { ProfileSchema, ProjectRegistry, type Profile } from './registry.js';
import type { StateStore } from './state.js';
import { atomicWriteJson, isSubPath, makeId, readJson, resolveRealSubPath } from './legacy/command-os-utils.js';

/** Explicit profile onboarding shared by callers; registering a profile never runs its commands. */
export class ProfileManager {
  constructor(private readonly registry: ProjectRegistry, private readonly state: StateStore, private readonly infraRoot: string) {}

  async register(input: unknown, replace = false): Promise<Profile> {
    const parsed = ProfileSchema.parse(input);
    const root = await fs.realpath(parsed.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Project root must be an existing directory');
    const sourceRoots: string[] = [];
    for (const candidate of parsed.sourceRoots) {
      const sourceRoot = await fs.realpath(candidate);
      if (!(await fs.stat(sourceRoot)).isDirectory()) throw new Error('Source root must be an existing directory');
      sourceRoots.push(sourceRoot);
    }
    const profile = ProfileSchema.parse({ ...parsed, root, sourceRoots, name: parsed.name.trim(), aliases: parsed.aliases.map((alias) => alias.trim()) });
    for (const check of profile.checks) await this.registry.resolveEnvironmentPaths(profile, check);
    for (const source of profile.sources) {
      const candidate = path.isAbsolute(source.path) ? source.path : path.resolve(root, source.path);
      let resolved: string | null = null;
      for (const allowed of [root, ...sourceRoots]) {
        resolved = await resolveRealSubPath(candidate, allowed);
        if (resolved) break;
      }
      if (!resolved || !(await fs.stat(resolved)).isFile()) throw new Error(`Profile source is missing or outside allowed roots: ${source.label}`);
    }
    return this.withLock(async () => {
      const infraRoot = await fs.realpath(this.infraRoot);
      const registryPath = path.resolve(this.registry.registryPath);
      const profiles = await this.registry.list();
      const original = await readJson(registryPath, { version: 1, projects: [] }) as { version: number; projects: unknown[]; [key: string]: unknown };
      const existing = profiles.find((candidate) => candidate.id === profile.id);
      if (existing && this.sameProfile(existing, profile)) return existing;
      if (existing && !replace) throw new Error('Profile already exists with a different definition; explicit replace is required');
      const keys = new Set([profile.id, profile.name, ...profile.aliases].map((name) => name.trim().toLocaleLowerCase('pt-BR')));
      for (const other of profiles) {
        if (other.id === profile.id) continue;
        if ([other.id, other.name, ...other.aliases].some((name) => keys.has(name.trim().toLocaleLowerCase('pt-BR')))) {
          throw new Error(`Profile name, ID or alias conflicts with ${other.id}`);
        }
      }
      if (this.state.list().some((job) => job.projectId === profile.id && (job.status === 'running' || job.status === 'validating'))) {
        throw new Error('Cannot change a profile while its project has an active job');
      }
      let artifactDirectory = infraRoot;
      for (const segment of ['artifacts', 'profiles']) {
        artifactDirectory = path.join(artifactDirectory, segment);
        try { await fs.mkdir(artifactDirectory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(artifactDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !await resolveRealSubPath(artifactDirectory, infraRoot)) {
          throw new Error('Profile backups must remain inside the infrastructure');
        }
      }
      await atomicWriteJson(path.join(artifactDirectory, `${makeId('profile')}.json`), original);
      // Preserve original representations and extra metadata of every unrelated profile.
      const projects = [...original.projects];
      const index = profiles.findIndex((candidate) => candidate.id === profile.id);
      if (index < 0) projects.push(profile);
      else projects[index] = profile;
      await atomicWriteJson(registryPath, { ...original, version: 1, projects });
      return profile;
    });
  }

  /** Shared short lock for registration and dispatch validation/claim. It never retries or steals a lock. */
  async withLock<T>(operation: () => Promise<T>, waitMs=0): Promise<T> {
    const infraRoot = await fs.realpath(this.infraRoot);
    const registryPath = path.resolve(this.registry.registryPath);
    // Bootstrap owns creation of the registry directory; shared coordination stays inside the installation.
    if (!isSubPath(registryPath, infraRoot) || !await resolveRealSubPath(path.dirname(registryPath), infraRoot)) {
      throw new Error('Registry directory must exist within the infrastructure root');
    }
    const registryFile = await fs.lstat(registryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (registryFile?.isSymbolicLink()) throw new Error('Registry file must not be a symbolic link');
    const lockPath = registryPath + '.registration.lock';
    const deadline=performance.now()+Math.min(Math.max(waitMs,0),5000);
    const acquire = async ():Promise<Awaited<ReturnType<typeof fs.open>>> => {
      try {return await fs.open(lockPath,'wx');}
      catch(error) {
        if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
        if(performance.now()>=deadline) throw new Error('Profile registry update is in progress or its abandoned lock requires review');
        await new Promise(resolve=>setTimeout(resolve,25));
        return acquire();
      }
    };
    const lock = await acquire();
    try { return await operation(); }
    finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  private sameProfile(existing: Profile, candidate: Profile): boolean {
    const normalized = { ...existing, root: path.resolve(existing.root), sourceRoots: existing.sourceRoots.map((root) => path.resolve(root)) };
    return this.registry.hash(normalized) === this.registry.hash(candidate);
  }
}
