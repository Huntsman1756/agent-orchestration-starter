import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeTaskTraitV4 } from './contracts.js';

export type RuntimeBindingHealthOutcomeV4 =
  | 'ACCEPTED'
  | 'CANARY_ACCEPTED'
  | 'VALIDATION_FAILED'
  | 'REVIEW_REJECTED'
  | 'INVALID_OUTPUT'
  | 'BUDGET_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'AUTHORITY_VIOLATION'
  | 'FALSE_ACCEPTANCE';

export interface RuntimeBindingHealthObservationV4 {
  readonly schemaVersion: 4;
  readonly observationId: string;
  readonly bindingHash: string;
  readonly taskTrait: RuntimeTaskTraitV4;
  readonly recordedAt: string;
  readonly outcome: RuntimeBindingHealthOutcomeV4;
  readonly observationHash: string;
}

export interface RuntimeBindingHealthPolicyV4 {
  readonly windowSize: number;
  readonly minimumObservations: number;
  readonly maximumFailureRateBasisPoints: number;
  readonly maximumConsecutiveFailures: number;
  readonly cooldownSeconds: number;
  readonly recoveryCanarySuccesses: number;
}

export interface RuntimeBindingHealthSnapshotV4 {
  readonly schemaVersion: 4;
  readonly bindingHash: string;
  readonly taskTrait: RuntimeTaskTraitV4;
  readonly evaluatedAt: string;
  readonly status: 'HEALTHY' | 'QUARANTINED' | 'PROBATION';
  readonly normalRoutingAllowed: boolean;
  readonly recommendedAction: 'USE' | 'QUARANTINE' | 'RUN_CANARY';
  readonly consecutiveFailures: number;
  readonly failureRateBasisPoints: number;
  readonly recoveryCanarySuccesses: number;
  readonly quarantineTriggeredAt: string | null;
  readonly observationHashes: readonly string[];
  readonly policyHash: string;
  readonly snapshotHash: string;
}

export const DEFAULT_RUNTIME_BINDING_HEALTH_POLICY_V4: RuntimeBindingHealthPolicyV4 = Object.freeze({
  windowSize: 20,
  minimumObservations: 5,
  maximumFailureRateBasisPoints: 4_000,
  maximumConsecutiveFailures: 2,
  cooldownSeconds: 3_600,
  recoveryCanarySuccesses: 3,
});

const hashPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^health_[A-Za-z0-9_-]{8,96}$/u;
const taskTraits = new Set<RuntimeTaskTraitV4>(['mechanical', 'localized', 'semantic-debugging', 'cross-file-reasoning', 'multimodal', 'long-horizon', 'architecture', 'security-sensitive', 'migration']);
const failures = new Set<RuntimeBindingHealthOutcomeV4>(['VALIDATION_FAILED', 'REVIEW_REJECTED', 'INVALID_OUTPUT', 'BUDGET_EXCEEDED', 'PROVIDER_UNAVAILABLE', 'AUTHORITY_VIOLATION', 'FALSE_ACCEPTANCE']);
const criticalFailures = new Set<RuntimeBindingHealthOutcomeV4>(['AUTHORITY_VIOLATION', 'FALSE_ACCEPTANCE']);

function invalid(message: string): never { throw new Error(`INVALID_BINDING_HEALTH_EVIDENCE: ${message}`); }
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid('timestamp is not canonical UTC');
  return parsed;
}
function positive(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(`${label} is outside policy`);
}
function verifyPolicy(policy: RuntimeBindingHealthPolicyV4): string {
  positive(policy.windowSize, 1_000, 'windowSize');
  positive(policy.minimumObservations, policy.windowSize, 'minimumObservations');
  positive(policy.maximumFailureRateBasisPoints, 10_000, 'maximumFailureRateBasisPoints');
  positive(policy.maximumConsecutiveFailures, policy.windowSize, 'maximumConsecutiveFailures');
  positive(policy.cooldownSeconds, 2_592_000, 'cooldownSeconds');
  positive(policy.recoveryCanarySuccesses, 100, 'recoveryCanarySuccesses');
  return hashCanonicalV4(policy);
}

export function createRuntimeBindingHealthObservationV4(input: Omit<RuntimeBindingHealthObservationV4, 'observationHash'>): RuntimeBindingHealthObservationV4 {
  if (input.schemaVersion !== 4 || !idPattern.test(input.observationId) || !hashPattern.test(input.bindingHash) || !taskTraits.has(input.taskTrait)) invalid('observation identity is invalid');
  timestamp(input.recordedAt);
  if (![...failures, 'ACCEPTED', 'CANARY_ACCEPTED'].includes(input.outcome)) invalid('outcome is invalid');
  const body = structuredClone(input);
  return Object.freeze({ ...body, observationHash: hashCanonicalV4(body) });
}

function loadObservation(value: RuntimeBindingHealthObservationV4): RuntimeBindingHealthObservationV4 {
  const copy = structuredClone(value);
  const { observationHash, ...body } = copy;
  if (!hashPattern.test(observationHash) || observationHash !== hashCanonicalV4(body)) invalid('observation hash is invalid');
  return createRuntimeBindingHealthObservationV4(body);
}

