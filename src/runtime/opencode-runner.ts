import type { ResolvedBindingV4 } from './bindings.js';
import { assertFreshCapability, type CapabilityIdentityV4, type CapabilityRecordV4 } from './capabilities.js';
import { validateCredentialLeaseV4, type CredentialAdapterV4 } from './credential-adapter.js';
import type { AllowedChangeV4 } from './contracts.js';
import { enforceDiffPolicy, type DiffPolicyResultV4 } from './diff-policy.js';
import { writeBrokerOpenCodeConfigV4 } from './opencode-config.js';
import type { ProcessSandboxBackendV4 } from './process-sandbox.js';

export interface ExecutorAttemptInputV4 {
  readonly execution_id: string;
  readonly binding: ResolvedBindingV4;
  readonly capability: CapabilityRecordV4;
  readonly capsule_root: string;
  readonly worktree_root: string;
  readonly agent: string;
  readonly objective: string;
  readonly base_sha: string;
  readonly allowed_changes: readonly AllowedChangeV4[];
  readonly max_files_changed: number;
  readonly max_changed_lines: number;
  readonly expected_sandbox_policy_hash: string;
  readonly attempt_number: 1 | 2;
  readonly repair_finding_hashes?: readonly string[];
  readonly review_rejection_hashes?: readonly string[];
  readonly escalation_decision_hash?: string;
}

export interface ExecutorAttemptResultV4 {
  readonly session_id: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly diff: DiffPolicyResultV4;
}

export interface OpenCodeRunnerV4 { execute(input: ExecutorAttemptInputV4): Promise<ExecutorAttemptResultV4>; }

export interface OpenCodeRunnerDependenciesV4 {
  readonly sandbox: ProcessSandboxBackendV4;
  readonly credentials: CredentialAdapterV4;
  readonly harness_argv: readonly string[];
  readonly capability_identity_for: (binding: ResolvedBindingV4) => CapabilityIdentityV4;
  readonly now?: () => string;
  readonly enforce_diff?: typeof enforceDiffPolicy;
}

function invalid(message: string): never { throw new Error(`EXECUTOR_INVALID_OUTPUT: ${message}`); }

function parseEvents(stdout: string): { events: readonly Readonly<Record<string, unknown>>[]; sessionId: string } {
  if (stdout.includes('<tool_call>')) invalid('textual tool-call leakage');
  const events: Readonly<Record<string, unknown>>[] = [];
  for (const line of stdout.split('\n').filter((value) => value.length > 0)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { invalid('non-JSON event'); }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) invalid('event is not an object');
    const frozen = Object.freeze({ ...(event as Record<string, unknown>) });
    const type = frozen.type;
    if (!['message', 'tool', 'result'].includes(String(type))) invalid(`unexpected event type: ${String(type)}`);
    if (type === 'tool' && !['read', 'glob', 'grep', 'edit'].includes(String(frozen.name))) invalid(`unexpected tool: ${String(frozen.name)}`);
    events.push(frozen);
  }
  const terminals = events.filter((event) => event.type === 'result');
  const terminal = terminals[0];
  if (terminals.length !== 1 || terminal !== events.at(-1) || terminal?.status !== 'completed'
    || typeof terminal.session_id !== 'string' || terminal.session_id.length < 1 || terminal.session_id.length > 128) {
    invalid('missing or malformed terminal result');
  }
  return { events: Object.freeze(events), sessionId: terminal.session_id };
}

