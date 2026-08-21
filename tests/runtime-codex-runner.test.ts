import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { ResolvedBindingV4 } from '../src/runtime/bindings.js';
import { probeRuntimeBinding } from '../src/runtime/capabilities.js';
import type { CredentialAdapterV4 } from '../src/runtime/credential-adapter.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { createCodexRunner } from '../src/runtime/codex-runner.js';
import type { ProcessSandboxBackendV4, SandboxRunRequestV4 } from '../src/runtime/process-sandbox.js';
import { validModelGuidance } from './runtime-contracts.test.js';

const execFileAsync = promisify(execFile);
const fakeCodex = new URL('./fixtures/bin/fake-codex.mjs', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
const identity = { profile_hash: 'a'.repeat(64), harness: 'codex', harness_version: '0.147.0', agent_policy_hash: 'b'.repeat(64), broker_version: '0.1.0', probe_version: 1 } as const;
const capability = await probeRuntimeBinding({ identity, probed_at: '2026-08-10T08:00:00.000Z', ttl_seconds: 3600, run_probe: async (iteration) => ({ structured_result: true, exact_bounded_edit: true, multi_step_file_tools: true, repair_from_validation_evidence: true, capsule_only: true, credential_separation: true, tool_network_denied: true, shell_used: false, transcript_hash: String(iteration + 1).repeat(64) }) });

function binding(): ResolvedBindingV4 {
  return { role: 'frontierExecutor', binding: { harness: 'codex', provider: 'profile-frontier-provider', model: 'profile-frontier-model', capability: 'frontier-coding', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC', 'PRIVATE'], permissions: 'contract-write', guidance: { ...validModelGuidance(), reasoningEffort: 'high' } }, binding_hash: 'f'.repeat(64) };
}

function localSandbox(requests: SandboxRunRequestV4[]): ProcessSandboxBackendV4 {
  return {
    id: 'fixture',
    probe: async () => ({ status: 'SUPPORTED', backend_id: 'fixture', policy_hash: 'd'.repeat(64), certification_hash: 'e'.repeat(64), expires_at: '2026-08-10T09:00:00.000Z' }),
    run: async (request) => {
      requests.push(request);
      const capsule = request.mounts.find((mount) => mount.target === '/capsule')!.source;
      const environment = Object.fromEntries(Object.entries(request.environment).map(([key, value]) => [key, value.replace(/^\/capsule(?=\/|$)/, capsule.replaceAll('\\', '/'))]));
      const started = Date.now();
      const { stdout, stderr } = await execFileAsync(request.argv[0]!, request.argv.slice(1), { cwd: capsule, env: environment, encoding: 'utf8' });
      return { execution_id: request.execution_id, exit_code: 0, signal: null, timed_out: false, stdout, stderr, stdout_truncated: false, stderr_truncated: false, duration_ms: Date.now() - started };
    },
    terminate: async () => {},
  };
}

test('runs exact ephemeral Codex argv from the capsule with a frozen bounded prompt', async () => {
  const capsule = await mkdtemp(join(tmpdir(), 'ao-codex-capsule-'));
  const worktree = await mkdtemp(join(tmpdir(), 'ao-codex-worktree-'));
  await mkdir(join(capsule, 'config'), { recursive: true });
  await mkdir(join(worktree, 'src'), { recursive: true });
  await mkdir(join(worktree, 'tests'), { recursive: true });
  await writeFile(join(worktree, 'src', 'greeting.ts'), "export const greeting = 'hello';\n");
  await writeFile(join(worktree, 'tests', 'greeting.test.ts'), "import { greeting } from '../src/greeting.js';\nvoid greeting;\n");
  const requests: SandboxRunRequestV4[] = [];
  let revoked = false;
  const credentials: CredentialAdapterV4 = {
    lease: async () => ({ lease_id: 'lease_codex', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-codex-0001', expires_at: '2026-08-10T08:10:00.000Z' }),
    revoke: async () => { revoked = true; },
  };
  const runner = createCodexRunner({ sandbox: localSandbox(requests), credentials, harness_argv: [process.execPath, fakeCodex], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => ({ changes: [{ path: 'src/greeting.ts', operation: 'MODIFY', content_hash: '1'.repeat(64) }], changed_files: 1, changed_lines: 2, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }) });
  const result = await runner.execute({ execution_id: 'exec_codex_0001', binding: binding(), capability, capsule_root: capsule, worktree_root: worktree, instruction_manifest_hash: '4'.repeat(64), contract: contract(), expected_sandbox_policy_hash: 'd'.repeat(64) });

  assert.equal(result.session_id, 'thread_fixture_0001');
  assert.match(result.capability_snapshot_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen((result.events[2] as { item?: object }).item), true);
  assert.deepEqual(result.structured_output.changed_paths, ['src/greeting.ts']);
  assert.equal(revoked, true);
  const request = requests[0]!;
  assert.equal(request.profile, 'FRONTIER_NETWORKED');
  assert.deepEqual(request.network, { mode: 'INTERNAL', name: 'ao-int-exec-codex-0001' });
  assert.deepEqual(request.environment, { PROVIDER_GATEWAY_TOKEN: 'broker-gateway', HOME: '/capsule/home', TMPDIR: '/capsule/tmp', NO_COLOR: '1' });
  assert.deepEqual(request.argv.slice(2, 14), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'workspace-write', '--output-schema', '/capsule/config/frontier-executor-result-v4.schema.json', '--json', '--cd', '/capsule', '--model']);
  assert.equal(request.argv[14], 'profile-frontier-model');
  assert.deepEqual(request.argv.slice(15, 27), [
    '-c', 'model_provider="broker_gateway"',
    '-c', 'model_providers.broker_gateway.name="Broker Gateway"',
    '-c', 'model_providers.broker_gateway.base_url="http://provider-gateway:8080/v1"',
    '-c', 'model_providers.broker_gateway.env_key="PROVIDER_GATEWAY_TOKEN"',
    '-c', 'model_providers.broker_gateway.wire_api="responses"',
    '-c', 'model_providers.broker_gateway.requires_openai_auth=false',
  ]);
  assert.deepEqual(request.argv.slice(27, 29), ['-c', 'model_reasoning_effort="high"']);
  const prompt = request.argv[29]!;
  assert.match(prompt, /repo\/ is the only editable source/);
  assert.match(prompt, /Do not commit, push, merge, deploy, or use network/);
  assert.match(prompt, /"contract_hash":"a{64}"/);
  assert.match(prompt, /"instruction_manifest_hash":"4{64}"/);
  assert.doesNotMatch(prompt, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const capture = JSON.parse(await readFile(join(capsule, 'config', 'fake-codex-capture.json'), 'utf8'));
  assert.equal(capture.cwd, await realpath(capsule));
});

test('rejects stale isolation before credential lease or harness launch', async () => {
  const credentials: CredentialAdapterV4 = { lease: async () => ({ lease_id: 'lease_codex', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-codex-0001', expires_at: '2026-08-10T08:10:00.000Z' }), revoke: async () => {} };
  let leased = 0;
  const unavailable: ProcessSandboxBackendV4 = { id: 'none', probe: async () => ({ status: 'UNSUPPORTED', failure: 'PROCESS_SANDBOX_UNAVAILABLE' }), run: async () => { throw new Error('launched'); }, terminate: async () => {} };
  const guarded = createCodexRunner({ sandbox: unavailable, credentials: { ...credentials, lease: async (value) => { leased += 1; return credentials.lease(value); } }, harness_argv: ['codex'], now: () => '2026-08-10T08:01:00.000Z', capability_identity_for: () => identity, enforce_diff: async () => ({ changes: [], changed_files: 0, changed_lines: 0, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) }) });
  await assert.rejects(() => guarded.execute({ execution_id: 'exec_codex_bad1', binding: binding(), capability, capsule_root: 'C:/capsule', worktree_root: 'C:/repo', instruction_manifest_hash: '4'.repeat(64), contract: contract(), expected_sandbox_policy_hash: 'd'.repeat(64) }), /PROCESS_SANDBOX_UNAVAILABLE/);
  assert.equal(leased, 0);
});

function contract(): RuntimeWorkContractV4 {
  const hash = 'a'.repeat(64);
  return { schema_version: 4, task_id: 'TASK-1', request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', repository_id: 'fixture', repository_root_hash: hash, base_sha: 'b'.repeat(40), objective: 'Change greeting', task_class: 'architecture', requested_risk_class: 'high', effective_risk_class: 'high', requested_route: 'FRONTIER' as const, effective_route: 'FRONTIER' as const, route_decision_reasons: ['frontier required'], route_decision_hash: hash, effective_data_scope: 'SOURCE_CODE_ONLY' as const, effective_source_sensitivity: 'PUBLIC' as const, allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY' as const] }], acceptance_tests: ['tests/greeting.test.ts'], implementation_targets: [{ path: 'src/greeting.ts', operations: ['MODIFY' as const] }], allowed_validation_ids: ['test'], inputs: [], constraints: [], success_criteria: ['test passes'], max_files_changed: 1, max_changed_lines: 20, max_attempts: 1, sandbox_profile_hashes: { frontier: hash }, prohibited_actions: ['push', 'deploy'], result_schema_version: 4 as const, policy_hash: hash, profile_hash: hash, contract_hash: hash };
}
