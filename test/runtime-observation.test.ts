import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { RuntimeObservation } from '../src/runtime-observation.js';

class RuntimeFixture {
  readonly root = mkdtempSync(path.join(tmpdir(), 'infra-runtime-observation-'));
  constructor(t: TestContext) {
    t.after(() => {
      assert.ok(path.resolve(this.root).startsWith(path.resolve(tmpdir()) + path.sep + 'infra-runtime-observation-'));
      rmSync(this.root, { recursive: true, force: true });
    });
  }
  put(relative: string, content: string): void {
    const file = path.join(this.root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  prepare(): RuntimeObservation {
    this.put('package.json', JSON.stringify({ version: '0.4.0' }));
    this.put('dist/src/recovery.js', 'export const paths = ["src", "templates"];');
    this.put('dist/src/legacy/utils.js', 'export const useful = true;');
    return new RuntimeObservation(this.root);
  }
}

test('runtime observation detects a rebuild without a version bump and preserves the startup fingerprint', t => {
  const fixture = new RuntimeFixture(t);
  const runtime = fixture.prepare();
  const initial = runtime.read();
  assert.equal(initial.loadedVersion, '0.4.0');
  assert.equal(initial.installedVersion, '0.4.0');
  assert.equal(initial.restartRequired, false);
  assert.match(initial.loadedFingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(initial.installedFingerprint, initial.loadedFingerprint);
  assert.deepEqual(initial.warnings, []);

  fixture.put('dist/src/recovery.js', 'export const paths = ["src", "templates", "future"];');
  const updated = runtime.read();
  assert.equal(updated.loadedVersion, updated.installedVersion);
  assert.equal(updated.loadedFingerprint, initial.loadedFingerprint);
  assert.notEqual(updated.installedFingerprint, initial.loadedFingerprint);
  assert.equal(updated.startedAt, initial.startedAt);
  assert.equal(updated.restartRequired, true);
  assert.equal(new RuntimeObservation(fixture.root).read().restartRequired, false);
});

test('runtime observation detects version and executable inventory changes but ignores non-runtime files', t => {
  const fixture = new RuntimeFixture(t);
  const runtime = fixture.prepare();
  const before = runtime.read();
  fixture.put('dist/src/recovery.js.map', '{}');
  fixture.put('dist/src/recovery.d.ts', 'export declare const paths: string[];');
  fixture.put('dist/src/node_modules/excluded.js', 'excluded');
  fixture.put('ui/dist/app.js', 'changed UI');
  fixture.put('src/recovery.ts', 'unbuilt source');
  assert.equal(runtime.read().installedFingerprint, before.loadedFingerprint);
  assert.equal(runtime.read().restartRequired, false);

  fixture.put('package.json', JSON.stringify({ version: '0.4.1' }));
  assert.equal(runtime.read().restartRequired, true);
  assert.equal(runtime.read().installedVersion, '0.4.1');
  fixture.put('package.json', JSON.stringify({ version: '0.4.0' }));
  fixture.put('dist/src/new-module.js', 'export const added = true;');
  assert.equal(runtime.read().restartRequired, true);
});

test('runtime observation keeps unavailable evidence unknown and never modifies installed files', t => {
  const fixture = new RuntimeFixture(t);
  const runtime = new RuntimeObservation(fixture.root);
  const missing = runtime.read();
  assert.equal(missing.loadedVersion, null);
  assert.equal(missing.installedVersion, null);
  assert.equal(missing.loadedFingerprint, null);
  assert.equal(missing.installedFingerprint, null);
  assert.equal(missing.restartRequired, null);
  assert.ok(missing.warnings.length > 0);

  fixture.prepare();
  const installed = runtime.read();
  assert.equal(installed.loadedVersion, null);
  assert.equal(installed.installedVersion, '0.4.0');
  assert.equal(installed.restartRequired, null, 'a late build cannot manufacture a startup fingerprint');
  const current = new RuntimeObservation(fixture.root);
  const invalid = '{"version":';
  fixture.put('package.json', invalid);
  assert.equal(current.read().restartRequired, null);
  assert.equal(readFileSync(path.join(fixture.root, 'package.json'), 'utf8'), invalid);
});
