import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLeafSimilaritiesForCode } from '../out-server/similarity.js';

test('returns no similarities when the target is the only leaf', () => {
  const target = { id: 1, code: 'function add(a, b) { return a + b; }', isLeaf: true };
  const result = computeLeafSimilaritiesForCode({ nodes: [target] }, target);

  assert.deepEqual(result, []);
});

test('excludes the target node and ignores non-leaf nodes', () => {
  const target = { id: 1, code: 'const total = price + tax;', isLeaf: true };
  const nonLeaf = { id: 2, code: 'const total = price + tax;', isLeaf: false };
  const otherLeaf = { id: 3, code: 'const name = user.name;', isLeaf: true };

  const result = computeLeafSimilaritiesForCode({ nodes: [target, nonLeaf, otherLeaf] }, target);

  assert.deepEqual(result.map(item => item.id), [3]);
});

test('sorts leaf similarities in descending order', () => {
  const target = { id: 1, code: 'function add(a, b) { return a + b; }', isLeaf: true };
  const similar = { id: 2, code: 'function add(x, y) { return x + y; }', isLeaf: true };
  const different = { id: 3, code: 'class UserSession { login() { return true; } }', isLeaf: true };

  const result = computeLeafSimilaritiesForCode({ nodes: [target, different, similar] }, target);

  assert.equal(result.length, 2);
  assert.equal(result[0].id, 2);
  assert.equal(result[1].id, 3);
  assert.ok(result[0].similarity >= result[1].similarity);
});

test('handles empty code strings without crashing', () => {
  const target = { id: 1, code: '', isLeaf: true };
  const other = { id: 2, code: '', isLeaf: true };

  const result = computeLeafSimilaritiesForCode({ nodes: [target, other] }, target);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
  assert.equal(result[0].similarity, 0);
});

test('tokenization is case-insensitive and punctuation-tolerant', () => {
  const target = { id: 1, code: 'ALPHA_BETA GAMMA DELTA;', isLeaf: true };
  const sameTokens = { id: 2, code: 'alpha_beta gamma delta', isLeaf: true };
  const other = { id: 3, code: 'render dashboard widgets', isLeaf: true };

  const result = computeLeafSimilaritiesForCode({ nodes: [target, other, sameTokens] }, target);

  assert.equal(result[0].id, 2);
  assert.ok(result[0].similarity > 0.99);
  assert.ok(result[0].similarity > result[1].similarity);
});
