import fs from "node:fs/promises";
import path from "node:path";
import { ProjectRegistry } from "./registry.js";
import { readJson } from "./legacy/command-os-utils.js";

export interface HealthReport {
  ok: boolean;
  items: Array<{ id: string; ok: boolean; detail: string }>;
}

export class HealthInspector {
  constructor(readonly root: string) {}

  async inspect(projectId?: string): Promise<HealthReport> {
    const items: HealthReport["items"] = [];
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    items.push({ id: "runtime:node", ok: major > 22 || (major === 22 && minor >= 16), detail: `Node ${process.versions.node}; required >=22.16.0.` });

    let manifest: { dependencies?: Record<string, unknown> } | null = null;
    try {
      manifest = await readJson(path.join(this.root, "package.json"), null);
    } catch {
      // Dependency items below also diagnose an unreadable or invalid manifest.
    }
    for (const name of ["@openai/codex", "@modelcontextprotocol/sdk"]) {
      const expected = manifest?.dependencies?.[name];
      if (typeof expected !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expected)) {
        items.push({ id: `dependency:${name}`, ok: false, detail: "package.json is missing, invalid or does not pin an exact dependency version." });
        continue;
      }
      try {
        const installed = await readJson(path.join(this.root, "node_modules", name, "package.json"), null) as { version?: unknown } | null;
        const ok = installed?.version === expected;
        items.push({ id: `dependency:${name}`, ok, detail: installed === null ? "Local dependency manifest is missing." : ok ? "Local dependency version matches the pinned version." : "Local dependency version does not match the pinned version." });
      } catch {
        items.push({ id: `dependency:${name}`, ok: false, detail: "Local dependency manifest is unreadable or invalid." });
      }
    }

    const registryPath = path.join(this.root, "profiles", "registry.json");
    const registry = new ProjectRegistry(registryPath);
    try {
      // list() intentionally defaults a missing registry to empty; onboarding must diagnose it.
      await fs.access(registryPath);
      const profiles = await registry.list();
      items.push({ id: "registry", ok: true, detail: `Registry loaded; ${profiles.length} profile(s).` });
      if (projectId !== undefined && !profiles.some(profile => profile.id === projectId)) {
        items.push({ id: `profile:${projectId}`, ok: false, detail: 'Requested project ID is not registered.' });
      }
      for (const profile of profiles.filter(profile => projectId === undefined || profile.id === projectId)) {
        try {
          const resolved = await registry.resolve(profile.id);
          const ok = (await fs.stat(resolved.root)).isDirectory();
          items.push({ id: `profile:${profile.id}`, ok, detail: ok ? "Profile resolves to an existing root directory." : "Profile root is not a directory." });
        } catch {
          items.push({ id: `profile:${profile.id}`, ok: false, detail: "Profile cannot be resolved: root is missing or inaccessible, or profile identity is ambiguous." });
        }
      }
    } catch {
      items.push({ id: "registry", ok: false, detail: "Registry is missing, unreadable or invalid." });
    }
    return { ok: items.every(item => item.ok), items };
  }
}
