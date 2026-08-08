import { stringify } from 'yaml';

import type { GeneratedFile } from './index.js';
import { policyManifest } from './shared.js';
import type { ResolvedPolicy } from '../core/types.js';

export function compileHermes(policy: ResolvedPolicy): GeneratedFile[] {
  const orchestrator = policy.roles.orchestrator;
  const executor = policy.roles.executor;
  const reviewer = policy.roles.reviewer;
  if (reviewer.modelRef !== orchestrator.modelRef) {
    throw new Error('Hermes requires the reviewer to use the same frontier parent model as the orchestrator');
  }
  const distribution = stringify({
    name: 'agent-orchestration-starter',
    version: `${policy.policyVersion}.${policy.profileVersion}.0`,
    description: 'Frontier orchestrator and reviewer with an economy delegation model',
    distribution_owned: ['SOUL.md', 'config.yaml', 'policy-manifest.json', 'PERMISSION_BOUNDARY.md'],
  }, { lineWidth: 0 });
  const config = stringify({
    model: { provider: orchestrator.provider, default: orchestrator.model },
    delegation: {
      provider: executor.provider,
      model: executor.model,
      max_concurrent_children: 3,
      max_spawn_depth: 1,
      orchestrator_enabled: false,
    },
    fallback_providers: [],
  }, { lineWidth: 0 });
  const soul = [
    '# Agent orchestration role',
    '',
    'You are the frontier orchestrator and independent reviewer. Plan and review; delegate implementation instead of editing directly.',
    'Pass each child only a self-contained work contract with id, objective, allowed files, inputs, constraints, validation commands, success criteria, budget, and result format.',
    'The child returns only status, files changed, validation result, and risks. Never pass the full conversation.',
    `Require deterministic validation before acceptance: ${policy.validation.commands.join('; ')}. Failed deterministic gates are authoritative and cannot be overruled by model judgment.`,
    'Automatic provider fallback is disabled. Authentication, policy, invalid output, grounding, and validation failures fail closed.',
    '',
  ].join('\n');
  const permissionBoundary = [
    '# Hermes permission boundary',
    '',
    'Hermes delegation inherits the parent tool surface, so v1 cannot machine-enforce a read-only parent while granting write tools to the child.',
    'The no-direct-write rule is instruction-enforced in SOUL.md. Run Hermes in a worktree and keep deterministic validation and Git review as hard gates.',
    '',
  ].join('\n');
  return [
    { path: 'hermes-profile/distribution.yaml', content: distribution },
    { path: 'hermes-profile/config.yaml', content: config },
    { path: 'hermes-profile/SOUL.md', content: soul },
    { path: 'hermes-profile/PERMISSION_BOUNDARY.md', content: permissionBoundary },
    policyManifest('hermes', policy, 'hermes-profile/policy-manifest.json'),
  ];
}
