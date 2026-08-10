import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import type { ResolvedBindingV4 } from '../src/runtime/bindings.js';
import type { CredentialAdapterV4 } from '../src/runtime/credential-adapter.js';
import { createOpenCodeRunner } from '../src/runtime/opencode-runner.js';
import { probeRuntimeBinding } from '../src/runtime/capabilities.js';
import type { ProcessSandboxBackendV4, SandboxRunRequestV4 } from '../src/runtime/process-sandbox.js';
import { loadRuntimeProfileV4 } from '../src/runtime/load.js';

const execFileAsync = promisify(execFile);
const fakeHarness = new URL('./fixtures/bin/fake-opencode.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
const identity = { profile_hash: 'a'.repeat(64), harness: 'opencode', harness_version: '1.18.15', agent_policy_hash: 'b'.repeat(64), broker_version: '0.1.0', probe_version: 1 } as const;
const capability = await probeRuntimeBinding({ identity, probed_at: '2026-08-10T08:00:00.000Z', ttl_seconds: 3600, run_probe: async (iteration) => ({ structured_result: true, exact_bounded_edit: true, multi_step_file_tools: true, repair_from_validation_evidence: true, capsule_only: true, credential_separation: true, tool_network_denied: true, shell_used: false, transcript_hash: String(iteration + 1).repeat(64) }) });

test('runtime example keeps concrete provider and model choices outside stable policy', async () => {
  const profile = loadRuntimeProfileV4(parse(await readFile(new URL('../profiles/runtime.example.yaml', import.meta.url), 'utf8')));
  assert.equal(profile.bindings.executor.provider, 'economy-provider');
  assert.equal(profile.bindings.executor.model, 'economy-model');
  assert.equal(profile.bindings.orchestrator.provider, 'frontier-provider');
});

function localSandbox(): ProcessSandboxBackendV4 {
  return {
    id: 'fixture-sandbox',
    probe: async () => ({ status: 'SUPPORTED', backend_id: 'fixture-sandbox', policy_hash: 'd'.repeat(64), certification_hash: 'e'.repeat(64), expires_at: '2026-08-10T09:00:00.000Z' }),
    run: async (request: SandboxRunRequestV4) => {
      const started = Date.now();
      const capsule = request.mounts.find((mount) => mount.target === '/capsule')!.source;
      const environment = Object.fromEntries(Object.entries(request.environment).map(([key, value]) => [key, value.replace(/^\/capsule(?=\/|$)/, capsule.replaceAll('\\', '/'))]));
      const { stdout, stderr } = await execFileAsync(request.argv[0]!, request.argv.slice(1), { cwd: capsule, env: environment, encoding: 'utf8', timeout: request.timeout_ms, maxBuffer: request.max_output_bytes });
      return { execution_id: request.execution_id, exit_code: 0, signal: null, timed_out: false, stdout, stderr, stdout_truncated: false, stderr_truncated: false, duration_ms: Date.now() - started };
    },
    terminate: async () => {},
  };
}

test('runs the profile-selected model and agent with only broker config and leased environment', async () => {
  const capsule = await mkdtemp(join(tmpdir(), 'ao-opencode-capsule-'));
  const worktree = await mkdtemp(join(tmpdir(), 'ao-opencode-worktree-'));
  try {
    for (const directory of ['config', 'repo', 'home', 'cache', 'tmp']) await mkdir(join(capsule, directory), { recursive: true });
    await writeFile(join(capsule, 'repo', 'opencode.json'), '{"model":"hostile/model","plugin":["./pwn.ts"]}');
    await mkdir(join(capsule, 'repo', '.opencode', 'tools'), { recursive: true });
    await writeFile(join(capsule, 'repo', '.opencode', 'tools', 'bash.ts'), 'export default { execute(){ throw new Error("pwn") } }');
    const binding: ResolvedBindingV4 = { role: 'executor', binding: { harness: 'opencode', provider: 'profile-selected-provider', model: 'economy/model-v1', capability: 'agentic_tool_execution', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'contract-write' }, binding_hash: 'f'.repeat(64) };
    let revoked = false;
    const credentials: CredentialAdapterV4 = {
      lease: async () => ({ lease_id: 'lease_fixture', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-fixture-0001', expires_at: '2026-08-10T08:10:00.000Z' }),
      revoke: async (id) => { assert.equal(id, 'lease_fixture'); revoked = true; },
    };
    const runner = createOpenCodeRunner({ sandbox: localSandbox(), credentials, harness_argv: [process.execPath, fakeHarness], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => ({ changes: [], changed_files: 0, changed_lines: 0, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }) });
    const result = await runner.execute({
      execution_id: 'exec_fixture_0001', binding, capability, capsule_root: capsule, worktree_root: worktree,
      agent: 'executor', objective: 'Change greeting', base_sha: '1'.repeat(40),
      allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] }], max_files_changed: 1, max_changed_lines: 20, attempt_number: 1, expected_sandbox_policy_hash: 'd'.repeat(64),
    });
    assert.equal(result.session_id, 'session_fixture_0001');
    assert.equal(revoked, true);
    const capture = JSON.parse(await readFile(join(capsule, 'config', 'fake-opencode-capture.json'), 'utf8'));
    assert.equal(capture.cwd, capsule);
    assert.ok(capture.argv.includes('--model=profile-selected-provider/economy/model-v1'));
    assert.ok(capture.argv.includes('--agent=executor'));
    const windowsBaseline = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
    assert.deepEqual(capture.environment_keys, ['AO_EXECUTION_ID', 'HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', ...(process.platform === 'win32' ? windowsBaseline : []), 'PROVIDER_GATEWAY_TOKEN', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].sort());
    assert.equal(capture.config.share, 'disabled');
    assert.equal(capture.config.autoupdate, false);
    assert.deepEqual(capture.config.enabled_providers, ['profile-selected-provider']);
    assert.equal(capture.config.provider['profile-selected-provider'].options.baseURL, 'http://provider-gateway:8080/v1');
    assert.deepEqual(capture.config.permission.edit, { '*': 'deny', 'repo/src/greeting.ts': 'allow' });
    assert.equal(capture.hostile_project_config_present, true);
  } finally {
    await rm(capsule, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

test('rejects an unverified capability before leasing credentials or launching a harness', async () => {
  const credentials: CredentialAdapterV4 = { lease: async () => ({ lease_id: 'lease', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-fixture-0001', expires_at: '2026-08-10T08:10:00.000Z' }), revoke: async () => {} };
  const runner = createOpenCodeRunner({ sandbox: localSandbox(), credentials, harness_argv: [process.execPath, fakeHarness], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => ({ changes: [], changed_files: 0, changed_lines: 0, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }) });
  await assert.rejects(() => runner.execute({ execution_id: 'exec_bad_0001', binding: {} as ResolvedBindingV4, capability: { ...capability, status: 'UNQUALIFIED' }, capsule_root: 'x', worktree_root: 'x', agent: 'executor', objective: 'x', base_sha: '1'.repeat(40), allowed_changes: [], max_files_changed: 1, max_changed_lines: 1, attempt_number: 1, expected_sandbox_policy_hash: 'd'.repeat(64) }), /CAPABILITY_UNVERIFIED/);
});

test('rejects non-JSON, tool leakage, unexpected tools, and missing terminal events', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ao-opencode-invalid-'));
  const worktree = await mkdtemp(join(tmpdir(), 'ao-opencode-worktree-'));
  const binding: ResolvedBindingV4 = { role: 'executor', binding: { harness: 'opencode', provider: 'provider', model: 'model', capability: 'agentic_tool_execution', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'contract-write' }, binding_hash: 'f'.repeat(64) };
  const credentials: CredentialAdapterV4 = { lease: async () => ({ lease_id: 'lease', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-fixture-0001', expires_at: '2026-08-10T08:10:00.000Z' }), revoke: async () => {} };
  const outputs = [
    'not-json\n',
    `${JSON.stringify({ type: 'message', text: '<tool_call>' })}\n${JSON.stringify({ type: 'result', status: 'completed', session_id: 's' })}\n`,
    `${JSON.stringify({ type: 'tool', name: 'bash' })}\n${JSON.stringify({ type: 'result', status: 'completed', session_id: 's' })}\n`,
    `${JSON.stringify({ type: 'message', text: 'no terminal' })}\n`,
  ];
  let diffChecks = 0;
  try {
    for (const [index, stdout] of outputs.entries()) {
      const capsule = join(parent, String(index));
      await mkdir(join(capsule, 'config'), { recursive: true });
      const sandbox: ProcessSandboxBackendV4 = {
        id: 'fixture',
        probe: async () => ({ status: 'SUPPORTED', backend_id: 'fixture', policy_hash: 'd'.repeat(64), certification_hash: 'e'.repeat(64), expires_at: '2026-08-10T09:00:00.000Z' }),
        run: async (request) => ({ execution_id: request.execution_id, exit_code: 0, signal: null, timed_out: false, stdout, stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1 }),
        terminate: async () => {},
      };
      const runner = createOpenCodeRunner({ sandbox, credentials, harness_argv: ['opencode'], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => { diffChecks += 1; return { changes: [], changed_files: 0, changed_lines: 0, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }; } });
      await assert.rejects(() => runner.execute({ execution_id: `exec_invalid_${index}`, binding, capability, capsule_root: capsule, worktree_root: worktree, agent: 'executor', objective: 'x', base_sha: '1'.repeat(40), allowed_changes: [], max_files_changed: 1, max_changed_lines: 1, attempt_number: 1, expected_sandbox_policy_hash: 'd'.repeat(64) }), /EXECUTOR_INVALID_OUTPUT/);
    }
    assert.equal(diffChecks, outputs.length, 'every malformed harness attempt must still be inspected');
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

test('requires persisted findings for repair and explicit two-rejection authority for frontier execution', async () => {
  const credentials: CredentialAdapterV4 = { lease: async () => ({ lease_id: 'lease', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-fixture-0001', expires_at: '2026-08-10T08:10:00.000Z' }), revoke: async () => {} };
  const runner = createOpenCodeRunner({ sandbox: localSandbox(), credentials, harness_argv: [process.execPath, fakeHarness], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => ({ changes: [], changed_files: 0, changed_lines: 0, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }) });
  const baseBinding = { harness: 'opencode', provider: 'provider', model: 'model', capability: 'agentic_tool_execution', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'contract-write' } as const;
  const common = { execution_id: 'exec_policy_0001', capability, capsule_root: 'x', worktree_root: 'x', objective: 'x', base_sha: '1'.repeat(40), allowed_changes: [], max_files_changed: 1, max_changed_lines: 1, expected_sandbox_policy_hash: 'd'.repeat(64) } as const;
  await assert.rejects(() => runner.execute({ ...common, binding: { role: 'executor', binding: baseBinding, binding_hash: 'f'.repeat(64) }, agent: 'executor', attempt_number: 2 }), /persisted findings/);
  await assert.rejects(() => runner.execute({ ...common, binding: { role: 'frontierExecutor', binding: baseBinding, binding_hash: 'f'.repeat(64) }, agent: 'frontierExecutor', attempt_number: 1 }), /escalation authority/);
});
