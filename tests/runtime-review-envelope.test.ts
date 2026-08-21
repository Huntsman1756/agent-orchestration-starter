import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { buildReviewEnvelope } from '../src/runtime/review-envelope.js';

const hash = (value: string) => value.repeat(64);
const contract = fullContract();

test('builds a bounded evidence-only envelope and rejects hidden context fields', () => {
  const envelope = buildReviewEnvelope({
    contract,
    complete_diff: 'diff --git a/x b/x\n',
    changed_files: ['src/x.ts'],
    capability_snapshot_hash: hash('f'),
    diff_hash: hash('c'),
    tree_hash: hash('d'),
    validation_results: [{ validation_id: 'test', passed: true, result_hash: hash('e'), validated_tree_hash: hash('d') }],
    unresolved_findings: [{ id: 'finding-1', severity: 'high', message: 'fix it' }],
  });
  assert.deepEqual(Object.keys(envelope).sort(), [
    'base_sha',
    'capability_snapshot_hash',
    'changed_files',
    'complete_diff',
    'contract',
    'diff_hash',
    'envelope_hash',
    'schema_version',
    'tree_hash',
    'unresolved_findings',
    'validation_manifest',
    'validation_manifest_hash',
  ]);
  assert.notEqual(envelope.contract, contract);
  assert.equal(Object.isFrozen(envelope.contract), true);
  assert.throws(
    () =>
      buildReviewEnvelope({
        ...({
          contract,
          complete_diff: '',
          changed_files: [],
          diff_hash: hash('c'),
          tree_hash: hash('d'),
          validation_results: [],
          unresolved_findings: [],
          executor_transcript: 'hidden',
        } as any),
      }),
    /REVIEW_ATTESTATION_INVALID/,
  );
});

function fullContract(): any {
  const h = hash('a');
  const body = {
    schema_version: 4,
    task_id: 'TASK-1',
    request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    repository_id: 'fixture',
    repository_root_hash: h,
    base_sha: 'b'.repeat(40),
    objective: 'Review change',
    task_class: 'change',
    requested_risk_class: 'normal',
    effective_risk_class: 'normal',
    requested_route: 'AUTO',
    effective_route: 'ECONOMY',
    route_decision_reasons: ['eligible'],
    route_decision_hash: h,
    effective_data_scope: 'SOURCE_CODE_ONLY',
    effective_source_sensitivity: 'PUBLIC',
    allowed_changes: [{ path: 'src/x.ts', operations: ['MODIFY'] }],
    acceptance_tests: ['tests/x.test.ts'],
    implementation_targets: [{ path: 'src/x.ts', operations: ['MODIFY'] }],
    allowed_validation_ids: ['test'],
    inputs: [],
    constraints: [],
    success_criteria: ['passes'],
    max_files_changed: 1,
    max_changed_lines: 20,
    max_attempts: 3,
    sandbox_profile_hashes: { review: h },
    prohibited_actions: ['push'],
    result_schema_version: 4,
    policy_hash: h,
    profile_hash: h,
  };
  return { ...body, contract_hash: hashCanonicalV4(body) };
}
