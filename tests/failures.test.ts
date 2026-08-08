import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFailure, mayFallback } from '../src/core/failures.js';

test('allows fallback for typed availability failures', () => {
  const classification = classifyFailure({ code: 'ETIMEDOUT', message: 'provider timed out' });

  assert.equal(classification, 'availability');
  assert.equal(mayFallback(classification), true);
});

test('fails closed for authentication, policy, invalid output, grounding, and validation failures', () => {
  const inputs = [
    [{ code: 'UNAUTHORIZED', message: 'invalid api key' }, 'authentication'],
    [{ code: 'POLICY_DENIED', message: 'model is not allowed' }, 'policy'],
    [{ code: 'INVALID_OUTPUT', message: 'schema mismatch' }, 'invalid_output'],
    [{ code: 'GROUNDING_FAILED', message: 'citation missing' }, 'grounding'],
    [{ code: 'VALIDATION_FAILED', message: 'tests failed' }, 'validation'],
  ] as const;

  for (const [input, expected] of inputs) {
    const classification = classifyFailure(input);
    assert.equal(classification, expected);
    assert.equal(mayFallback(classification), false);
  }
});
