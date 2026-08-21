import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAdaptiveExecutionPolicyV4, verifyRuntimeExecutionPolicyV4 } from '../src/runtime/adaptive-execution.js';
import { createRuntimeBindingHealthObservationV4, evaluateRuntimeBindingHealthV4 } from '../src/runtime/binding-health.js';
import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeProfileV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRuntimeProfile, validTaskRequest } from './runtime-contracts.test.js';

function profile(): RuntimeProfileV4 {
  const base = validRuntimeProfile() as RuntimeProfileV4;
  const execution = (supportedTaskTraits: any[], maxSteps: number, supportsFailedCandidateRepair = false) => ({
    supportedTaskTraits,
    maxSteps,
    maxToolUses: maxSteps * 2,
    maxNoMutationSteps: 8,
    timeoutSeconds: 600,
    supportsFailedCandidateRepair,
  });
  return {
    ...base,
    bindings: {
      ...base.bindings,
      executor: { ...base.bindings.executor, execution: execution(['mechanical', 'localized'], 14, true) },
      reasoningExecutor: { ...base.bindings.executor, model: 'reasoning-model', execution: execution(['semantic-debugging', 'cross-file-reasoning', 'multimodal'], 32, true) },
      frontierExecutor: { ...base.bindings.frontierExecutor, execution: execution(['mechanical', 'localized', 'semantic-debugging', 'cross-file-reasoning', 'multimodal', 'long-horizon', 'architecture', 'security-sensitive', 'migration'], 64) },
    },
  };
}

function request(taskTraits: any[], overrides: Partial<RuntimeTaskRequestV4> = {}): RuntimeTaskRequestV4 {
  return {
    ...(validTaskRequest() as RuntimeTaskRequestV4),
    execution_requirements: { taskTraits, contextBytes: 32_768, acceptanceCriteriaCount: 2 },
    ...overrides,
  };
}

test('routes explicit mechanical work to the qualified primary economy binding with adaptive limits', () => {
  const policy = resolveAdaptiveExecutionPolicyV4({ request: request(['mechanical', 'localized']), profile: profile(), sourceSensitivity: 'PUBLIC' });
  assert.equal(policy.lane, 'MECHANICAL_ECONOMY');
  assert.equal(policy.executorRole, 'executor');
  assert.equal(policy.maxSteps, 9);
  assert.equal(policy.maxAttempts, 2);
  assert.equal(policy.repairBase, 'FAILED_CANDIDATE_TREE');
  assert.match(policy.policyHash, /^[a-f0-9]{64}$/u);
});

test('routes semantic debugging to a separately qualified reasoning worker', () => {
  const policy = resolveAdaptiveExecutionPolicyV4({ request: request(['semantic-debugging']), profile: profile(), sourceSensitivity: 'PUBLIC' });
  assert.equal(policy.lane, 'REASONING_ECONOMY');
  assert.equal(policy.executorRole, 'reasoningExecutor');
  assert.ok(policy.maxSteps >= 16);
});

test('elevates reasoning work to frontier when no reasoning binding is qualified', () => {
  const value = profile();
  delete value.bindings.reasoningExecutor;
  const policy = resolveAdaptiveExecutionPolicyV4({ request: request(['semantic-debugging']), profile: value, sourceSensitivity: 'PUBLIC' });
  assert.equal(policy.lane, 'FRONTIER_EXECUTION');
  assert.equal(policy.executorRole, 'frontierExecutor');
  assert.ok(policy.reasons.some((reason) => reason.includes('lack the required')));
});

test('never routes architecture or an explicit frontier request to an economy worker', () => {
  for (const value of [request(['architecture']), request(['mechanical'], { requested_route: 'FRONTIER' })]) {
    const policy = resolveAdaptiveExecutionPolicyV4({ request: value, profile: profile(), sourceSensitivity: 'PUBLIC' });
    assert.equal(policy.lane, 'FRONTIER_EXECUTION');
    assert.equal(policy.maxAttempts, 1);
  }
});

test('legacy task classes retain deterministic conservative classification', () => {
  const mechanical = resolveAdaptiveExecutionPolicyV4({ request: validTaskRequest() as RuntimeTaskRequestV4, profile: profile(), sourceSensitivity: 'PUBLIC' });
  const debugging = resolveAdaptiveExecutionPolicyV4({ request: { ...(validTaskRequest() as RuntimeTaskRequestV4), task_class: 'bug-fix' }, profile: profile(), sourceSensitivity: 'PUBLIC' });
  assert.equal(mechanical.executorRole, 'executor');
  assert.equal(debugging.executorRole, 'reasoningExecutor');
});

test('rejects a budget changed after the broker bound the execution policy', () => {
  const policy = resolveAdaptiveExecutionPolicyV4({ request: request(['mechanical']), profile: profile(), sourceSensitivity: 'PUBLIC' });
  assert.throws(() => verifyRuntimeExecutionPolicyV4({ ...policy, maxSteps: policy.maxSteps + 1 }), /policy hash is invalid/);
});

test('automatically contracts routing away from a quarantined exact binding', () => {
  const value = profile();
  value.bindings.reasoningExecutor = {
    ...value.bindings.reasoningExecutor!,
    execution: { ...value.bindings.reasoningExecutor!.execution!, supportedTaskTraits: ['mechanical', 'localized', 'semantic-debugging', 'cross-file-reasoning', 'multimodal'] },
  };
  const bindingHash = hashCanonicalV4(value.bindings.executor);
  const observations = ['2026-08-21T10:00:00.000Z', '2026-08-21T10:01:00.000Z'].map((recordedAt, index) => createRuntimeBindingHealthObservationV4({
    schemaVersion: 4,
    observationId: `health_failure_${index}`,
    bindingHash,
    taskTrait: 'mechanical',
    recordedAt,
    outcome: 'INVALID_OUTPUT',
  }));
  const snapshot = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations, evaluatedAt: '2026-08-21T10:01:01.000Z' });
  const policy = resolveAdaptiveExecutionPolicyV4({ request: request(['mechanical']), profile: value, sourceSensitivity: 'PUBLIC', bindingHealth: [snapshot] });
  assert.equal(policy.executorRole, 'reasoningExecutor');
  assert.ok(policy.reasons.some((reason) => reason.includes('quarantined')));
  assert.deepEqual(policy.healthEvidenceHashes, [snapshot.snapshotHash]);
});
