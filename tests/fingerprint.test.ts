import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCaseFingerprint } from '../src/routing/fingerprint.js';

test('computes the same case fingerprint for semantically identical key order', () => {
  const first = computeCaseFingerprint({
    workContract: { objective: 'change', constraints: ['bounded'] },
    baseSha: 'A'.repeat(40),
    fixtures: { 'input.json': '{"ok":true}' },
    policy: { validation: ['npm test'], threshold: 0 },
  });
  const second = computeCaseFingerprint({
    policy: { threshold: 0, validation: ['npm test'] },
    fixtures: { 'input.json': '{"ok":true}' },
    baseSha: ` ${'a'.repeat(40)} `,
    workContract: { constraints: ['bounded'], objective: 'change' },
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test('changes the case fingerprint when any comparable condition changes', () => {
  const input = {
    workContract: { objective: 'change' },
    baseSha: 'a'.repeat(40),
    fixtures: { 'input.json': '{"enabled":true}' },
    policy: { threshold: 0 },
  };

  const original = computeCaseFingerprint(input);
  assert.notEqual(original, computeCaseFingerprint({ ...input, workContract: { objective: 'different' } }));
  assert.notEqual(original, computeCaseFingerprint({ ...input, baseSha: 'b'.repeat(40) }));
  assert.notEqual(original, computeCaseFingerprint({ ...input, fixtures: { 'input.json': '{"enabled":false}' } }));
  assert.notEqual(original, computeCaseFingerprint({ ...input, policy: { threshold: 1 } }));
});

test('rejects abbreviated or symbolic base revisions', () => {
  assert.throws(() => computeCaseFingerprint({
    workContract: {},
    baseSha: 'HEAD',
    fixtures: {},
    policy: {},
  }), /full 40- or 64-character hexadecimal base SHA/);
});