export function createOpenCodeRunner(deps: OpenCodeRunnerDependenciesV4): OpenCodeRunnerV4 {
  if (deps.harness_argv.length < 1 || deps.harness_argv.some((value) => value.length < 1 || value.includes('\0'))) {
    throw new Error('BROKER_STATE_CORRUPT: OpenCode executable argv is invalid');
  }
  return Object.freeze({
    execute: async (input: ExecutorAttemptInputV4): Promise<ExecutorAttemptResultV4> => {
      const now = (deps.now ?? (() => new Date().toISOString()))();
      assertFreshCapability(input.capability, deps.capability_identity_for(input.binding), now);
      if (input.attempt_number !== 1 && input.attempt_number !== 2) throw new Error('EXECUTOR_POLICY_VIOLATION: attempt number is outside policy');
      if (input.agent !== input.binding.role) throw new Error('EXECUTOR_POLICY_VIOLATION: selected agent does not match the binding role');
      const validHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
      if (input.attempt_number === 2 && ((input.repair_finding_hashes?.length ?? 0) < 1 || !input.repair_finding_hashes?.every(validHash))) {
        throw new Error('EXECUTOR_POLICY_VIOLATION: repair attempt lacks persisted findings');
      }
      if (input.binding.role === 'frontierExecutor'
        && ((input.review_rejection_hashes?.length ?? 0) < 2
          || !input.review_rejection_hashes?.every(validHash)
          || input.escalation_decision_hash === undefined
          || !validHash(input.escalation_decision_hash))) {
        throw new Error('EXECUTOR_POLICY_VIOLATION: frontier execution lacks persisted escalation authority');
      }
      const sandboxProbe = await deps.sandbox.probe('EXECUTOR_NETWORKED');
      if (sandboxProbe.status !== 'SUPPORTED'
        || sandboxProbe.policy_hash !== input.expected_sandbox_policy_hash
        || !validHash(input.expected_sandbox_policy_hash)
        || Date.parse(sandboxProbe.expires_at) <= Date.parse(now)) {
        throw new Error('PROCESS_SANDBOX_UNAVAILABLE: executor sandbox is not freshly certified');
      }
      const lease = validateCredentialLeaseV4(await deps.credentials.lease(input.binding), now);
      try {
        const config = await writeBrokerOpenCodeConfigV4({ capsule_root: input.capsule_root, binding: input.binding, provider_endpoint: lease.provider_endpoint, allowed_changes: input.allowed_changes });
        const environment = Object.freeze({
          ...lease.environment,
          AO_EXECUTION_ID: input.execution_id,
          HOME: '/capsule/home',
          TMPDIR: '/capsule/tmp',
          XDG_CACHE_HOME: '/capsule/cache',
          XDG_CONFIG_HOME: '/capsule/config/disabled-global',
          OPENCODE_CONFIG_DIR: '/capsule/config',
          OPENCODE_CONFIG: config.container_path,
        });
        const diffInput = { repository_root: input.worktree_root, base_sha: input.base_sha, allowed_changes: input.allowed_changes, max_files_changed: input.max_files_changed, max_changed_lines: input.max_changed_lines };
        let result;
        try {
          result = await deps.sandbox.run({
            execution_id: input.execution_id,
            profile: 'EXECUTOR_NETWORKED',
            argv: [...deps.harness_argv, 'run', '--format=json', `--model=${input.binding.binding.provider}/${input.binding.binding.model}`, `--agent=${input.agent}`, '--', input.objective],
            working_directory: '/capsule',
            environment,
            mounts: [
              { source: input.capsule_root, target: '/capsule', access: 'READ_WRITE' },
              { source: input.worktree_root, target: '/capsule/repo', access: 'READ_WRITE' },
            ],
            network: { mode: 'INTERNAL', name: lease.internal_network },
            timeout_ms: 300_000,
            max_output_bytes: 4 * 1024 * 1024,
          });
        } catch (error) {
          await (deps.enforce_diff ?? enforceDiffPolicy)(diffInput);
          throw error;
        }
        const diff = await (deps.enforce_diff ?? enforceDiffPolicy)(diffInput);
        if (result.timed_out || result.stdout_truncated || result.stderr_truncated || result.exit_code !== 0) invalid('harness execution failed or exceeded its bounds');
        const parsed = parseEvents(result.stdout);
        return Object.freeze({ session_id: parsed.sessionId, events: parsed.events, diff });
      } finally {
        await deps.credentials.revoke(lease.lease_id);
      }
    },
  });
}
