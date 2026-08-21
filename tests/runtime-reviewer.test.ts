import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { probeRuntimeBinding } from '../src/runtime/capabilities.js';
import { createEconomyReviewSequence, createReviewer } from '../src/runtime/reviewer.js';
import { validModelGuidance } from './runtime-contracts.test.js';

const identity = { profile_hash: 'a'.repeat(64), harness: 'codex', harness_version: '0.147.0', agent_policy_hash: 'b'.repeat(64), broker_version: '0.1.0', probe_version: 1 } as const;
const capability = await probeRuntimeBinding({ identity, probed_at: '2026-08-10T09:00:00.000Z', ttl_seconds: 7200, run_probe: async (iteration) => ({ structured_result: true, exact_bounded_edit: true, multi_step_file_tools: true, repair_from_validation_evidence: true, capsule_only: true, credential_separation: true, tool_network_denied: true, shell_used: false, transcript_hash: String(iteration + 1).repeat(64) }) });

test('uses a fresh read-only capsule session and never mounts the worktree', async () => {
  const requests: any[] = [];
  const sandbox: any = { id: 'fixture', probe: async () => ({ status: 'SUPPORTED', backend_id: 'fixture', policy_hash: 'a'.repeat(64), certification_hash: 'b'.repeat(64), expires_at: '2026-08-10T11:00:00.000Z' }), run: async (request: any) => { requests.push(request); return { execution_id: request.execution_id, exit_code: 0, signal: null, timed_out: false, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'fresh-session' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(attestation()) } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`, stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1 }; }, terminate: async () => {} };
  const reviewer = createReviewer({ sandbox, credentials: { lease: async () => ({ lease_id: 'lease', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-review-0001', expires_at: '2026-08-10T10:30:00.000Z' }), revoke: async () => {} }, harness_argv: ['codex'], capability_identity_for: () => identity, now: () => '2026-08-10T10:00:00.000Z', build_capsule: async () => ({ root: 'C:/review-capsule', manifest_hash: 'f'.repeat(64) }), persist_attestation: async () => {} });
  const result = await reviewer.review({ execution_id: 'exec_review_0001', binding: { role: 'reviewer', binding: { harness: 'codex', provider: 'frontier', model: 'frontier-model', tier: 'frontier', capability: 'review', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'read-only', guidance: validModelGuidance() }, binding_hash: '9'.repeat(64) }, capability, envelope: envelope(), capsule_parent: 'C:/parent', forbidden_roots: ['C:/worktree'], expected_sandbox_policy_hash: 'a'.repeat(64), prior_session_ids: ['executor-session'] });
  assert.equal(result.decision, 'ACCEPT');
  assert.deepEqual(requests[0].mounts, [{ source: 'C:/review-capsule', target: '/capsule', access: 'READ_ONLY' }]);
  assert.deepEqual(requests[0].argv.slice(1, 13), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', '/capsule/review-attestation-v4.schema.json', '--json', '--cd', '/capsule']);
  assert.deepEqual(requests[0].argv.slice(15, 27), [
    '-c', 'model_provider="broker_gateway"',
    '-c', 'model_providers.broker_gateway.name="Broker Gateway"',
    '-c', 'model_providers.broker_gateway.base_url="http://provider-gateway:8080/v1"',
    '-c', 'model_providers.broker_gateway.env_key="PROVIDER_GATEWAY_TOKEN"',
    '-c', 'model_providers.broker_gateway.wire_api="responses"',
    '-c', 'model_providers.broker_gateway.requires_openai_auth=false',
  ]);
});

test('reviews through the host ChatGPT subscription runner without leasing gateway credentials', async () => {
  const requests: any[] = [];
  const reviewer = createReviewer({
    subscription_runner: {
      probe: async () => { throw new Error('execute owns the fresh qualification probe'); },
      execute: async (request) => {
        requests.push(request);
        return { execution_id: request.execution_id, exit_code: 0, signal: null, termination: null, timed_out: false, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'fresh-session' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(attestation()) } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`, stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1 };
      },
    },
    harness_argv: ['codex'],
    capability_identity_for: () => identity,
    now: () => '2026-08-10T10:00:00.000Z',
    build_capsule: async () => ({ root: 'C:/review-capsule', manifest_hash: 'f'.repeat(64) }),
    persist_attestation: async () => {},
  });
  const result = await reviewer.review({ execution_id: 'exec_review_subscription', binding: { role: 'reviewer', binding: { harness: 'codex', provider: 'openai', model: 'frontier-model', tier: 'frontier', authentication: 'chatgpt-subscription', capability: 'review', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'read-only', guidance: validModelGuidance() }, binding_hash: '9'.repeat(64) }, capability, envelope: envelope(), capsule_parent: 'C:/parent', forbidden_roots: ['C:/worktree'], expected_sandbox_policy_hash: 'a'.repeat(64), prior_session_ids: ['executor-session'] });
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].capsule_root, 'C:/review-capsule');
  assert.equal(requests[0].expected_policy_hash, 'a'.repeat(64));
});

