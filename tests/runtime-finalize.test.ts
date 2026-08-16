import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { ReviewAttestationV4, RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import type { DiffPolicyResultV4 } from '../src/runtime/diff-policy.js';
import { finalizeRun, type CommitCreatedEventV4, type FinalizeRunInputV4 } from '../src/runtime/finalize.js';
import type { GitObjectWriterV4 } from '../src/runtime/git-object-writer.js';
import type { ValidationResultV4 } from '../src/runtime/validation.js';

const baseSha = 'b'.repeat(40);
const policyHash = 'a'.repeat(64);
const profileHash = 'f'.repeat(64);
const bytes = Buffer.from('accepted\n');
const contentHash = createHash('sha256').update(bytes).digest('hex');

function contract(): RuntimeWorkContractV4 {
  const body = {
    schema_version: 4 as const, task_id: 'TASK-1', request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', repository_id: 'fixture-repo', objective: 'Change the greeting', task_class: 'mechanical-change', requested_risk_class: 'normal', requested_route: 'AUTO' as const,
    allowed_changes: [{ path: 'src/x.ts', operations: ['MODIFY' as const] }], acceptance_tests: ['tests/x.test.ts'], implementation_targets: [{ path: 'src/x.ts', operations: ['MODIFY' as const] }], allowed_validation_ids: ['test'], inputs: [], constraints: [], success_criteria: ['tests pass'], max_files_changed: 1, max_changed_lines: 20, max_attempts: 3, prohibited_actions: ['push'], result_schema_version: 4 as const,
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', repository_root_hash: '1'.repeat(64), base_sha: baseSha, effective_risk_class: 'normal', effective_route: 'ECONOMY' as const, route_decision_reasons: ['eligible'], route_decision_hash: '2'.repeat(64), effective_data_scope: 'SOURCE_CODE_ONLY' as const, effective_source_sensitivity: 'PUBLIC' as const, sandbox_profile_hashes: { executor: '3'.repeat(64) }, policy_hash: policyHash, profile_hash: profileHash,
  };
  return { ...body, contract_hash: hashCanonicalV4(body) };
}

function diff(): DiffPolicyResultV4 {
  const changes = [{ path: 'src/x.ts', operation: 'MODIFY' as const, content_hash: contentHash }];
  return { changes, changed_files: 1, changed_lines: 1, diff_hash: hashCanonicalV4({ schema_version: 4, base_sha: baseSha, changes }), tree_hash: hashCanonicalV4({ schema_version: 4, parent_tree: baseSha, applied_changes: changes }) };
}

function validation(treeHash: string): ValidationResultV4 {
  const artifact = (kind: 'VALIDATION_STDOUT' | 'VALIDATION_STDERR') => ({ schema_version: 4 as const, kind, content_hash: '4'.repeat(64), byte_length: 0, storage_key: `${kind}/${'4'.repeat(64)}.bin` });
  const body = { validation_id: 'test', passed: true, failure_code: null, policy_hash: policyHash, sandbox_policy_hash: '5'.repeat(64), sandbox_backend_id: 'fixture', sandbox_certification_hash: '6'.repeat(64), exit_code: 0, duration_ms: 1, stdout_preview: '', stderr_preview: '', stdout_artifact: artifact('VALIDATION_STDOUT'), stderr_artifact: artifact('VALIDATION_STDERR'), validated_tree_hash: treeHash };
  return { ...body, result_hash: hashCanonicalV4(body) };
}

function review(work: RuntimeWorkContractV4, accepted: DiffPolicyResultV4, validationManifestHash: string): ReviewAttestationV4 {
  const body = { review_id: 'review-1', reviewer_binding_ref: 'reviewer', reviewer_session_id: 'fresh-review', run_id: work.run_id, contract_hash: work.contract_hash, base_sha: baseSha, reviewed_tree_hash: accepted.tree_hash, reviewed_diff_hash: accepted.diff_hash, validation_manifest_hash: validationManifestHash, decision: 'ACCEPT' as const, findings: [], requested_context_hashes: [], unresolved_finding_ids: [], created_at: '2026-08-10T12:00:00.000Z' };
  return { ...body, attestation_hash: hashCanonicalV4(body) };
}

function fixture(): { input: FinalizeRunInputV4; events: CommitCreatedEventV4[]; state: { ref: string; releases: string[]; updates: number } } {
  const work = contract();
  const accepted = diff();
  const result = validation(accepted.tree_hash);
  const manifestHash = hashCanonicalV4({ schema_version: 4, results: [{ validation_id: result.validation_id, passed: result.passed, result_hash: result.result_hash, validated_tree_hash: result.validated_tree_hash }] });
  const events: CommitCreatedEventV4[] = [];
  const state = { ref: baseSha, releases: [] as string[], updates: 0 };
  const writer: GitObjectWriterV4 = {
    writeAcceptedTree: async () => ({ tree_sha: '7'.repeat(40), blob_shas: { 'src/x.ts': '8'.repeat(40) } }),
    createCommit: async (value) => ({ commit_sha: '9'.repeat(40), tree_sha: value.tree_sha, parent_sha: value.base_sha }),
    updateTaskRef: async (value) => {
      if (state.ref !== value.expected_old_sha) throw new Error('FINALIZATION_FAILED: stale compare-and-update');
      state.ref = value.new_commit_sha; state.updates += 1;
    },
  };
  return { events, state, input: {
    contract: work, expected_policy_hash: policyHash, expected_profile_hash: profileHash, accepted_diff: accepted,
    validation_manifest: { results: [result], manifest_hash: manifestHash }, review_attestation: review(work, accepted, manifestHash), reviewer_session_id: 'fresh-review', prior_session_ids: ['executor'],
    task_ref: `refs/heads/codex/auto/${work.run_id}`, expected_old_sha: baseSha, commit_message: 'accepted', author: { name: 'Runner', email: 'runner@example.invalid', timestamp: '2026-08-10T12:00:00Z' }, writer,
    acquire_run_lock: async () => ({ release: async () => { state.releases.push('run'); } }), acquire_repository_lock: async () => ({ release: async () => { state.releases.push('repository'); } }),
    reinspect_diff: async () => structuredClone(accepted), snapshot_accepted_tree: async () => [{ path: 'src/x.ts', mode: '100644', bytes }], read_task_ref: async () => state.ref, append_commit_created: async (event) => { events.push(event); },
  } };
}

test('reproduces all accepted evidence, atomically updates only the task ref, journals, and releases locks', async () => {
  const { input, events, state } = fixture();
  const result = await finalizeRun(input);
  assert.equal(result.commit_sha, '9'.repeat(40));
  assert.equal(state.ref, result.commit_sha);
  assert.equal(state.updates, 1);
  assert.deepEqual(state.releases, ['repository', 'run']);
  assert.deepEqual(events, [{ type: 'COMMIT_CREATED', command_id: `commit-created:${input.contract.run_id}`, run_id: input.contract.run_id, task_ref: input.task_ref, base_sha: baseSha, git_tree_sha: '7'.repeat(40), evidence_tree_hash: input.accepted_diff.tree_hash, commit_sha: '9'.repeat(40), contract_hash: input.contract.contract_hash, diff_hash: input.accepted_diff.diff_hash, validation_manifest_hash: input.validation_manifest.manifest_hash, review_attestation_hash: input.review_attestation.attestation_hash }]);
});

test('rejects changed bytes and every stale contract, diff, validation, review, policy, or profile binding before ref mutation', async () => {
  type MutableFinalizeInput = { -readonly [Key in keyof FinalizeRunInputV4]: FinalizeRunInputV4[Key] };
  const mutations: Array<(input: MutableFinalizeInput) => void> = [
    (input) => { input.snapshot_accepted_tree = async () => [{ path: 'src/x.ts', mode: '100644', bytes: Buffer.from('changed') }]; },
    (input) => { input.contract = { ...input.contract, objective: 'forged' }; },
    (input) => { input.expected_policy_hash = '0'.repeat(64); },
    (input) => { input.expected_profile_hash = '0'.repeat(64); },
    (input) => { input.reinspect_diff = async () => ({ ...input.accepted_diff, changed_lines: 2 }); },
    (input) => { input.validation_manifest = { ...input.validation_manifest, manifest_hash: '0'.repeat(64) }; },
    (input) => { input.validation_manifest = { ...input.validation_manifest, results: [{ ...input.validation_manifest.results[0]!, passed: false }] }; },
    (input) => { input.review_attestation = { ...input.review_attestation, reviewed_tree_hash: '0'.repeat(64) }; },
  ];
  for (const mutate of mutations) {
    const { input, state } = fixture();
    mutate(input as MutableFinalizeInput);
    await assert.rejects(finalizeRun(input), /EVIDENCE_HASH_MISMATCH|REVIEW_ATTESTATION_INVALID/);
    assert.equal(state.updates, 0);
  }
});

test('fails stale concurrent finalization and recovers a journal failure without creating a second commit', async () => {
  const stale = fixture();
  stale.state.ref = 'c'.repeat(40);
  await assert.rejects(finalizeRun(stale.input), /task ref changed concurrently/);
  assert.equal(stale.state.updates, 0);

  const recovery = fixture();
  let appendAttempts = 0;
  (recovery.input as { -readonly [Key in keyof FinalizeRunInputV4]: FinalizeRunInputV4[Key] }).append_commit_created = async (event) => {
    appendAttempts += 1;
    if (appendAttempts === 1) throw new Error('disk interrupted');
    recovery.events.push(event);
  };
  await assert.rejects(finalizeRun(recovery.input), /disk interrupted/);
  assert.equal(recovery.state.updates, 1);
  const result = await finalizeRun(recovery.input);
  assert.equal(result.commit_sha, recovery.state.ref);
  assert.equal(recovery.state.updates, 1);
  assert.equal(recovery.events.length, 1);
});
