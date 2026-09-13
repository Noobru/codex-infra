import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const text = await fs.readFile(new URL('./sources.md', import.meta.url), 'utf8');
assert.equal((text.match(/^Record [ABC]:/gm) ?? []).length, 3);
assert.match(text, /Atlas.*offline queue.*37 seconds/);
assert.match(text, /Boreal.*online-only.*12 seconds/);
assert.match(text, /Ceres.*offline queue.*61 seconds/);
console.log('Synthetic source invariants passed; semantic answer is checked by the integration caller.');