test('encodes exactly economy, one repair, typed model escalation, and final review', async () => {
  const calls: string[] = [];
  const reviews = [rejection('r1'), rejection('r2'), acceptance('r3')];
  const machine = createEconomyReviewSequence({
    execute_economy: async (input) => { calls.push(`${input.role}-${input.attempt}-${input.repair_finding_hashes.length}`); return attemptResult(`${input.role}-${input.attempt}`); },
    execute_escalation: async (input) => { calls.push(`${input.role}-${input.failure_evidence_hashes.length}-${input.escalation_decision_hash.length}`); return attemptResult(input.role); },
    validate: async (_attempt, ordinal) => { calls.push(`validate-${ordinal}`); return true; },
    review: async (_attempt, ordinal) => { calls.push(`review-${ordinal}`); return reviews[ordinal - 1]!; },
  });
  assert.equal((await machine.run()).session_id, 'escalationExecutor');
  assert.deepEqual(calls, ['executor-1-0', 'validate-1', 'review-1', 'executor-2-1', 'validate-2', 'review-2', 'escalationExecutor-2-64', 'validate-3', 'review-3']);
});

test('repairs deterministic validation evidence before spending reviewer work', async () => {
  const calls: string[] = [];
  const finding = '7'.repeat(64);
  const machine = createEconomyReviewSequence({
    execute_economy: async (input) => { calls.push(`execute-${input.attempt}-${input.repair_finding_hashes.length}`); return attemptResult(`attempt-${input.attempt}`); },
    execute_escalation: async () => { throw new Error('unexpected escalation'); },
    validate: async (_attempt, ordinal) => { calls.push(`validate-${ordinal}`); return ordinal === 1 ? { passed: false, finding_hashes: [finding] } : { passed: true, finding_hashes: [] }; },
    review: async (_attempt, ordinal) => { calls.push(`review-${ordinal}`); return acceptance('validation-repair'); },
  });
  assert.equal((await machine.run()).session_id, 'attempt-2');
  assert.deepEqual(calls, ['execute-1-0', 'validate-1', 'execute-2-1', 'validate-2', 'review-3']);
});

