import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  loadReviewAttestationV4,
  loadRuntimeProfileV4,
  loadRuntimeRepositoryPolicyV4,
  loadRuntimeResultV4,
  loadRuntimeTaskRequestV4,
  loadRuntimeWorkContractV4,
} from '../src/runtime/load.js';
import { loadFrontierExecutorResultV4 } from '../src/runtime/codex-runner.js';
import { createRuntimeEventV4, loadRuntimeEventV4 } from '../src/runtime/telemetry.js';

type Loader = (value: unknown) => unknown;

const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);
const validTaskRequest = () => ({ schema_version: 4, task_id: 'TASK-1', request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', repository_id: 'fixture-repo', objective: 'Change the greeting', task_class: 'mechanical-change', requested_risk_class: 'normal', requested_route: 'AUTO', allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] }], allowed_validation_ids: ['test'], inputs: [], constraints: [], success_criteria: ['fixture test passes'], max_files_changed: 1, max_changed_lines: 20, max_attempts: 3, prohibited_actions: ['push', 'deploy'], result_schema_version: 4 });
const validRuntimeProfile = () => {
  const guidance = { id: 'fixture-guidance', revision: 'fixture-1', sourceUrls: ['https://example.invalid/model-guidance'], promptFormat: 'markdown', contextPlacement: 'before-task', reasoningEffort: 'low', textVerbosity: 'low', temperature: null, maxSteps: 16, instructions: ['Keep the change minimal.'] };
  const binding = { harness: 'fixture-harness', provider: 'fixture-provider', model: 'fixture-model', capability: 'fixture-capability', allowedDataScopes: ['SOURCE_CODE_ONLY'], allowedSourceSensitivity: ['PUBLIC'], permissions: 'read-only', guidance };
  return { schemaVersion: 4, id: 'fixture-profile', bindings: { orchestrator: binding, executor: { ...binding, permissions: 'contract-write' }, escalationExecutor: { ...binding, permissions: 'contract-write' }, frontierExecutor: { ...binding, permissions: 'contract-write' }, reviewer: binding }, runtime: { maxEconomyParallelRequests: 2, maxConcurrentRunsPerRepository: 1 } };
};
const validRepositoryPolicy = () => ({ schemaVersion: 4, repositoryId: 'fixture-repo', base: { allowedBranches: ['main'] }, worktrees: { parentRef: 'broker-managed-worktrees' }, routing: { frontierOnly: { riskClasses: ['security'], taskClasses: [], paths: [], sourceSensitivity: ['PRIVATE'] } }, validation: { test: { argv: ['npm', 'test'], workingDirectory: '.', timeoutSeconds: 300, sandboxProfile: 'validation-default' } }, sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PUBLIC' }, sandbox: { requiredBackend: 'auto', requiredProfiles: ['executor-networked', 'frontier-networked', 'validation-untrusted', 'review-capsule'] }, instructions: { approvedSources: ['AGENTS.md'] }, publication: { enabled: true, remote: 'origin', baseBranch: 'main', mergeMethod: 'squash', requireRequiredChecks: true, timeoutSeconds: 900 } });
const validWorkContract = () => ({ ...validTaskRequest(), run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', repository_root_hash: hash, base_sha: sha, effective_risk_class: 'normal', effective_route: 'ECONOMY', route_decision_reasons: ['eligible for economy route'], route_decision_hash: hash, effective_data_scope: 'SOURCE_CODE_ONLY', effective_source_sensitivity: 'PUBLIC', sandbox_profile_hashes: { executor: hash }, policy_hash: hash, profile_hash: hash, contract_hash: hash });
const validRuntimeResult = () => ({ run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', state: 'REVIEW_ACCEPTED', effective_route: 'ECONOMY', route_decision_hash: hash, effective_data_scope: 'SOURCE_CODE_ONLY', effective_source_sensitivity: 'PUBLIC', branch: 'codex/auto/run-01', base_sha: sha, head_sha: sha, contract_hash: hash, policy_hash: hash, profile_hash: hash, attempts: [{ attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: hash }], validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: hash }], diff_hash: hash, tree_hash: hash, changed_files: ['src/greeting.ts'], review_attestation_hash: hash, commit_sha: sha, publication: { state: 'NOT_STARTED', remote: null, base_branch: null, pull_request: null, pull_request_url: null, merge_commit_sha: null }, failure: null, artifact_manifest_hash: hash });
const validReviewAttestation = () => ({ review_id: 'review-01', reviewer_binding_ref: 'fixture-reviewer', reviewer_session_id: 'session-01', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', contract_hash: hash, base_sha: sha, reviewed_tree_hash: hash, reviewed_diff_hash: hash, validation_manifest_hash: hash, decision: 'ACCEPT', findings: [], requested_context_hashes: [], unresolved_finding_ids: [], created_at: '2026-08-08T12:00:00.000Z', attestation_hash: hash });

async function validator(schemaName: string) {
  const schema = JSON.parse(await readFile(new URL(`../contracts/${schemaName}`, import.meta.url), 'utf8'));
  return new Ajv2020({ strict: true }).compile(schema);
}

async function assertParity(
  schemaName: string,
  document: object,
  loader: Loader,
  invalidMutations: readonly ((value: any) => any)[],
) {
  const validate = await validator(schemaName);
  assert.equal(validate(document), true);
  for (const mutate of invalidMutations) {
    const candidate = mutate(structuredClone(document));
    assert.equal(validate(candidate), false);
    assert.throws(() => loader(candidate));
  }
}

test('task request schema and loader reject unknown, caller-owned, route, duplicate, and empty-list mutations', async () => {
  await assertParity('runtime-task-request-v4.schema.json', validTaskRequest(), loadRuntimeTaskRequestV4, [
    (value) => ({ ...value, unexpected: true }),
    (value) => ({ ...value, run_id: 'caller-owned' }),
    (value) => ({ ...value, effective_route: 'ECONOMY' }),
    (value) => ({ ...value, requested_route: 'INVALID' }),
    (value) => ({ ...value, allowed_changes: [{ ...value.allowed_changes[0], operations: ['MODIFY', 'MODIFY'] }] }),
    (value) => ({ ...value, allowed_validation_ids: [] }),
    ...['/tmp/x', '../x', 'a/../b', '*.ts', 'src/\0file.ts', 'src:alternate-stream', 'src\\greeting.ts', 'CON.ts', 'LPT1.txt', 'src/file.', 'src/file ']
      .map((path) => (value: any) => ({ ...value, allowed_changes: [{ ...value.allowed_changes[0], path }] })),
  ]);
});

test('profile and repository policy schemas reject mixed contracts and malformed sensitivity', async () => {
  await assertParity('runtime-profile-v4.schema.json', validRuntimeProfile(), loadRuntimeProfileV4, [
    (value) => ({ ...value, sourcePolicy: validRepositoryPolicy().sourcePolicy }),
    (value) => ({ ...value, bindings: { ...value.bindings, executor: { ...value.bindings.executor, allowedSourceSensitivity: ['PRVIATE'] } } }),
    (value) => ({ ...value, bindings: { ...value.bindings, executor: { ...value.bindings.executor, guidance: { ...value.bindings.executor.guidance, sourceUrls: ['http://insecure.invalid'] } } } }),
    (value) => ({ ...value, bindings: { ...value.bindings, executor: { ...value.bindings.executor, harness: 'codex', authentication: 'chatgpt-subscription' } } }),
  ]);
  await assertParity('runtime-repository-policy-v4.schema.json', validRepositoryPolicy(), loadRuntimeRepositoryPolicyV4, [
    (value) => ({ ...value, bindings: validRuntimeProfile().bindings }),
    (value) => ({ ...value, sourcePolicy: { ...value.sourcePolicy, sourceSensitivity: 'PRVIATE' } }),
    (value) => ({ ...value, instructions: { approvedSources: ['../AGENTS.md'] } }),
    (value) => ({ ...value, instructions: { approvedSources: ['/etc/AGENTS.md'] } }),
    (value) => ({ ...value, routing: { frontierOnly: { ...value.routing.frontierOnly, paths: ['a/../b'] } } }),
    (value) => ({ ...value, publication: { ...value.publication, baseBranch: '../main' } }),
    (value) => ({ ...value, publication: { ...value.publication, mergeMethod: 'force' } }),
    (value) => ({ ...value, publication: { ...value.publication, timeoutSeconds: 29 } }),
  ]);
});

test('work contract and result schemas reject malformed hashes and unapproved failures', async () => {
  await assertParity('runtime-work-contract-v4.schema.json', validWorkContract(), loadRuntimeWorkContractV4, [
    (value) => ({ ...value, contract_hash: 'not-a-hash' }),
    (value) => ({ ...value, caller_owned: true }),
    (value) => ({ ...value, allowed_changes: [{ ...value.allowed_changes[0], path: '/tmp/x' }] }),
    (value) => ({ ...value, allowed_changes: [{ ...value.allowed_changes[0], path: 'a/../b' }] }),
  ]);
  await assertParity('runtime-result-v4.schema.json', validRuntimeResult(), loadRuntimeResultV4, [
    (value) => ({ ...value, artifact_manifest_hash: 'not-a-hash' }),
    (value) => ({ ...value, failure: { code: 'NOT_APPROVED', message: 'nope', retryable: false, evidence_hashes: [] } }),
    (value) => ({ ...value, publication: { ...value.publication, state: 'DONE' } }),
  ]);
});

test('review attestation schema and loader reject unresolved acceptance', async () => {
  await assertParity('review-attestation-v4.schema.json', validReviewAttestation(), loadReviewAttestationV4, [
    (value) => ({ ...value, decision: 'ACCEPT', unresolved_finding_ids: ['finding-1'] }),
    (value) => ({ ...value, reviewed_diff_hash: 'not-a-hash' }),
  ]);
});

test('frontier executor result schema and loader reject unknown fields and unsafe paths', async () => {
  await assertParity('frontier-executor-result-v4.schema.json', { schema_version: 4, status: 'COMPLETED', summary: 'done', changed_paths: ['src/greeting.ts'] }, loadFrontierExecutorResultV4, [
    (value) => ({ ...value, unexpected: true }),
    (value) => ({ ...value, status: 'FAILED' }),
    (value) => ({ ...value, changed_paths: ['../outside'] }),
    (value) => ({ ...value, changed_paths: ['src/A.ts', 'src/A.ts'] }),
  ]);
});

test('runtime telemetry public schema and loader reject unknown, raw, and malformed evidence', async () => {
  const body = { schema_version: 4 as const, type: 'RUN_PLANNED' as const, event_id: 'evt_0000000000000001', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', sequence: 1, previous_hash: null, recorded_at: '2026-08-10T12:00:00.000Z', contract_hash: hash, evidence_hashes: [hash] };
  const valid = createRuntimeEventV4(body);
  await assertParity('runtime-event-v4.schema.json', valid, loadRuntimeEventV4, [
    (value) => ({ ...value, prompt: 'raw' }),
    (value) => ({ ...value, event_hash: 'bad' }),
    (value) => ({ ...value, type: 'UNKNOWN' }),
  ]);
});
