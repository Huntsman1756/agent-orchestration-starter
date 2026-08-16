import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';
import { runBoundedProcessV4, type BoundedProcessResultV4 } from './bounded-process.js';
import type { RuntimeModelGuidanceV4 } from './contracts.js';
import { codexModelConfigArgvV4 } from './model-guidance.js';

export interface HostCodexSubscriptionProbeV4 {
  readonly status: 'SUPPORTED' | 'UNSUPPORTED';
  readonly policy_hash: string;
  readonly platform: NodeJS.Platform;
  readonly auth_store: 'keyring';
  readonly login_method: 'chatgpt';
  readonly reason?: 'UNSUPPORTED_PLATFORM' | 'CHATGPT_LOGIN_REQUIRED' | 'KEYRING_LOGIN_REQUIRED' | 'HARNESS_UNAVAILABLE';
}

export interface HostCodexSubscriptionExecutionV4 {
  readonly execution_id: string;
  readonly capsule_root: string;
  readonly model: string;
  readonly guidance: RuntimeModelGuidanceV4;
  readonly prompt: string;
  readonly expected_policy_hash: string;
}

export interface HostCodexSubscriptionResultV4 extends BoundedProcessResultV4 {
  readonly execution_id: string;
  readonly timed_out: boolean;
  readonly duration_ms: number;
}

export interface HostCodexSubscriptionRunnerV4 {
  probe(): Promise<HostCodexSubscriptionProbeV4>;
  execute(input: HostCodexSubscriptionExecutionV4): Promise<HostCodexSubscriptionResultV4>;
}

export interface HostCodexSubscriptionRunnerDependenciesV4 {
  readonly harness_argv: readonly string[];
  readonly runtime_home_parent: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
  readonly run_process?: (input: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
    readonly working_directory?: string;
    readonly deadline_ms: number;
    readonly max_output_bytes: number;
  }) => Promise<BoundedProcessResultV4>;
  readonly now_ms?: () => number;
}

const allowedPlatforms = new Set<NodeJS.Platform>(['win32', 'darwin', 'linux']);
const allowedEnvironment = new Set([
  'APPDATA', 'DBUS_SESSION_BUS_ADDRESS', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL',
  'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
  'XDG_RUNTIME_DIR',
]);
const forbiddenEnvironment = /(api|auth|credential|key|pass|secret|token)/iu;

function unavailable(message: string): never { throw new Error(`CAPABILITY_UNVERIFIED: ${message}`); }

function validateDependencies(deps: HostCodexSubscriptionRunnerDependenciesV4): void {
  if (deps.harness_argv.length < 1
    || deps.harness_argv.some((part) => part.length < 1 || part.length > 8_192 || part.includes('\0'))
    || !isAbsolute(deps.harness_argv[0]!)
    || !isAbsolute(deps.runtime_home_parent)
    || resolve(deps.runtime_home_parent) !== deps.runtime_home_parent) unavailable('host Codex runner configuration is invalid');
  for (const [key, value] of Object.entries(deps.environment)) {
    if (!allowedEnvironment.has(key) || forbiddenEnvironment.test(key) || value.includes('\0') || value.length > 16_384) {
      unavailable('host Codex runner environment is not allowlisted');
    }
  }
}

function policyHash(platform: NodeJS.Platform, harnessArgv: readonly string[]): string {
  return hashCanonicalV4({
    schema_version: 4,
    runner: 'host-codex-chatgpt-subscription',
    platform,
    harness_argv: harnessArgv,
    authentication: 'chatgpt',
    credential_store: 'keyring',
    codex_home: 'ephemeral-empty',
    sandbox: 'read-only',
    approval_policy: 'never',
    user_config: 'ignored',
    rules: 'ignored',
    session: 'ephemeral',
  });
}

function codexConfigArgv(): readonly string[] {
  return Object.freeze([
    '-c', 'cli_auth_credentials_store="keyring"',
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'approval_policy="never"',
  ]);
}

function environmentFor(deps: HostCodexSubscriptionRunnerDependenciesV4, codexHome: string): NodeJS.ProcessEnv {
  return Object.freeze({ ...deps.environment, CODEX_HOME: codexHome, NO_COLOR: '1' });
}