test('permits one content-addressed context expansion in a second fresh session', async () => {
  const content = 'export const requested = true;\n';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const requestHash = hashCanonicalV4({ path: 'src/requested.ts', content_hash: contentHash });
  const capsuleContextSizes: number[] = [];
  let round = 0;
  const sandbox: any = { id: 'fixture', probe: async () => ({ status: 'SUPPORTED', backend_id: 'fixture', policy_hash: 'a'.repeat(64), certification_hash: 'b'.repeat(64), expires_at: '2026-08-10T11:00:00.000Z' }), run: async (request: any) => {
    const session = `fresh-context-${++round}`;
    const decision = round === 1 ? 'REQUEST_CONTEXT' : 'ACCEPT';
    const result = reviewResult(session, decision, decision === 'REQUEST_CONTEXT' ? [requestHash] : []);
    return { execution_id: request.execution_id, exit_code: 0, signal: null, timed_out: false, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: session })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`, stderr: '', stdout_truncated: false, stderr_truncated: false, duration_ms: 1 };
  }, terminate: async () => {} };
  const reviewer = createReviewer({ sandbox, credentials: { lease: async () => ({ lease_id: 'lease', environment: { PROVIDER_GATEWAY_TOKEN: 'broker-gateway' }, provider_endpoint: 'http://provider-gateway:8080/v1', internal_network: 'ao-int-exec-review-0001', expires_at: '2026-08-10T10:30:00.000Z' }), revoke: async () => {} }, harness_argv: ['codex'], capability_identity_for: () => identity, now: () => '2026-08-10T10:00:00.000Z', build_capsule: async (input) => { capsuleContextSizes.push(input.approved_context.length); return { root: `C:/review-${capsuleContextSizes.length}`, manifest_hash: 'f'.repeat(64) }; }, resolve_context: async () => ({ path: 'src/requested.ts', content, content_hash: contentHash }), persist_attestation: async () => {} });
  const result = await reviewer.review({ execution_id: 'exec_review_context', binding: { role: 'reviewer', binding: { harness: 'codex', provider: 'frontier', model: 'frontier-model', tier: 'frontier', capability: 'review', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'read-only', guidance: validModelGuidance() }, binding_hash: '9'.repeat(64) }, capability, envelope: envelope(), capsule_parent: 'C:/parent', forbidden_roots: ['C:/worktree'], expected_sandbox_policy_hash: 'a'.repeat(64), prior_session_ids: ['executor-session'] });
  assert.equal(result.reviewer_session_id, 'fresh-context-2');
  assert.deepEqual(capsuleContextSizes, [0, 1]);
});

function attemptResult(session_id: string) { return { session_id, events: [], diff: { changes: [], changed_files: 0, changed_lines: 0, diff_hash: 'd'.repeat(64), tree_hash: 'c'.repeat(64) }, capability_snapshot_hash: '8'.repeat(64) }; }
function rejection(seed: string) { const value = acceptance(seed); return { ...value, decision: 'REJECT' as const, findings: [{ id: `finding-${seed}`, severity: 'high', message: 'fix' }], unresolved_finding_ids: [`finding-${seed}`] }; }
function acceptance(seed: string) { return { ...attestation(), review_id: seed, attestation_hash: hashCanonicalV4({ seed }) } as any; }
function reviewResult(session: string, decision: 'REQUEST_CONTEXT' | 'ACCEPT', requested: string[]) { const body = { ...attestation(), reviewer_session_id: session, decision, requested_context_hashes: requested, attestation_hash: undefined }; delete (body as any).attestation_hash; return { ...body, attestation_hash: hashCanonicalV4(body) }; }

function envelope() { const body = { schema_version: 4, contract: { run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', contract_hash: 'a'.repeat(64) }, base_sha: 'b'.repeat(40), complete_diff: 'diff', changed_files: ['x'], validation_manifest: [], validation_manifest_hash: 'e'.repeat(64), tree_hash: 'c'.repeat(64), diff_hash: 'd'.repeat(64), unresolved_findings: [] }; return { ...body, envelope_hash: hashCanonicalV4(body) } as any; }
function attestation() { const body = { review_id: 'review-01', reviewer_binding_ref: '9'.repeat(64), reviewer_session_id: 'fresh-session', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', contract_hash: 'a'.repeat(64), base_sha: 'b'.repeat(40), reviewed_tree_hash: 'c'.repeat(64), reviewed_diff_hash: 'd'.repeat(64), validation_manifest_hash: 'e'.repeat(64), decision: 'ACCEPT', findings: [], requested_context_hashes: [], unresolved_finding_ids: [], created_at: '2026-08-10T10:00:00.000Z' }; return { ...body, attestation_hash: hashCanonicalV4(body) }; }
