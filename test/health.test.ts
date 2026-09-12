import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HealthInspector } from "../src/health.js";

class HealthFixture {
  constructor(readonly root: string) {}

  async prepare(broken = false): Promise<void> {
    const dependencies = { "@openai/codex": "0.154.0", "@modelcontextprotocol/sdk": "1.30.0" };
    await fs.writeFile(path.join(this.root, "package.json"), JSON.stringify({ dependencies }));
    for (const [name, version] of Object.entries(dependencies)) {
      if (broken && name === "@openai/codex") continue;
      const directory = path.join(this.root, "node_modules", name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: broken ? "0.0.1" : version }));
    }
    const valid = { id: "valid", name: "Valid", root: this.root, status: "active", stack: [], modes: ["read-only"], sourceRoots: [], sources: [], checks: [] };
    const projects = broken ? [{ ...valid, id: "missing", name: "Missing", root: path.join(this.root, "absent") }, valid] : [valid];
    await fs.mkdir(path.join(this.root, "profiles"));
    await fs.writeFile(path.join(this.root, "profiles", "registry.json"), JSON.stringify({ version: 1, projects }));
  }
}

test("health inspects the current runtime, pinned local dependencies and a valid profile", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infra-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new HealthFixture(root).prepare();
  const report = await new HealthInspector(root).inspect();
  assert.equal(report.ok, true);
  assert.deepEqual(report.items.map(item => item.id), ["runtime:node", "dependency:@openai/codex", "dependency:@modelcontextprotocol/sdk", "registry", "profile:valid"]);
  assert.ok(report.items.every(item => item.ok && item.detail.length > 0));
  assert.ok(report.items[0]!.detail.includes(process.versions.node));
});

test("health diagnoses missing and mismatched dependencies and continues after a missing profile root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "infra-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new HealthFixture(root).prepare(true);
  const report = await new HealthInspector(root).inspect();
  const items = new Map(report.items.map(item => [item.id, item]));
  assert.equal(report.ok, false);
  assert.equal(items.get("dependency:@openai/codex")?.ok, false);
  assert.match(items.get("dependency:@openai/codex")!.detail, /manifest is missing/);
  assert.equal(items.get("dependency:@modelcontextprotocol/sdk")?.ok, false);
  assert.match(items.get("dependency:@modelcontextprotocol/sdk")!.detail, /does not match/);
  assert.equal(items.get("profile:missing")?.ok, false);
  assert.match(items.get("profile:missing")!.detail, /root is missing/);
  assert.equal(items.get("profile:valid")?.ok, true);
  assert.ok(report.items.every(item => !item.detail.includes(root)));
});

test('scoped health does not resolve other product roots and rejects an unknown selection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infra-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new HealthFixture(root).prepare();
  const registryPath = path.join(root, 'profiles', 'registry.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  registry.projects.push({...registry.projects[0], id:'other', name:'Other', root:path.join(root,'unavailable-product')});
  await fs.writeFile(registryPath,JSON.stringify(registry));
  const scoped = await new HealthInspector(root).inspect('valid');
  assert.equal(scoped.ok,true);
  assert.deepEqual(scoped.items.filter(item=>item.id.startsWith('profile:')).map(item=>item.id),['profile:valid']);
  const unknown = await new HealthInspector(root).inspect('unknown');
  assert.equal(unknown.ok,false);
  assert.match(unknown.items.find(item=>item.id==='profile:unknown')!.detail,/not registered/);
});
