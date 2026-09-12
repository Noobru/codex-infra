import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampScore } from './clamp.mjs';

test('preserves a finite score and fractions inside the range', () => {
  assert.equal(clampScore(42.5), 42.5);
});

test('lower bound is zero', () => {
  assert.equal(clampScore(-5), 0);
});

test('upper bound is 100', () => {
  assert.equal(clampScore(125), 100);
});

test('accepts both boundaries', () => {
  assert.equal(clampScore(0), 0);
  assert.equal(clampScore(100), 100);
});

test('rejects non-numeric and non-finite scores', () => {
  for (const value of ['42', null, NaN, Infinity, -Infinity]) {
    assert.throws(() => clampScore(value), TypeError);
  }
});
