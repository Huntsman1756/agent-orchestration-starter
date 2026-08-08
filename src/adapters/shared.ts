import type { GeneratedFile, Harness } from './index.js';
import type { ResolvedPolicy } from '../core/types.js';

export function policyManifest(harness: Harness, policy: ResolvedPolicy, path: string): GeneratedFile {
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
    }, null, 2)}\n`,
  };
}

export function contractInstructions(role: 'orchestrator' | 'executor' | 'reviewer', commands: string[]): string {
  if (role === 'orchestrator') {
    return [
      'Plan and coordinate; do not edit project files directly.',
      'Delegate bounded implementation work to the executor using a self-contained work contract.',
      'Every contract must include: id, objective, allowed files, inputs, constraints, validation commands, success criteria, budget, and result format.',
      'Never pass the full conversation. Accept work only after deterministic validation and reviewer evidence.',
    ].join('\n');
  }
  if (role === 'executor') {
    return [
      'Implement only the received work contract and touch only its allowed files.',
      `Run the contract validation commands; project defaults are: ${commands.join('; ')}.`,
      'Return only status, files changed, validation result, and risks. Ask one question instead of guessing when the contract is ambiguous.',
    ].join('\n');
  }
  return [
    'Review the complete diff as an independent checker and remain read-only.',
    `Treat deterministic validation as authoritative: ${commands.join('; ')}.`,
    'Reject scope drift, missing tests, unsafe changes, or failed gates. Return findings with file evidence.',
  ].join('\n');
}
