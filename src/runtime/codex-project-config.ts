import type { GeneratedFile } from '../adapters/index.js';

export interface CodexProjectConfigInputV4 {
  readonly frontier_model: string;
  readonly reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

function toml(value: string): string { return JSON.stringify(value); }

export function renderCodexProjectConfig(input: CodexProjectConfigInputV4): GeneratedFile {
  if (input.frontier_model.length < 1 || input.frontier_model.length > 256 || /[\u0000-\u001f\u007f]/.test(input.frontier_model)) throw new Error('INVALID_CONTRACT: invalid frontier model binding');
  return Object.freeze({
    path: '.codex/config.toml',
    content: [
      `model = ${toml(input.frontier_model)}`,
      `model_reasoning_effort = ${toml(input.reasoning_effort)}`,
      'sandbox_mode = "read-only"',
      '',
      '[agents]',
      'enabled = true',
      'max_concurrent_threads_per_session = 4',
      '',
      '[mcp_servers.agent_orchestration_v4]',
      'command = "node"',
      'args = [".agent-orchestration/runtime/dist/cli/main.js", "runtime", "mcp-stdio"]',
      'required = true',
      'enabled_tools = ["run_coding_task", "repair_coding_task", "finalize_coding_task", "abort_coding_task", "get_coding_task_status"]',
      'startup_timeout_sec = 10',
      'tool_timeout_sec = 30',
      'default_tools_approval_mode = "auto"',
      '',
    ].join('\n'),
  });
}
