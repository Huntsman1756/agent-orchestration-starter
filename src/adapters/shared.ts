import type { GeneratedFile, Harness } from './index.js';
import type { ResolvedPolicy, WriteIsolation } from '../core/types.js';

export function policyManifest(
  harness: Harness,
  policy: ResolvedPolicy,
  path: string,
  effectiveWriteIsolation: WriteIsolation,
): GeneratedFile {
  return {
    path,
    content: `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  };
}

export function contractInstructions(role: 'orchestrator' | 'executor' | 'frontier-executor' | 'reviewer', commands: string[]): string {
  if (role === 'orchestrator') {
    return [
      'Plan and coordinate; do not edit project files directly.',
      'Choose an evidence-supported route: economy_only for mechanical work with strong deterministic gates; orchestrated for hard-to-understand but bounded work; frontier_execution for cross-cutting, ambiguous, security-sensitive, or delicate work.',
      'Delegate implementation using a self-contained work contract. Do not assume orchestrated is the universal route.',
      'Generate acceptance tests first so they define the expected behavior. Then request implementation from the Economy executor.',
      'Every contract must include: id, objective, acceptance_tests, implementation_targets, inputs, constraints, validation commands, success criteria, budget, and result format.',
      'Never pass the full conversation. Accept work only after deterministic validation and reviewer evidence.',
      'If OpenCode configuration must change, authorize only the repository-root `opencode.json`; never edit or rely on personal, user-level, home-directory, or global OpenCode configuration.',
    ].join('\n');
  }
  if (role === 'executor' || role === 'frontier-executor') {
    return [
      'Implement only the received work contract and touch only its implementation_targets.',
      'You are PROHIBITED from editing the supplied acceptance-test files. Your only objective is to modify implementation files so npm test passes.',
      `Run every contract validation command, including static lint and format gates; project defaults are: ${commands.join('; ')}.`,
      'A failed static quality or security gate is deterministic evidence, not a warning. Repair it before reporting completion.',
      'Return only status, files changed, validation result, and risks. Ask one question instead of guessing when the contract is ambiguous.',
      'For OpenCode configuration work, edit only the repository-root `opencode.json` when it is an explicit implementation target; never edit personal, user-level, home-directory, or global OpenCode configuration.',
    ].join('\n');
  }
  return [
    'Start in a fresh review context as an independent checker and remain read-only.',
    'Use only the original work contract, complete diff, deterministic validation results, and files requested on demand.',
    'Exclude planner rationale, executor reasoning, prior verdicts, and the orchestration transcript from review evidence.',
    `Treat deterministic validation as authoritative: ${commands.join('; ')}.`,
    'Reject scope drift, missing tests, unsafe changes, or failed gates. Return findings with file evidence.',
    'Reject any OpenCode change outside the repository-root `opencode.json`, including personal, user-level, home-directory, or global configuration.',
  ].join('\n');
}
