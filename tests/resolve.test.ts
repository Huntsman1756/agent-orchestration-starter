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
  routing: { strategies: ['economy_only', 'orchestrated', 'frontier_execution'] },
  isolation: { required: 'hard' },
};

function profile(): ModelProfile {
  return {
    version: 1,
    id: 'portable',
    assignments: {
      orchestrator: {
        provider: 'frontier-vendor',
        model: 'frontier-plan',
        tier: 'frontier',
        reasoningEffort: 'high',
        capabilities: ['planning', 'delegation', 'coding'],
      },
      executor: { provider: 'economy-vendor', model: 'economy-code', tier: 'economy', reasoningEffort: 'low', capabilities: ['coding'] },
      reviewer: {
        provider: 'frontier-vendor',
        model: 'frontier-review',
        tier: 'frontier',
        reasoningEffort: 'high',
        capabilities: ['review'],
      },
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

test('rejects role permissions that violate the orchestrate-execute-review boundary', () => {
  const unsafeOrchestrator = structuredClone(policy);
  unsafeOrchestrator.roles.orchestrator.permissions.write = true;
  assert.throws(() => resolveRoles(unsafeOrchestrator, profile()), /orchestrator.*read-only/i);

  const unsafeReviewer = structuredClone(policy);
  unsafeReviewer.roles.reviewer.permissions.write = true;
  assert.throws(() => resolveRoles(unsafeReviewer, profile()), /reviewer.*read-only/i);

  const powerlessExecutor = structuredClone(policy);
  powerlessExecutor.roles.executor.permissions.write = false;
  assert.throws(() => resolveRoles(powerlessExecutor, profile()), /executor.*write/i);
});

test('requires coding capability from the frontier assignment when frontier execution is enabled', () => {
  const input = profile();
  input.assignments.orchestrator.capabilities = ['planning', 'delegation'];

  assert.throws(() => resolveRoles(policy, input), /frontier_execution.*coding/i);
});

test('fails closed when an executor declares agentic tools without qualification evidence', () => {
  const input = profile();
  input.assignments.executor.capabilities.push('agentic_tool_execution');

  assert.throws(() => resolveRoles(policy, input), /agentic_tool_execution.*three clean qualification runs/i);
});

test('accepts only an executor with three clean qualified runs', () => {
  const input = profile();
  input.assignments.executor.capabilities.push('agentic_tool_execution');
  input.assignments.executor.qualification = {
    policyVersion: 'agentic-tool-qualification-v1',
    status: 'VERIFIED',
    cleanRuns: 3,
    requiredCleanRuns: 3,
    evidenceHash: 'a'.repeat(64),
  };

  const resolved = resolveRoles(policy, input);
  assert.equal(resolved.roles.executor.qualification?.cleanRuns, 3);
});