function loginStatus(output: string): 'chatgpt' | 'not-logged-in' | 'other' {
  if (/(?:^|\n)Logged in using ChatGPT(?:\r?$|\n)/u.test(output)) return 'chatgpt';
  if (/(?:^|\n)Not logged in(?:\r?$|\n)/u.test(output)) return 'not-logged-in';
  return 'other';
}

export function createHostCodexSubscriptionRunnerV4(deps: HostCodexSubscriptionRunnerDependenciesV4): HostCodexSubscriptionRunnerV4 {
  validateDependencies(deps);
  const platform = deps.platform ?? process.platform;
  const computedPolicyHash = policyHash(platform, deps.harness_argv);
  const run = deps.run_process ?? runBoundedProcessV4;
  const temporaryHome = async (): Promise<string> => {
    await mkdir(deps.runtime_home_parent, { recursive: true, mode: 0o700 });
    return await mkdtemp(join(deps.runtime_home_parent, 'codex-subscription-'));
  };
  const probe = async (): Promise<HostCodexSubscriptionProbeV4> => {
    if (!allowedPlatforms.has(platform)) return Object.freeze({ status: 'UNSUPPORTED', policy_hash: computedPolicyHash, platform, auth_store: 'keyring', login_method: 'chatgpt', reason: 'UNSUPPORTED_PLATFORM' });
    const home = await temporaryHome();
    try {
      let result: BoundedProcessResultV4;
      try {
        result = await run({ executable: deps.harness_argv[0]!, argv: [...deps.harness_argv.slice(1), ...codexConfigArgv(), 'login', 'status'], environment: environmentFor(deps, home), deadline_ms: 10_000, max_output_bytes: 64 * 1024 });
      } catch {
        return Object.freeze({ status: 'UNSUPPORTED', policy_hash: computedPolicyHash, platform, auth_store: 'keyring', login_method: 'chatgpt', reason: 'HARNESS_UNAVAILABLE' });
      }
      const status = loginStatus(`${result.stdout}\n${result.stderr}`);
      if (result.exit_code !== 0 || result.termination !== null || result.stdout_truncated || result.stderr_truncated || status !== 'chatgpt') {
        return Object.freeze({ status: 'UNSUPPORTED', policy_hash: computedPolicyHash, platform, auth_store: 'keyring', login_method: 'chatgpt', reason: status === 'not-logged-in' ? 'KEYRING_LOGIN_REQUIRED' : 'CHATGPT_LOGIN_REQUIRED' });
      }
      return Object.freeze({ status: 'SUPPORTED', policy_hash: computedPolicyHash, platform, auth_store: 'keyring', login_method: 'chatgpt' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  return Object.freeze({
    probe,
    execute: async (input: HostCodexSubscriptionExecutionV4): Promise<HostCodexSubscriptionResultV4> => {
      if (!/^exec_[a-z0-9_-]{8,96}$/u.test(input.execution_id)
        || !isAbsolute(input.capsule_root) || resolve(input.capsule_root) !== input.capsule_root
        || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.model)
        || input.prompt.length < 1 || input.prompt.length > 512 * 1024
        || !/^[a-f0-9]{64}$/u.test(input.expected_policy_hash)) unavailable('host Codex review request is invalid');
      const current = await probe();
      if (current.status !== 'SUPPORTED' || current.policy_hash !== input.expected_policy_hash) unavailable('host Codex subscription runner is not freshly qualified');
      const schema = join(input.capsule_root, 'review-attestation-v4.schema.json');
      const home = await temporaryHome();
      const started = (deps.now_ms ?? Date.now)();
      try {
        const result = await run({
          executable: deps.harness_argv[0]!,
          argv: [...deps.harness_argv.slice(1), 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schema, '--json', '--cd', input.capsule_root, '--model', input.model, ...codexConfigArgv(), ...codexModelConfigArgvV4(input.guidance), input.prompt],
          environment: environmentFor(deps, home),
          working_directory: input.capsule_root,
          deadline_ms: 300_000,
          max_output_bytes: 2 * 1024 * 1024,
        });
        return Object.freeze({ ...result, execution_id: input.execution_id, timed_out: result.termination === 'TIMEOUT', duration_ms: Math.max(0, (deps.now_ms ?? Date.now)() - started) });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  });
}
