import type { GeneratedFile } from '../adapters/index.js';

export interface CodexProjectConfigInputV4 {
  readonly frontier_model: string;
  readonly reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly runtime_entrypoint?: string;
  readonly activation_manifest?: string;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

export function renderCodexProjectConfig(input: CodexProjectConfigInputV4): GeneratedFile {
  if (input.frontier_model.length < 1 || input.frontier_model.length > 256 || /[\u0000-\u001f\u007f]/.test(input.frontier_model))
    throw new Error('INVALID_CONTRACT: invalid frontier model binding');
  if ((input.runtime_entrypoint === undefined) !== (input.activation_manifest === undefined))
    throw new Error('INVALID_CONTRACT: runtime entrypoint and activation manifest must be supplied together');
  for (const value of [input.runtime_entrypoint, input.activation_manifest]) {
    if (value !== undefined && (value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)))
      throw new Error('INVALID_CONTRACT: invalid runtime activation path');
  }
  const args =
    input.runtime_entrypoint === undefined
      ? ['.agent-orchestration/runtime/dist/cli/main.js', 'runtime', 'mcp-stdio']
      : [input.runtime_entrypoint, 'runtime', 'mcp-stdio', '--activation', input.activation_manifest!];
  return Object.freeze({
    path: '.codex/config.toml',
    content: [
      `model = ${toml(input.frontier_model)}`,
      `model_reasoning_effort = ${toml(input.reasoning_effort)}`,
      'cli_auth_credentials_store = "keyring"',
      'forced_login_method = "chatgpt"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      '',
      '[agents]',
      'enabled = true',
      'max_concurrent_threads_per_session = 4',
      '',
      '[mcp_servers.agent_orchestration_v4]',
      'command = "node"',
      `args = [${args.map(toml).join(', ')}]`,
      'required = true',
      'enabled_tools = ["run_coding_task", "repair_coding_task", "finalize_coding_task", "abort_coding_task", "get_coding_task_status", "broker.get_review_packet", "broker.submit_verdict"]',
      'startup_timeout_sec = 10',
      'tool_timeout_sec = 30',
      'default_tools_approval_mode = "auto"',
      '',
    ].join('\n'),
  });
}
