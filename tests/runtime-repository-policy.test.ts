import assert from 'node:assert/strict';
import test from 'node:test';

import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import type { RuntimeRepositoryPolicyV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy } from './runtime-contracts.test.js';

test('freezes a policy with a stable canonical hash', () => {
  const frozen = freezeRepositoryPolicy(validRepositoryPolicy() as RuntimeRepositoryPolicyV4);

  assert.equal(Object.isFrozen(frozen.policy), true);
  assert.equal('model' in frozen.policy, false);
  assert.match(frozen.hash, /^[a-f0-9]{64}$/);
  assert.equal(
    frozen.hash,
    freezeRepositoryPolicy({
      ...validRepositoryPolicy(),
      validation: { ...validRepositoryPolicy().validation },
    } as RuntimeRepositoryPolicyV4).hash,
  );
});
