import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadReviewAttestationV4,
  loadRuntimeProfileV4,
  loadRuntimeRepositoryPolicyV4,
  loadRuntimeResultV4,
  loadRuntimeTaskRequestV4,
  loadRuntimeWorkContractV4,
} from '../src/runtime/load.js';

const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);

export function validTaskRequest() {
  return {
    schema_version: 4,
    task_id: 'TASK-1',
    request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    repository_id: 'fixture-repo',
    objective: 'Change the greeting',
    task_class: 'mechanical-change',
    requested_risk_class: 'normal',
    requested_route: 'AUTO',
    allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] }],
    allowed_validation_ids: ['test'],
    inputs: [],
    constraints: [],
    success_criteria: ['fixture test passes'],
    max_files_changed: 1,
    max_changed_lines: 20,
    max_attempts: 3,
    prohibited_actions: ['push', 'deploy'],
    result_schema_version: 4,
  };
}

export function validRuntimeProfile() {
  const binding = {
    harness: 'fixture-harness',
    provider: 'fixture-provider',
    model: 'fixture-model',
    capability: 'fixture-capability',
    allowedDataScopes: ['SOURCE_CODE_ONLY'],
    allowedSourceSensitivity: ['PUBLIC'],
    permissions: 'read-only',
  };
  return {
    schemaVersion: 4,
    id: 'fixture-profile',
    bindings: {
      orchestrator: binding,
      executor: { ...binding, permissions: 'contract-write' },
      escalationExecutor: { ...binding, permissions: 'contract-write' },
      frontierExecutor: { ...binding, permissions: 'contract-write' },
      reviewer: binding,
    },
    runtime: { maxEconomyParallelRequests: 2, maxConcurrentRunsPerRepository: 1 },
  };
}

export function validRepositoryPolicy() {
  return {
    schemaVersion: 4,
    repositoryId: 'fixture-repo',
    base: { allowedBranches: ['main'] },
    worktrees: { parentRef: 'broker-managed-worktrees' },
    routing: {
      frontierOnly: {
        riskClasses: ['security'],
        taskClasses: [],
        paths: [],
        sourceSensitivity: ['PRIVATE'],
      },
    },
    validation: {
      test: {
        argv: ['npm', 'test'],
        workingDirectory: '.',
        timeoutSeconds: 300,
        sandboxProfile: 'validation-default',
      },
    },
    sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PUBLIC' },
    sandbox: {
      requiredBackend: 'auto',
      requiredProfiles: ['executor-networked', 'frontier-networked', 'validation-untrusted', 'review-capsule'],
    },
    instructions: { approvedSources: ['AGENTS.md'] },
  };
}

export function validWorkContract() {
  return {
    ...validTaskRequest(),
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    repository_root_hash: hash,
    base_sha: sha,
    effective_risk_class: 'normal',
    effective_route: 'ECONOMY',
    route_decision_reasons: ['eligible for economy route'],
    route_decision_hash: hash,
    effective_data_scope: 'SOURCE_CODE_ONLY',
    effective_source_sensitivity: 'PUBLIC',
    sandbox_profile_hashes: { executor: hash },
    policy_hash: hash,
    profile_hash: hash,
    contract_hash: hash,
  };
}

export function validRuntimeResult() {
  return {
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    state: 'REVIEW_ACCEPTED',
    effective_route: 'ECONOMY',
    route_decision_hash: hash,
    effective_data_scope: 'SOURCE_CODE_ONLY',
    effective_source_sensitivity: 'PUBLIC',
    branch: 'codex/auto/run-01',
    base_sha: sha,
    head_sha: sha,
    contract_hash: hash,
    policy_hash: hash,
    profile_hash: hash,
    attempts: [{ attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: hash }],
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: hash }],
    diff_hash: hash,
    tree_hash: hash,
    changed_files: ['src/greeting.ts'],
    review_attestation_hash: hash,
    commit_sha: sha,
    failure: null,
    artifact_manifest_hash: hash,
  };
}

export function validReviewAttestation() {
  return {
    review_id: 'review-01',
    reviewer_binding_ref: 'fixture-reviewer',
    reviewer_session_id: 'session-01',
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    contract_hash: hash,
    base_sha: sha,
    reviewed_tree_hash: hash,
    reviewed_diff_hash: hash,
    validation_manifest_hash: hash,
    decision: 'ACCEPT',
    findings: [] as { id: string; severity: string; message: string }[],
    requested_context_hashes: [] as string[],
    unresolved_finding_ids: [] as string[],
    created_at: '2026-08-08T12:00:00.000Z',
    attestation_hash: hash,
  };
}

test('loads each complete V4 contract unchanged', () => {
  const request = validTaskRequest();
  assert.deepEqual(loadRuntimeTaskRequestV4(request), request);
  assert.deepEqual(loadRuntimeProfileV4(validRuntimeProfile()), validRuntimeProfile());
  assert.deepEqual(loadRuntimeRepositoryPolicyV4(validRepositoryPolicy()), validRepositoryPolicy());
  assert.deepEqual(loadRuntimeWorkContractV4(validWorkContract()), validWorkContract());
  assert.deepEqual(loadRuntimeResultV4(validRuntimeResult()), validRuntimeResult());
  assert.deepEqual(loadReviewAttestationV4(validReviewAttestation()), validReviewAttestation());
});

test('rejects the retired provider-specific runtime concurrency field', () => {
  const profile = validRuntimeProfile() as Record<string, unknown>;
  const retiredField = ['max', 'Ar', 'li', 'ParallelRequests'].join('');
  profile.runtime = { [retiredField]: 2, maxConcurrentRunsPerRepository: 1 };

  assert.throws(() => loadRuntimeProfileV4(profile), /unrecognized/i);
});

test('rejects caller-owned runtime fields on a task request', () => {
  assert.throws(
    () => loadRuntimeTaskRequestV4({ ...validTaskRequest(), run_id: 'caller-owned' }),
    /unrecognized|run_id/i,
  );
});

test('rejects duplicate allowed change operations', () => {
  const request = validTaskRequest();
  request.allowed_changes[0].operations.push('MODIFY');
  assert.throws(() => loadRuntimeTaskRequestV4(request), /duplicate/i);
});

test('rejects non-normalized repository-relative paths in changes and approved instructions', () => {
  const invalidPaths = [
    '/tmp/x',
    '../x',
    'a/../b',
    './x',
    'a//b',
    '*.ts',
    'src/\0file.ts',
    'src:alternate-stream',
    'src\\greeting.ts',
    'CON.ts',
    'LPT1.txt',
    'src/file.',
    'src/file ',
  ];

  for (const path of invalidPaths) {
    const request = validTaskRequest();
    request.allowed_changes[0].path = path;
    assert.throws(() => loadRuntimeTaskRequestV4(request), /path|invalid/i);

    const policy = validRepositoryPolicy();
    policy.instructions.approvedSources[0] = path;
    assert.throws(() => loadRuntimeRepositoryPolicyV4(policy), /path|invalid/i);
  }
});

test('rejects an acceptance attestation with unresolved findings', () => {
  const attestation = validReviewAttestation();
  attestation.unresolved_finding_ids.push('finding-1');
  assert.throws(() => loadReviewAttestationV4(attestation), /unresolved/i);
});
