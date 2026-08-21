import { hashCanonicalV4 } from './canonical.js';
import type {
  RuntimeBindingV4,
  RuntimeExecutionLaneV4,
  RuntimeExecutionPolicyV4,
  RuntimeProfileV4,
  RuntimeTaskRequestV4,
  RuntimeTaskTraitV4,
  SourceSensitivityV4,
} from './contracts.js';
import { runtimeBindingHealthAllowsV4, type RuntimeBindingHealthSnapshotV4 } from './binding-health.js';

const frontierTraits = new Set<RuntimeTaskTraitV4>(['architecture', 'security-sensitive', 'migration', 'long-horizon']);
const reasoningTraits = new Set<RuntimeTaskTraitV4>(['semantic-debugging', 'cross-file-reasoning', 'multimodal']);

function inferredTraits(taskClass: string): readonly RuntimeTaskTraitV4[] {
  const value = taskClass.toLowerCase();
  if (/(security|architecture|migration)/u.test(value)) {
    return [value.includes('security') ? 'security-sensitive' : value.includes('migration') ? 'migration' : 'architecture'];
  }
  if (/(debug|reason|cross-file|bug-fix|bugfix)/u.test(value)) return ['semantic-debugging'];
  if (/(multimodal|vision|audio)/u.test(value)) return ['multimodal'];
  if (/(mechanical|localized|fixture|format|docs?)/u.test(value)) return ['mechanical', 'localized'];
  return ['localized'];
}

function executionEnvelope(binding: RuntimeBindingV4, fallbackTraits: readonly RuntimeTaskTraitV4[]) {
  return binding.execution ?? {
    supportedTaskTraits: fallbackTraits,
    maxSteps: binding.guidance.maxSteps,
    maxToolUses: Math.min(256, binding.guidance.maxSteps * 2),
    maxNoMutationSteps: Math.min(8, Math.max(3, Math.ceil(binding.guidance.maxSteps / 4))),
    timeoutSeconds: 300,
    supportsFailedCandidateRepair: false,
  };
}

function qualified(binding: RuntimeBindingV4 | undefined, sensitivity: SourceSensitivityV4, traits: readonly RuntimeTaskTraitV4[], fallbackTraits: readonly RuntimeTaskTraitV4[]): binding is RuntimeBindingV4 {
  if (binding === undefined || binding.permissions !== 'contract-write' || !binding.allowedSourceSensitivity.includes(sensitivity)) return false;
  const supported = new Set(executionEnvelope(binding, fallbackTraits).supportedTaskTraits);
  return traits.every((trait) => supported.has(trait));
}

function healthy(binding: RuntimeBindingV4, traits: readonly RuntimeTaskTraitV4[], snapshots: readonly RuntimeBindingHealthSnapshotV4[]): boolean {
  return runtimeBindingHealthAllowsV4({ snapshots, bindingHash: hashCanonicalV4(binding), taskTraits: traits });
}

function requestedLane(request: RuntimeTaskRequestV4, traits: readonly RuntimeTaskTraitV4[]): RuntimeExecutionLaneV4 {
  if (request.requested_route === 'FRONTIER' || traits.some((trait) => frontierTraits.has(trait))) return 'FRONTIER_EXECUTION';
  if (traits.some((trait) => reasoningTraits.has(trait))) return 'REASONING_ECONOMY';
  return 'MECHANICAL_ECONOMY';
}

