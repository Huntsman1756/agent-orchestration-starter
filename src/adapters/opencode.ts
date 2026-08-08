import { stringify } from 'yaml';

import type { GeneratedFile } from './index.js';
import { contractInstructions, policyManifest } from './shared.js';
import { providerFor } from '../core/providers.js';
import type { ResolvedPolicy, RoleName } from '../core/types.js';

function agentFile(role: RoleName, policy: ResolvedPolicy): GeneratedFile {
  const assignment = policy.roles[role];
  const descriptions: Record<RoleName, string> = {
    orchestrator: 'Frontier planner that delegates bounded work and accepts verified results',
    executor: 'Economy implementation worker for explicit work contracts',
    reviewer: 'Independent read-only reviewer for correctness and validation evidence',
  };
  const bash: Record<string, 'allow' | 'ask' | 'deny'> = { '*': 'ask' };
  if (!assignment.permissions.write) {
    bash['git diff*'] = 'allow';
    bash['git status*'] = 'allow';
  }
  for (const command of policy.validation.commands) bash[`${command}*`] = 'allow';
  const frontmatter = stringify({
    description: descriptions[role],
    mode: role === 'orchestrator' ? 'primary' : 'subagent',
    model: `${providerFor(assignment, 'opencode')}/${assignment.model}`,
    temperature: role === 'executor' ? 0.1 : 0,
    permission: {
      read: assignment.permissions.read ? 'allow' : 'deny',
      edit: assignment.permissions.write ? 'allow' : 'deny',
      external_directory: 'deny',
      task: role === 'orchestrator' ? 'allow' : 'deny',
      bash,
    },
  }, { lineWidth: 0 });
  return {
    path: `.opencode/agents/${role}.md`,
    content: `---\n${frontmatter}---\n${contractInstructions(role, policy.validation.commands)}\n`,
  };
}

export function compileOpenCode(policy: ResolvedPolicy): GeneratedFile[] {
  return [
    agentFile('orchestrator', policy),
    agentFile('executor', policy),
    agentFile('reviewer', policy),
    policyManifest('opencode', policy, '.agent-orchestration/opencode/policy-manifest.json'),
  ];
}
