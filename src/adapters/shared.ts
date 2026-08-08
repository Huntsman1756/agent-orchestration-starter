import type { GeneratedFile, Harness } from './index.js';
import type { ResolvedPolicy, WriteIsolation } from '../core/types.js';

export function policyManifest(harness: Harness, policy: ResolvedPolicy, path: string, effectiveWriteIsolation: WriteIsolation): GeneratedFile {
  return {
    path,
    content: `${JSON.stringify({
      schemaVersion: 1,
      harness,
      policyVersion: policy.policyVersion,
      profileVersion: policy.profileVersion,
      profileId: policy.profileId,
      roles: policy.roles,
      validation: policy.validation,
      routing: policy.routing,
      isolation: policy.isolation,
      requiredWriteIsolation: policy.isolation.required,
      effectiveWriteIsolation,
    }, null, 2)}\n`,
  };
}

export function contractInstructions(role: 'orchestrator' | 'executor' | 'frontier-executor' | 'reviewer', commands: string[]): string {
  if (role === 'orchestrator') {
    return [
      'Plan and coordinate; do not edit project files directly.',
      'Choose an evidence-supported route: economy_only for mechanical work with strong deterministic gates; orchestrated for hard-to-understand but bounded work; frontier_execution for cross-cutting, ambiguous, security-sensitive, or delicate work.',
      'Delegate implementation using a self-contained work contract. Do not assume orchestrated is the universal route.',
      'Every contract must include: id, objective, allowed files, inputs, constraints, validation commands, success criteria, budget, and result format.',
      'Never pass the full conversation. Accept work only after deterministic validation and reviewer evidence.',
    ].join('\n');
  }
  if (role === 'executor' || role === 'frontier-executor') {
    return [
      'Implement only the received work contract and touch only its allowed files.',
      `Run the contract validation commands; project defaults are: ${commands.join('; ')}.`,
      'Return only status, files changed, validation result, and risks. Ask one question instead of guessing when the contract is ambiguous.',
    ].join('\n');
  }
  return [
    'Start in a fresh review context as an independent checker and remain read-only.',
    'Use only the original work contract, complete diff, deterministic validation results, and files requested on demand.',
    'Exclude planner rationale, executor reasoning, prior verdicts, and the orchestration transcript from review evidence.',
    `Treat deterministic validation as authoritative: ${commands.join('; ')}.`,
    'Reject scope drift, missing tests, unsafe changes, or failed gates. Return findings with file evidence.',
  ].join('\n');
}
