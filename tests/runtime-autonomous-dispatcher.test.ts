import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAutonomousDispatcherV4,
  runAutonomousDispatcherLoopV4,
  type AutonomousTaskCandidateV4,
} from '../src/runtime/autonomous-dispatcher.js';
import type { RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';

const hash = 'a'.repeat(64);
const requestId = 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';

function request(): RuntimeTaskRequestV4 {
  return {
    schema_version: 4,
    task_id: 'ISSUE-31',
    request_id: requestId,
    repository_id: 'fixture-repo',
    objective: 'Repair the greeting regression',
    task_class: 'bug-fix',
    requested_risk_class: 'normal',
    requested_route: 'AUTO',
    allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] }],
    allowed_validation_ids: ['test'],
    inputs: [],
    constraints: [],
    success_criteria: ['tests pass'],
    max_files_changed: 1,
    max_changed_lines: 20,
    max_attempts: 3,
    prohibited_actions: ['deploy'],
    result_schema_version: 4,
  };
}

function result(state = 'EXECUTION_STARTED'): RuntimeResultV4 {
  return {
    run_id: runId,
    request_id: requestId,
    state,
    effective_route: 'ECONOMY',
    route_decision_hash: hash,
    effective_data_scope: 'SOURCE_CODE_ONLY',
    effective_source_sensitivity: 'PUBLIC',
    branch: `codex/auto/${runId}`,
    base_sha: 'b'.repeat(40),
    head_sha: null,
    contract_hash: hash,
    policy_hash: hash,
    profile_hash: hash,
    attempts: [],
    validation_results: [],
    diff_hash: hash,
    tree_hash: hash,
    changed_files: [],
    review_attestation_hash: null,
    commit_sha: null,
    publication: { state: 'NOT_STARTED', remote: null, base_branch: null, pull_request: null, pull_request_url: null, merge_commit_sha: null },
    failure: null,
    artifact_manifest_hash: hash,
  };
}

function mergedResult(): RuntimeResultV4 {
  return {
    ...result('FINALIZED'),
    head_sha: 'd'.repeat(40),
    commit_sha: 'd'.repeat(40),
    publication: {
      state: 'MERGED', remote: 'origin', base_branch: 'main', pull_request: 31,
      pull_request_url: 'https://github.com/example/fixture/pull/31', merge_commit_sha: 'c'.repeat(40),
    },
  };
}

function failedResult(): RuntimeResultV4 {
  return {
    ...result('FAILED'),
    failure: { code: 'VALIDATION_FAILED', message: 'VALIDATION_FAILED: deterministic validation failed', retryable: false, evidence_hashes: [hash] },
  };
}

function candidate(): AutonomousTaskCandidateV4 {
  return {
    source: 'GITHUB_ISSUE',
    candidate_id: 'github:fixture-repo:issue:31',
    revision: hash,
    repository_id: 'fixture-repo',
    authorization_labels: ['agent-ready'],
    request: request(),
  };
}

test('one cycle claims and submits exactly one authorized task', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-'));
  const calls: string[] = [];
  const dispatcher = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy: {
      allowed_sources: ['GITHUB_ISSUE'],
      allowed_repository_ids: ['fixture-repo'],
      required_labels: ['agent-ready'],
      max_active_tasks: 1,
      max_claims_per_cycle: 1,
      lease_seconds: 300,
      max_consecutive_failures: 3,
      require_merged_publication: true,
    },
    source: {
      listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }),
      loadCandidate: async () => candidate(),
      claim: async (input) => { calls.push(`claim:${input.candidate_id}`); return 'CLAIMED'; },
      renew: async () => 'RENEWED',
      complete: async () => { throw new Error('not expected'); },
      reopen: async () => { throw new Error('not expected'); },
      fail: async () => { throw new Error('not expected'); },
    },
    runtime: {
      start: async (value) => { calls.push(`start:${value.request_id}`); return result(); },
      resume: async () => { throw new Error('not expected'); },
    },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:00:00.000Z',
    lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  });

  const report = await dispatcher.runCycle();
  const status = await dispatcher.status();

  assert.deepEqual(calls, [`claim:${candidate().candidate_id}`, `start:${requestId}`]);
  assert.deepEqual(report, {
    scanned: 1,
    claimed: 1,
    started: 1,
    resumed: 0,
    completed: 0,
    reopened: 0,
    failed: 0,
    skipped: 0,
    circuit_open: false,
    state_hash: report.state_hash,
  });
  assert.match(report.state_hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(status.tasks, [{
    candidate_id: candidate().candidate_id,
    revision: hash,
    repository_id: 'fixture-repo',
    request_id: requestId,
    run_id: runId,
    status: 'RUNNING',
    consecutive_failures: 0,
    lease_expires_at: '2026-08-10T13:05:00.000Z',
    last_evidence_hash: null,
  }]);
});

