import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeBindingHealthObservationV4, evaluateRuntimeBindingHealthV4, runtimeBindingHealthAllowsV4 } from '../src/runtime/binding-health.js';

const bindingHash = 'a'.repeat(64);
const policy = { windowSize: 5, minimumObservations: 3, maximumFailureRateBasisPoints: 4_000, maximumConsecutiveFailures: 2, cooldownSeconds: 60, recoveryCanarySuccesses: 2 } as const;
function observation(id: string, recordedAt: string, outcome: Parameters<typeof createRuntimeBindingHealthObservationV4>[0]['outcome'], taskTrait: 'mechanical' | 'semantic-debugging' = 'mechanical') {
  return createRuntimeBindingHealthObservationV4({ schemaVersion: 4, observationId: `health_${id.padEnd(8, '0')}`, bindingHash, taskTrait, recordedAt, outcome });
}

test('quarantines only the failing exact binding and task trait', () => {
  const failures = [
    observation('one', '2026-08-21T10:00:00.000Z', 'VALIDATION_FAILED'),
    observation('two', '2026-08-21T10:01:00.000Z', 'REVIEW_REJECTED'),
  ];
  const snapshot = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations: failures, policy, evaluatedAt: '2026-08-21T10:01:01.000Z' });
  assert.equal(snapshot.status, 'QUARANTINED');
  assert.equal(snapshot.normalRoutingAllowed, false);
  assert.equal(snapshot.recommendedAction, 'QUARANTINE');
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/u);

  const otherTrait = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'semantic-debugging', observations: [], policy, evaluatedAt: '2026-08-21T10:01:01.000Z' });
  assert.equal(otherTrait.status, 'HEALTHY');
});

test('requires cooldown and clean canaries before restoring normal routing', () => {
  const observations = [
    observation('one', '2026-08-21T10:00:00.000Z', 'INVALID_OUTPUT'),
    observation('two', '2026-08-21T10:01:00.000Z', 'INVALID_OUTPUT'),
  ];
  const cooled = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations, policy, evaluatedAt: '2026-08-21T10:02:00.000Z' });
  assert.equal(cooled.recommendedAction, 'RUN_CANARY');
  assert.equal(cooled.normalRoutingAllowed, false);

  const restored = evaluateRuntimeBindingHealthV4({
    bindingHash,
    taskTrait: 'mechanical',
    observations: [...observations, observation('three', '2026-08-21T10:02:01.000Z', 'CANARY_ACCEPTED'), observation('four', '2026-08-21T10:03:01.000Z', 'CANARY_ACCEPTED')],
    policy,
    evaluatedAt: '2026-08-21T10:03:02.000Z',
  });
  assert.equal(restored.status, 'HEALTHY');
  assert.equal(restored.normalRoutingAllowed, true);
});

test('critical false acceptance quarantines immediately and evidence is immutable', () => {
  const value = observation('critical', '2026-08-21T10:00:00.000Z', 'FALSE_ACCEPTANCE');
  const snapshot = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations: [value], policy, evaluatedAt: '2026-08-21T10:00:01.000Z' });
  assert.equal(snapshot.status, 'QUARANTINED');
  assert.throws(() => evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations: [{ ...value, outcome: 'ACCEPTED' }], policy, evaluatedAt: '2026-08-21T10:00:01.000Z' }), /observation hash/);
});

test('rejects ambiguous snapshots for the same binding and task trait', () => {
  const snapshot = evaluateRuntimeBindingHealthV4({ bindingHash, taskTrait: 'mechanical', observations: [], policy, evaluatedAt: '2026-08-21T10:00:01.000Z' });
  assert.throws(
    () => runtimeBindingHealthAllowsV4({ snapshots: [snapshot, { ...snapshot, evaluatedAt: '2026-08-21T10:00:02.000Z', snapshotHash: 'b'.repeat(64) }], bindingHash, taskTraits: ['mechanical'] }),
    /ambiguous/,
  );
});
