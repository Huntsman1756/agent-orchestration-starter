import type { GeneratedFile } from './index.js';
import { contractInstructions, policyManifest } from './shared.js';
import type { ResolvedPolicy, RoleName } from '../core/types.js';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function agentFile(role: RoleName, policy: ResolvedPolicy): GeneratedFile {
  const assignment = policy.roles[role];
  const descriptions: Record<RoleName, string> = {
    orchestrator: 'Frontier planner that delegates bounded work and accepts verified results.',
    executor: 'Economy implementation worker for explicit work contracts.',
    reviewer: 'Independent read-only reviewer for correctness, scope, and validation evidence.',
  };
  const sandbox = assignment.permissions.write ? 'workspace-write' : 'read-only';
  const instructions = contractInstructions(role, policy.validation.commands);
  return {
    path: `.codex/agents/${role}.toml`,
    content: [
      `name = ${tomlString(role)}`,
      `description = ${tomlString(descriptions[role])}`,
      `model = ${tomlString(assignment.model)}`,
      `model_reasoning_effort = ${tomlString(assignment.reasoningEffort)}`,
      `sandbox_mode = ${tomlString(sandbox)}`,
      'developer_instructions = """',
      instructions,
      '"""',
      '',
    ].join('\n'),
  };
}

export function compileCodex(policy: ResolvedPolicy): GeneratedFile[] {
  const orchestrator = policy.roles.orchestrator;
  return [
    {
      path: '.codex/config.toml',
      content: [
        `model = ${tomlString(orchestrator.model)}`,
        `model_reasoning_effort = ${tomlString(orchestrator.reasoningEffort)}`,
        '',
        '[agents]',
        'enabled = true',
        'max_concurrent_threads_per_session = 4',
        '',
      ].join('\n'),
    },
    agentFile('orchestrator', policy),
    agentFile('executor', policy),
    agentFile('reviewer', policy),
    policyManifest('codex', policy, '.agent-orchestration/codex/policy-manifest.json'),
  ];
}
