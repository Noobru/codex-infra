import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeFiles } from './knowledge-store.js';

interface RuntimeCapture {
  version: string | null;
  fingerprint: string | null;
  warnings: string[];
}

export interface RuntimeObservationReport {
  startedAt: string;
  loadedVersion: string | null;
  installedVersion: string | null;
  loadedFingerprint: string | null;
  installedFingerprint: string | null;
  restartRequired: boolean | null;
  warnings: string[];
}

/** Instantiate once at service startup; this observes files without restarting the service. */
export class RuntimeObservation {
  private readonly root: string;
  private readonly startedAt = new Date().toISOString();
  private readonly loaded: RuntimeCapture;

  constructor(root: string) {
    this.root = realpathSync(root);
    this.loaded = this.capture();
  }

  read(): RuntimeObservationReport {
    const installed = this.capture();
    const versionKnown = this.loaded.version !== null && installed.version !== null;
    const fingerprintKnown = this.loaded.fingerprint !== null && installed.fingerprint !== null;
    const changed = (versionKnown && this.loaded.version !== installed.version)
      || (fingerprintKnown && this.loaded.fingerprint !== installed.fingerprint);
    return {
      startedAt: this.startedAt,
      loadedVersion: this.loaded.version, installedVersion: installed.version,
      loadedFingerprint: this.loaded.fingerprint, installedFingerprint: installed.fingerprint,
      restartRequired: changed ? true : versionKnown && fingerprintKnown ? false : null,
      warnings: [
        ...this.loaded.warnings.map(warning => `At service startup: ${warning}`),
        ...installed.warnings.map(warning => `Currently installed: ${warning}`),
      ],
    };
  }

  private capture(): RuntimeCapture {
    const result: RuntimeCapture = { version: null, fingerprint: null, warnings: [] };
    try {
      const file = path.join(this.root, 'package.json');
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Package unavailable');
      const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const version = manifest && typeof manifest === 'object' && 'version' in manifest ? manifest.version : null;
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid version');
      result.version = version;
    } catch { result.warnings.push('Infrastructure package version is unavailable.'); }

    try {
      // Hash the executable build, including relative names, rather than timestamps or package version.
      // Source maps and declarations do not change the code already loaded by the service.
      for (const relative of ['dist', 'dist/src']) {
        const stat = lstatSync(path.join(this.root, relative));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Build unavailable');
      }
      const files: { path: string; hash: string }[] = [];
      this.collect(path.join(this.root, 'dist/src'), '', files);
      if (files.length === 0) throw new Error('Build unavailable');
      result.fingerprint = KnowledgeFiles.hash(JSON.stringify(files));
    } catch { result.warnings.push('Infrastructure build fingerprint is unavailable.'); }
    return result;
  }

  private collect(directory: string, relative: string, files: { path: string; hash: string }[]): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new Error('Linked build cannot be fingerprinted');
      const file = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) this.collect(file, name, files);
      else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
        files.push({ path: name, hash: KnowledgeFiles.hash(readFileSync(file)) });
      }
    }
  }
}
