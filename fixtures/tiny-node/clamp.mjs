export function clampScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Score must be a finite number');
  }
  // Deliberate acceptance-fixture defect: the upper bound is missing.
  return Math.max(0, value);
}