test('a new dispatcher process renews and resumes durable work without resubmitting it', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-recovery-'));
  const policy = {
    allowed_sources: ['GITHUB_ISSUE' as const],
    allowed_repository_ids: ['fixture-repo'],
    required_labels: ['agent-ready'],
    max_active_tasks: 1,
    max_claims_per_cycle: 1,
    lease_seconds: 300,
    max_consecutive_failures: 3,
    require_merged_publication: true,
  };
  const first = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy,
    source: {
      listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }),
      loadCandidate: async () => candidate(),
      claim: async () => 'CLAIMED', renew: async () => 'RENEWED',
      complete: async () => { throw new Error('not expected'); }, reopen: async () => { throw new Error('not expected'); }, fail: async () => { throw new Error('not expected'); },
    },
    runtime: { start: async () => result(), resume: async () => { throw new Error('not expected'); } },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:00:00.000Z',
    lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  });
  await first.runCycle();

  const calls: string[] = [];
  const recovered = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy,
    source: {
      listCandidates: async () => { throw new Error('must not scan while capacity is occupied'); },
      loadCandidate: async () => { throw new Error('must not reload running work'); },
      claim: async () => { throw new Error('must not reclaim durable work'); },
      renew: async (input) => { calls.push(`renew:${input.candidate_id}`); return 'RENEWED'; },
      complete: async () => { throw new Error('not expected'); }, reopen: async () => { throw new Error('not expected'); }, fail: async () => { throw new Error('not expected'); },
    },
    runtime: {
      start: async () => { throw new Error('must not resubmit durable work'); },
      resume: async (id) => { calls.push(`resume:${id}`); return result(); },
    },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:01:00.000Z',
    lease_id: () => 'lease_unused0000000000000000',
  });

  const report = await recovered.runCycle();
  const status = await recovered.status();

  assert.deepEqual(calls, [`renew:${candidate().candidate_id}`, `resume:${runId}`]);
  assert.equal(report.resumed, 1);
  assert.equal(report.started, 0);
  assert.equal(status.tasks[0]!.run_id, runId);
  assert.equal(status.tasks[0]!.lease_expires_at, '2026-08-10T13:06:00.000Z');
});

test('a crash after claim reloads the exact candidate and reuses its idempotent request', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-claimed-'));
  const policy = {
    allowed_sources: ['GITHUB_ISSUE' as const], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
    max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
  };
  const interrupted = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy,
    source: {
      listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }), loadCandidate: async () => candidate(),
      claim: async () => 'CLAIMED', renew: async () => 'RENEWED', complete: async () => {}, reopen: async () => {}, fail: async () => {},
    },
    runtime: { start: async () => { throw new Error('PROVIDER_UNAVAILABLE: simulated crash'); }, resume: async () => result() },
    post_merge: { verify: async () => ({ outcome: 'PASS', evidence_hash: hash }) },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  });
  await assert.rejects(interrupted.runCycle(), /simulated crash/u);
  assert.equal((await interrupted.status()).tasks[0]!.status, 'CLAIMED');

  const calls: string[] = [];
  const recovered = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy,
    source: {
      listCandidates: async () => { throw new Error('must not scan'); },
      loadCandidate: async (input) => { calls.push(`load:${input.candidate_id}`); return candidate(); },
      claim: async () => { throw new Error('must not reclaim'); },
      renew: async () => { calls.push('renew'); return 'RENEWED'; }, complete: async () => {}, reopen: async () => {}, fail: async () => {},
    },
    runtime: {
      start: async (value) => { calls.push(`start:${value.request_id}`); return result(); },
      resume: async () => { throw new Error('must not resume before run_id exists'); },
    },
    post_merge: { verify: async () => ({ outcome: 'PASS', evidence_hash: hash }) },
    now: () => '2026-08-10T13:01:00.000Z', lease_id: () => 'lease_unused0000000000000000',
  });

  const report = await recovered.runCycle();

  assert.deepEqual(calls, [`load:${candidate().candidate_id}`, 'renew', `start:${requestId}`]);
  assert.equal(report.started, 1);
  assert.equal((await recovered.status()).tasks[0]!.status, 'RUNNING');
});

