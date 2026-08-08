import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRoles } from '../src/core/resolve.js';
import type { ModelProfile, Policy } from '../src/core/types.js';

const policy: Policy = {
  version: 1,
  roles: {
    orchestrator: { tier: 'frontier', capabilities: ['planning', 'delegation'], permissions: { read: true, write: false } },
    executor: { tier: 'economy', capabilities: ['coding'], permissions: { read: true, write: true } },
    reviewer: { tier: 'frontier', capabilities: ['review'], permissions: { read: true, write: false } },
  },
  validation: { commands: ['npm test'] },
};

function profile(): ModelProfile {
  return {
    version: 1,
    id: 'portable',
    assignments: {
      orchestrator: { provider: 'frontier-vendor', model: 'frontier-plan', tier: 'frontier', reasoningEffort: 'high', capabilities: ['planning', 'delegation'] },
      executor: { provider: 'economy-vendor', model: 'economy-code', tier: 'economy', reasoningEffort: 'low', capabilities: ['coding'] },
      reviewer: { provider: 'frontier-vendor', model: 'frontier-review', tier: 'frontier', reasoningEffort: 'high', capabilities: ['review'] },
    },
  };
}

test('rejects an assignment missing a required capability', () => {
  const input = profile();
  input.assignments.orchestrator.capabilities = ['planning'];

  assert.throws(() => resolveRoles(policy, input), /orchestrator.*delegation/i);
});

test('resolves an explicit economy executor instead of inheriting the frontier model', () => {
  const resolved = resolveRoles(policy, profile());

  assert.equal(resolved.roles.orchestrator.modelRef, 'frontier-vendor/frontier-plan');
  assert.equal(resolved.roles.executor.modelRef, 'economy-vendor/economy-code');
  assert.equal(resolved.roles.executor.tier, 'economy');
  assert.notEqual(resolved.roles.executor.modelRef, resolved.roles.orchestrator.modelRef);
});

test('rejects a reviewer that reuses the executor provider and model', () => {
  const input = profile();
  input.assignments.reviewer.provider = input.assignments.executor.provider;
  input.assignments.reviewer.model = input.assignments.executor.model;

  assert.throws(() => resolveRoles(policy, input), /reviewer.*independent/i);
});
