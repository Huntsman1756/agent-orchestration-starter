import type { GeneratedFile } from './index.js';
import { contractInstructions, policyManifest } from './shared.js';
import type { ResolvedPolicy, ResolvedRole, RoleName, WriteIsolation } from '../core/types.js';

type AgentRole = RoleName | 'frontier-executor';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function assignmentFor(role: AgentRole, policy: ResolvedPolicy): ResolvedRole {
  if (role !== 'frontier-executor') return policy.roles[role];
  return { ...policy.roles.orchestrator, permissions: { ...policy.roles.executor.permissions } };
}

function agentFile(role: AgentRole, policy: ResolvedPolicy): GeneratedFile {
  const assignment = assignmentFor(role, policy);
  const descriptions: Record<AgentRole, string> = {
    orchestrator: 'Frontier planner that delegates bounded work and accepts verified results.',
    executor: 'Economy implementation worker for explicit work contracts.',
    reviewer: 'Independent read-only reviewer for correctness, scope, and validation evidence.',
    'frontier-executor': 'Frontier implementation worker for cross-cutting or high-risk work contracts.',
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

export function compileCodex(policy: ResolvedPolicy, effectiveWriteIsolation: WriteIsolation = 'hard'): GeneratedFile[] {
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
    agentFile('frontier-executor', policy),
    agentFile('reviewer', policy),
    policyManifest('codex', policy, '.agent-orchestration/codex/policy-manifest.json', effectiveWriteIsolation),
  ];
}