test('a merged run closes its source task only after exact post-merge verification passes', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-merged-'));
  const policy = {
    allowed_sources: ['GITHUB_ISSUE' as const], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
    max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
  };
  const source = {
    listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }), loadCandidate: async () => candidate(),
    claim: async () => 'CLAIMED' as const, renew: async () => 'RENEWED' as const,
    complete: async () => {}, reopen: async () => {}, fail: async () => {},
  };
  await createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy, source,
    runtime: { start: async () => result(), resume: async () => result() },
    post_merge: { verify: async () => ({ outcome: 'PASS', evidence_hash: hash }) },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  }).runCycle();

  const calls: string[] = [];
  const finisher = createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy,
    source: {
      ...source,
      listCandidates: async () => ({ candidates: [], next_cursor: 'cursor-2' }),
      renew: async () => { calls.push('renew'); return 'RENEWED'; },
      complete: async (input) => { calls.push(`complete:${input.merge_commit_sha}:${input.evidence_hash}`); },
    },
    runtime: { start: async () => { throw new Error('not expected'); }, resume: async () => { calls.push(`resume:${runId}`); return mergedResult(); } },
    post_merge: {
      verify: async (input) => { calls.push(`verify:${input.merge_commit_sha}`); return { outcome: 'PASS', evidence_hash: hash }; },
    },
    now: () => '2026-08-10T13:02:00.000Z', lease_id: () => 'lease_unused0000000000000000',
  });

  const report = await finisher.runCycle();
  const status = await finisher.status();

  assert.deepEqual(calls, ['renew', `resume:${runId}`, `verify:${'c'.repeat(40)}`, `complete:${'c'.repeat(40)}:${hash}`]);
  assert.equal(report.completed, 1);
  assert.equal(status.tasks[0]!.status, 'COMPLETED');
  assert.equal(status.tasks[0]!.last_evidence_hash, hash);
});

test('a post-merge regression reopens the task and trips the configured circuit breaker', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-regression-'));
  const policy = {
    allowed_sources: ['GITHUB_ISSUE' as const], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
    max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 1, require_merged_publication: true,
  };
  const source = {
    listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }), loadCandidate: async () => candidate(),
    claim: async () => 'CLAIMED' as const, renew: async () => 'RENEWED' as const,
    complete: async () => {}, reopen: async () => {}, fail: async () => {},
  };
  await createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy, source,
    runtime: { start: async () => result(), resume: async () => result() }, post_merge: { verify: async () => ({ outcome: 'PASS', evidence_hash: hash }) },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  }).runCycle();

  const calls: string[] = [];
  const finisher = createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy,
    source: {
      ...source,
      listCandidates: async () => { throw new Error('circuit must prevent new scans'); },
      reopen: async (input) => { calls.push(`reopen:${input.finding_id}:${input.evidence_hash}`); },
    },
    runtime: { start: async () => { throw new Error('not expected'); }, resume: async () => mergedResult() },
    post_merge: { verify: async () => ({ outcome: 'FAIL', finding_id: 'main-smoke-regression', evidence_hash: hash }) },
    now: () => '2026-08-10T13:02:00.000Z', lease_id: () => 'lease_unused0000000000000000',
  });

  const report = await finisher.runCycle();
  const status = await finisher.status();

  assert.deepEqual(calls, [`reopen:main-smoke-regression:${hash}`]);
  assert.equal(report.reopened, 1);
  assert.equal(report.circuit_open, true);
  assert.equal(status.tasks[0]!.status, 'REOPENED');
  assert.equal(status.consecutive_failures, 1);
  assert.equal((await finisher.runCycle()).circuit_open, true);

  const reset = await finisher.resetCircuit();
  assert.equal(reset.circuit_open, false);
  assert.equal(reset.consecutive_failures, 0);
  assert.equal((await finisher.status()).circuit_open, false);
});

test('a terminal runtime failure is reported once and becomes durable failed work', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-failed-'));
  const policy = {
    allowed_sources: ['GITHUB_ISSUE' as const], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
    max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
  };
  const source = {
    listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-1' }), loadCandidate: async () => candidate(),
    claim: async () => 'CLAIMED' as const, renew: async () => 'RENEWED' as const,
    complete: async () => {}, reopen: async () => {}, fail: async () => {},
  };
  await createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy, source,
    runtime: { start: async () => result(), resume: async () => result() }, post_merge: { verify: async () => ({ outcome: 'PASS', evidence_hash: hash }) },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  }).runCycle();

  const calls: string[] = [];
  const finisher = createAutonomousDispatcherV4({
    state_directory: stateDirectory, policy,
    source: {
      ...source,
      listCandidates: async () => ({ candidates: [], next_cursor: 'cursor-2' }),
      fail: async (input) => { calls.push(`fail:${input.run_id}:${input.failure_code}:${input.evidence_hashes.join(',')}`); },
    },
    runtime: { start: async () => { throw new Error('not expected'); }, resume: async () => failedResult() },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:03:00.000Z', lease_id: () => 'lease_unused0000000000000000',
  });

  const report = await finisher.runCycle();
  const status = await finisher.status();

  assert.deepEqual(calls, [`fail:${runId}:VALIDATION_FAILED:${hash}`]);
  assert.equal(report.failed, 1);
  assert.equal(status.tasks[0]!.status, 'FAILED');
  assert.equal(status.tasks[0]!.last_evidence_hash, hash);
  assert.equal(status.consecutive_failures, 1);
});