export function evaluateRuntimeBindingHealthV4(input: {
  readonly bindingHash: string;
  readonly taskTrait: RuntimeTaskTraitV4;
  readonly observations: readonly RuntimeBindingHealthObservationV4[];
  readonly policy?: RuntimeBindingHealthPolicyV4;
  readonly evaluatedAt: string;
}): RuntimeBindingHealthSnapshotV4 {
  if (!hashPattern.test(input.bindingHash) || !taskTraits.has(input.taskTrait)) invalid('binding scope is invalid');
  const evaluatedAt = timestamp(input.evaluatedAt);
  const policy = Object.freeze({ ...(input.policy ?? DEFAULT_RUNTIME_BINDING_HEALTH_POLICY_V4) });
  const policyHash = verifyPolicy(policy);
  const observations = input.observations.map(loadObservation).sort((left, right) => timestamp(left.recordedAt) - timestamp(right.recordedAt) || left.observationId.localeCompare(right.observationId));
  if (new Set(observations.map((value) => value.observationId)).size !== observations.length) invalid('observation IDs are not unique');
  if (observations.some((value) => value.bindingHash !== input.bindingHash || value.taskTrait !== input.taskTrait || timestamp(value.recordedAt) > evaluatedAt)) invalid('observation scope or time is invalid');

  let status: RuntimeBindingHealthSnapshotV4['status'] = 'HEALTHY';
  let quarantineTriggeredAt: string | null = null;
  let recoveryCanarySuccesses = 0;
  let recent: RuntimeBindingHealthObservationV4[] = [];
  let consecutiveFailures = 0;
  for (const observation of observations) {
    const failed = failures.has(observation.outcome);
    if (status === 'HEALTHY') {
      if (observation.outcome !== 'CANARY_ACCEPTED') recent = [...recent, observation].slice(-policy.windowSize);
      consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
      const failureCount = recent.filter((value) => failures.has(value.outcome)).length;
      const failureRate = recent.length === 0 ? 0 : Math.round((failureCount * 10_000) / recent.length);
      if (criticalFailures.has(observation.outcome)
        || consecutiveFailures >= policy.maximumConsecutiveFailures
        || (recent.length >= policy.minimumObservations && failureRate > policy.maximumFailureRateBasisPoints)) {
        status = 'QUARANTINED';
        quarantineTriggeredAt = observation.recordedAt;
        recoveryCanarySuccesses = 0;
      }
      continue;
    }
    if (failed) {
      status = 'QUARANTINED';
      quarantineTriggeredAt = observation.recordedAt;
      recoveryCanarySuccesses = 0;
      consecutiveFailures += 1;
      continue;
    }
    const cooldownEndedAt = timestamp(quarantineTriggeredAt!) + policy.cooldownSeconds * 1_000;
    if (observation.outcome === 'CANARY_ACCEPTED' && timestamp(observation.recordedAt) >= cooldownEndedAt) {
      recoveryCanarySuccesses += 1;
      status = 'PROBATION';
      if (recoveryCanarySuccesses >= policy.recoveryCanarySuccesses) {
        status = 'HEALTHY';
        quarantineTriggeredAt = null;
        consecutiveFailures = 0;
        recent = [];
      }
    }
  }
  const window = recent.slice(-policy.windowSize);
  const failureCount = window.filter((value) => failures.has(value.outcome)).length;
  const failureRateBasisPoints = window.length === 0 ? 0 : Math.round((failureCount * 10_000) / window.length);
  const cooldownElapsed = quarantineTriggeredAt !== null && evaluatedAt >= timestamp(quarantineTriggeredAt) + policy.cooldownSeconds * 1_000;
  const recommendedAction: RuntimeBindingHealthSnapshotV4['recommendedAction'] = status === 'HEALTHY' ? 'USE' : cooldownElapsed ? 'RUN_CANARY' : 'QUARANTINE';
  const body = {
    schemaVersion: 4 as const,
    bindingHash: input.bindingHash,
    taskTrait: input.taskTrait,
    evaluatedAt: input.evaluatedAt,
    status,
    normalRoutingAllowed: status === 'HEALTHY',
    recommendedAction,
    consecutiveFailures,
    failureRateBasisPoints,
    recoveryCanarySuccesses,
    quarantineTriggeredAt,
    observationHashes: Object.freeze(observations.map((value) => value.observationHash)),
    policyHash,
  };
  return Object.freeze({ ...body, snapshotHash: hashCanonicalV4(body) });
}

export function runtimeBindingHealthAllowsV4(input: {
  readonly snapshots: readonly RuntimeBindingHealthSnapshotV4[];
  readonly bindingHash: string;
  readonly taskTraits: readonly RuntimeTaskTraitV4[];
}): boolean {
  const scopes = input.snapshots.map((value) => `${value.bindingHash}:${value.taskTrait}`);
  if (input.snapshots.length > 128
    || new Set(input.snapshots.map((value) => value.snapshotHash)).size !== input.snapshots.length
    || new Set(scopes).size !== scopes.length) invalid('snapshot set is unbounded, duplicated or ambiguous');
  for (const snapshot of input.snapshots) {
    const { snapshotHash, ...body } = snapshot;
    timestamp(snapshot.evaluatedAt);
    if (!hashPattern.test(snapshot.bindingHash) || !taskTraits.has(snapshot.taskTrait) || snapshotHash !== hashCanonicalV4(body)) invalid('snapshot hash or scope is invalid');
  }
  return input.taskTraits.every((trait) => {
    const snapshot = input.snapshots.find((value) => value.bindingHash === input.bindingHash && value.taskTrait === trait);
    return snapshot?.normalRoutingAllowed ?? true;
  });
}
