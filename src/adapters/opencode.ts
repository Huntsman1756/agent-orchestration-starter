import { stringify } from 'yaml';

import type { GeneratedFile } from './index.js';
import { contractInstructions, policyManifest } from './shared.js';
import { providerFor } from '../core/providers.js';
import type { ResolvedPolicy, ResolvedRole, RoleName, WriteIsolation } from '../core/types.js';

type AgentRole = RoleName | 'frontier-executor';

function assignmentFor(role: AgentRole, policy: ResolvedPolicy): ResolvedRole {
  if (role !== 'frontier-executor') return policy.roles[role];
  return { ...policy.roles.orchestrator, permissions: { ...policy.roles.executor.permissions } };
}

function agentFile(role: AgentRole, policy: ResolvedPolicy): GeneratedFile {
  const assignment = assignmentFor(role, policy);
  const descriptions: Record<AgentRole, string> = {
    orchestrator: 'Frontier planner that delegates bounded work and accepts verified results',
    executor: 'Economy implementation worker for explicit work contracts',
    reviewer: 'Independent read-only reviewer for correctness and validation evidence',
    'frontier-executor': 'Frontier implementation worker for cross-cutting or high-risk work contracts',
  };
  const bash: Record<string, 'allow' | 'ask' | 'deny'> = {
    '*': assignment.permissions.write ? 'ask' : 'deny',
  };
  if (assignment.permissions.write) {
    for (const command of policy.validation.commands) bash[`${command}*`] = 'allow';
  }
  const frontmatter = stringify({
    description: descriptions[role],
    mode: role === 'orchestrator' ? 'primary' : 'subagent',
    model: `${providerFor(assignment, 'opencode')}/${assignment.model}`,
    temperature: role === 'executor' || role === 'frontier-executor' ? 0.1 : 0,
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

export function compileOpenCode(policy: ResolvedPolicy, effectiveWriteIsolation: WriteIsolation = 'hard'): GeneratedFile[] {
  return [
    agentFile('orchestrator', policy),
    agentFile('executor', policy),
    agentFile('frontier-executor', policy),
    agentFile('reviewer', policy),
    policyManifest('opencode', policy, '.agent-orchestration/opencode/policy-manifest.json', effectiveWriteIsolation),
  ];
}