export function resolveAdaptiveExecutionPolicyV4(input: {
  readonly request: RuntimeTaskRequestV4;
  readonly profile: RuntimeProfileV4;
  readonly sourceSensitivity: SourceSensitivityV4;
  readonly forceFrontier?: boolean;
  readonly bindingHealth?: readonly RuntimeBindingHealthSnapshotV4[];
}): RuntimeExecutionPolicyV4 {
  const requirements = input.request.execution_requirements;
  const traits = Object.freeze([...(requirements?.taskTraits ?? inferredTraits(input.request.task_class))].sort()) as readonly RuntimeTaskTraitV4[];
  const requested = input.forceFrontier ? 'FRONTIER_EXECUTION' : requestedLane(input.request, traits);
  const reasons: string[] = [`task traits: ${traits.join(', ')}`];
  const bindingHealth = input.bindingHealth ?? [];

  let lane = requested;
  let executorRole: RuntimeExecutionPolicyV4['executorRole'];
  let binding: RuntimeBindingV4;
  const executorQualified = qualified(input.profile.bindings.executor, input.sourceSensitivity, traits, ['mechanical', 'localized']);
  const executorHealthy = executorQualified && healthy(input.profile.bindings.executor, traits, bindingHealth);
  const reasoningBinding = input.profile.bindings.reasoningExecutor;
  const reasoningQualified = qualified(reasoningBinding, input.sourceSensitivity, traits, ['semantic-debugging', 'cross-file-reasoning', 'multimodal']);
  const reasoningHealthy = reasoningQualified && healthy(reasoningBinding, traits, bindingHealth);
  if (executorQualified && !executorHealthy) reasons.push('primary economy binding is quarantined for a requested task trait');
  if (reasoningQualified && !reasoningHealthy) reasons.push('reasoning economy binding is quarantined for a requested task trait');
  if (lane === 'MECHANICAL_ECONOMY' && executorHealthy) {
    executorRole = 'executor';
    binding = input.profile.bindings.executor;
  } else if (lane !== 'FRONTIER_EXECUTION' && reasoningHealthy) {
    lane = 'REASONING_ECONOMY';
    executorRole = 'reasoningExecutor';
    binding = reasoningBinding;
    if (requested === 'MECHANICAL_ECONOMY') reasons.push('primary economy binding lacks the required qualified traits');
  } else {
    lane = 'FRONTIER_EXECUTION';
    executorRole = 'frontierExecutor';
    binding = input.profile.bindings.frontierExecutor;
    if (!qualified(binding, input.sourceSensitivity, traits, traits)) {
      throw new Error('CAPABILITY_UNVERIFIED: no writable binding supports the requested task traits and source sensitivity');
    }
    if (!healthy(binding, traits, bindingHealth)) throw new Error('CAPABILITY_UNVERIFIED: frontier binding is quarantined for a requested task trait');
    if (requested !== lane) reasons.push('economy bindings lack the required qualified traits');
  }

  const envelope = executionEnvelope(binding, traits);
  const files = input.request.implementation_targets.length;
  const criteria = requirements?.acceptanceCriteriaCount ?? input.request.success_criteria.length;
  const laneFloor = lane === 'MECHANICAL_ECONOMY' ? 8 : lane === 'REASONING_ECONOMY' ? 16 : 24;
  const desiredSteps = laneFloor + Math.min(12, Math.max(0, files - 1) * 2) + Math.min(8, Math.max(0, criteria - 1));
  const maxSteps = Math.min(envelope.maxSteps, desiredSteps);
  const maxNoMutationSteps = Math.min(envelope.maxNoMutationSteps, Math.max(3, files + 2), Math.max(1, maxSteps - 1));
  const maxToolUses = Math.min(envelope.maxToolUses, Math.max(maxSteps, maxSteps * 2));
  const maxAttempts = lane === 'FRONTIER_EXECUTION' ? 1 : Math.min(2, input.request.max_attempts);
  const repairBase = maxAttempts > 1 && envelope.supportsFailedCandidateRepair
    ? 'FAILED_CANDIDATE_TREE' as const
    : 'LAST_ACCEPTED_TREE' as const;
  reasons.push(`selected ${executorRole} with ${maxSteps} steps and ${maxAttempts} attempt(s)`);
  const body = {
    lane,
    executorRole,
    taskTraits: traits,
    maxSteps,
    maxToolUses,
    maxNoMutationSteps,
    timeoutSeconds: envelope.timeoutSeconds,
    maxAttempts,
    repairBase,
    reasons: Object.freeze(reasons),
    healthEvidenceHashes: Object.freeze(bindingHealth.map((value) => value.snapshotHash).sort()),
  };
  return Object.freeze({ ...body, policyHash: hashCanonicalV4(body) });
}

export function verifyRuntimeExecutionPolicyV4(policy: RuntimeExecutionPolicyV4): RuntimeExecutionPolicyV4 {
  const { policyHash, ...body } = policy;
  if (policyHash !== hashCanonicalV4(body)) throw new Error('INVALID_CONTRACT: adaptive execution policy hash is invalid');
  return policy;
}