test('a busy source candidate advances the durable cursor without starting work', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-cursor-'));
  const dispatcher = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy: {
      allowed_sources: ['GITHUB_ISSUE'], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
      max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
    },
    source: {
      listCandidates: async () => ({ candidates: [candidate()], next_cursor: 'cursor-after-busy' }), loadCandidate: async () => candidate(),
      claim: async () => 'BUSY', renew: async () => 'LOST', complete: async () => {}, reopen: async () => {}, fail: async () => {},
    },
    runtime: { start: async () => { throw new Error('must not start busy work'); }, resume: async () => { throw new Error('not expected'); } },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  });

  const report = await dispatcher.runCycle();

  assert.equal(report.skipped, 1);
  assert.equal((await dispatcher.status()).cursor, 'cursor-after-busy');
});

test('durable pause and drain modes control admissions without abandoning active work', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-mode-'));
  const calls: string[] = [];
  const dispatcher = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy: {
      allowed_sources: ['GITHUB_ISSUE'], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
      max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
    },
    source: {
      listCandidates: async () => { calls.push('list'); return { candidates: [candidate()], next_cursor: 'cursor-1' }; }, loadCandidate: async () => candidate(),
      claim: async () => { calls.push('claim'); return 'CLAIMED'; }, renew: async () => { calls.push('renew'); return 'RENEWED'; },
      complete: async () => {}, reopen: async () => {}, fail: async () => {},
    },
    runtime: {
      start: async () => { calls.push('start'); return result(); }, resume: async () => { calls.push('resume'); return result(); },
    },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
    now: () => '2026-08-10T13:00:00.000Z', lease_id: () => 'lease_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  });

  await dispatcher.setMode('PAUSED');
  await dispatcher.runCycle();
  assert.deepEqual(calls, []);
  assert.equal((await dispatcher.status()).mode, 'PAUSED');

  await dispatcher.setMode('RUNNING');
  await dispatcher.runCycle();
  assert.deepEqual(calls, ['list', 'claim', 'start']);

  calls.length = 0;
  await dispatcher.setMode('DRAINING');
  await dispatcher.runCycle();
  assert.deepEqual(calls, ['renew', 'resume']);
  assert.equal((await dispatcher.status()).mode, 'DRAINING');
});

test('the service loop runs serial cycles until its abort signal is observed', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-loop-'));
  const dispatcher = createAutonomousDispatcherV4({
    state_directory: stateDirectory,
    policy: {
      allowed_sources: ['GITHUB_ISSUE'], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
      max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
    },
    source: {
      listCandidates: async () => ({ candidates: [], next_cursor: null }), loadCandidate: async () => null,
      claim: async () => 'BUSY', renew: async () => 'LOST', complete: async () => {}, reopen: async () => {}, fail: async () => {},
    },
    runtime: { start: async () => { throw new Error('not expected'); }, resume: async () => { throw new Error('not expected'); } },
    post_merge: { verify: async () => { throw new Error('not expected'); } },
  });
  await dispatcher.setMode('PAUSED');
  const controller = new AbortController();
  let cycles = 0;
  let sleeps = 0;

  await runAutonomousDispatcherLoopV4({
    dispatcher,
    interval_ms: 100,
    signal: controller.signal,
    sleep: async () => { sleeps += 1; },
    on_cycle: async () => {
      cycles += 1;
      if (cycles === 2) controller.abort();
    },
  });

  assert.equal(cycles, 2);
  assert.equal(sleeps, 1);
});

test('dispatcher state must live in an explicit absolute broker-owned directory', () => {
  assert.throws(() => createAutonomousDispatcherV4({
    state_directory: 'relative-state',
    policy: {
      allowed_sources: ['GITHUB_ISSUE'], allowed_repository_ids: ['fixture-repo'], required_labels: ['agent-ready'],
      max_active_tasks: 1, max_claims_per_cycle: 1, lease_seconds: 300, max_consecutive_failures: 3, require_merged_publication: true,
    },
    source: {} as never,
    runtime: {} as never,
    post_merge: {} as never,
  }), /INVALID_CONTRACT: state_directory must be absolute/);
});
