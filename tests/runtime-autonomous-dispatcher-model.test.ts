import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createAutonomousDispatcherV4,
  type AutonomousDispatchPolicyV4,
  type AutonomousDispatcherStatusV4,
  type AutonomousDispatcherV4,
  type AutonomousRuntimePortV4,
  type AutonomousTaskCandidateV4,
  type AutonomousTaskSourceV4,
  type AutonomousPostMergeVerifierV4,
} from '../src/runtime/autonomous-dispatcher.js';
import type { RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const MERGE_SHA = 'c'.repeat(40);
const BASE_SHA = 'd'.repeat(40);
const CANDIDATE_COUNT = 2;

type Command = 'PAUSE' | 'RUN' | 'ADMIT' | 'CRASH' | 'RECOVER' | 'DRAIN' | 'ABORT';

const COMMANDS: readonly Command[] = ['PAUSE', 'RUN', 'ADMIT', 'CRASH', 'RECOVER', 'DRAIN', 'ABORT'];
const COVERAGE_PREFIX: readonly Command[] = [
  'PAUSE', 'RUN', 'CRASH', 'ADMIT', 'RECOVER', 'ADMIT',
  'DRAIN', 'ADMIT', 'RUN', 'ADMIT', 'ADMIT', 'ABORT', 'RECOVER',
];

type ModelTask = AutonomousDispatcherStatusV4['tasks'][number];

interface DispatcherModelHarness {
  readonly state_directory: string;
  readonly policy: AutonomousDispatchPolicyV4;
  readonly candidates: readonly AutonomousTaskCandidateV4[];
  readonly events: string[];
  readonly owners: Map<string, string>;
  readonly claim_counts: Map<string, number>;
  readonly start_runs: Map<string, string[]>;
  readonly logical_runs: Map<string, string>;
  readonly request_indices: Map<string, number>;
  readonly run_indices: Map<string, number>;
  readonly terminal_source_tasks: Set<string>;
  readonly verified_runs: Set<string>;
  source: AutonomousTaskSourceV4;
  runtime: AutonomousRuntimePortV4;
  post_merge: AutonomousPostMergeVerifierV4;
  lease_counter: number;
  crash_next_start: boolean;
  crash_observed: boolean;
  abort_next_resume: boolean;
  abort_observed: boolean;
}

interface DispatcherModelContext {
  readonly harness: DispatcherModelHarness;
  dispatcher: AutonomousDispatcherV4;
  readonly previous_tasks: Map<string, ModelTask>;
  readonly terminal_tasks: Map<string, ModelTask>;
}

function identity(candidateId: string, revision: string): string {
  return `${candidateId}\0${revision}`;
}

function requestFor(index: number): RuntimeTaskRequestV4 {
  const ordinal = index + 31;
  return {
    schema_version: 4,
    task_id: `ISSUE-${ordinal}`,
    request_id: `req_01HZX3YH8C7Y9QJ4J6M2G5K8N${index + 1}`,
    repository_id: 'fixture-repo',
    objective: `Repair deterministic fixture ${ordinal}`,
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

function candidateFor(index: number): AutonomousTaskCandidateV4 {
  const ordinal = index + 31;
  return {
    source: 'GITHUB_ISSUE',
    candidate_id: `github:fixture-repo:issue:${ordinal}`,
    revision: REVISION,
    repository_id: 'fixture-repo',
    authorization_labels: ['agent-ready'],
    request: requestFor(index),
  };
}

function runtimeResult(index: number, runId: string, state: string): RuntimeResultV4 {
  const request = requestFor(index);
  const finalized = state === 'FINALIZED';
  const aborted = state === 'ABORTED';
  return {
    run_id: runId,
    request_id: request.request_id,
    state,
    effective_route: 'ECONOMY',
    route_decision_hash: HASH,
    effective_data_scope: 'SOURCE_CODE_ONLY',
    effective_source_sensitivity: 'PUBLIC',
    branch: `codex/auto/${runId}`,
    base_sha: BASE_SHA,
    head_sha: finalized ? BASE_SHA : null,
    contract_hash: HASH,
    policy_hash: HASH,
    profile_hash: HASH,
    attempts: [],
    validation_results: [],
    diff_hash: HASH,
    tree_hash: HASH,
    changed_files: [],
    review_attestation_hash: finalized ? HASH : null,
    commit_sha: finalized ? BASE_SHA : null,
    publication: finalized
      ? { state: 'MERGED', remote: 'origin', base_branch: 'main', pull_request: 31 + index, pull_request_url: `https://github.com/example/fixture/pull/${31 + index}`, merge_commit_sha: MERGE_SHA }
      : { state: 'NOT_STARTED', remote: null, base_branch: null, pull_request: null, pull_request_url: null, merge_commit_sha: null },
    failure: aborted
      ? { code: 'ABORTED', message: 'ABORTED: model injected an authenticated abort', retryable: false, evidence_hashes: [HASH] }
      : null,
    artifact_manifest_hash: HASH,
  };
}

function isTerminal(status: ModelTask['status']): boolean {
  return status === 'COMPLETED' || status === 'REOPENED' || status === 'FAILED';
}

function nextCommands(seed: number, length = 30): readonly Command[] {
  let value = seed >>> 0;
  const commands = [...COVERAGE_PREFIX];
  while (commands.length < length) {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    commands.push(COMMANDS[value % COMMANDS.length]!);
  }
  return Object.freeze(commands);
}

function createHarness(stateDirectory: string): DispatcherModelHarness {
  const candidates = Object.freeze(Array.from({ length: CANDIDATE_COUNT }, (_, index) => candidateFor(index)));
  const policy: AutonomousDispatchPolicyV4 = {
    allowed_sources: ['GITHUB_ISSUE'],
    allowed_repository_ids: ['fixture-repo'],
    required_labels: ['agent-ready'],
    max_active_tasks: 1,
    max_claims_per_cycle: 1,
    lease_seconds: 300,
    max_consecutive_failures: 3,
    require_merged_publication: true,
  };
  const harness = {
    state_directory: stateDirectory,
    policy,
    candidates,
    events: [],
    owners: new Map<string, string>(),
    claim_counts: new Map<string, number>(),
    start_runs: new Map<string, string[]>(),
    logical_runs: new Map<string, string>(),
    request_indices: new Map(candidates.map((candidate, index) => [candidate.request.request_id, index])),
    run_indices: new Map<string, number>(),
    terminal_source_tasks: new Set<string>(),
    verified_runs: new Set<string>(),
    lease_counter: 0,
    crash_next_start: false,
    crash_observed: false,
    abort_next_resume: false,
    abort_observed: false,
  } as unknown as DispatcherModelHarness;

  for (const [index, candidate] of candidates.entries()) {
    harness.run_indices.set(`run_01HZX3YH8C7Y9QJ4J6M2G5K8N${index + 1}`, index);
  }

  harness.source = {
    listCandidates: async ({ cursor, limit }) => {
      const index = cursor === null ? 0 : Number.parseInt(cursor, 10);
      if (!Number.isSafeInteger(index) || index < 0 || index > candidates.length) throw new Error('MODEL_INVALID_CURSOR');
      const selected = candidates[index];
      harness.events.push(`list:${cursor ?? 'START'}`);
      return {
        candidates: selected === undefined ? [] : [selected].slice(0, limit),
        next_cursor: selected === undefined || index + 1 >= candidates.length ? null : String(index + 1),
      };
    },
    loadCandidate: async ({ candidate_id, revision }) => {
      harness.events.push(`load:${candidate_id}`);
      return candidates.find((candidate) => candidate.candidate_id === candidate_id && candidate.revision === revision) ?? null;
    },
    claim: async ({ candidate_id, revision, lease_id }) => {
      const taskIdentity = identity(candidate_id, revision);
      harness.events.push(`claim:${taskIdentity}:${lease_id}`);
      if (harness.owners.has(taskIdentity)) return 'BUSY';
      harness.owners.set(taskIdentity, lease_id);
      harness.claim_counts.set(taskIdentity, (harness.claim_counts.get(taskIdentity) ?? 0) + 1);
      return 'CLAIMED';
    },
    renew: async ({ candidate_id, revision, lease_id }) => {
      const taskIdentity = identity(candidate_id, revision);
      harness.events.push(`renew:${taskIdentity}:${lease_id}`);
      return harness.owners.get(taskIdentity) === lease_id ? 'RENEWED' : 'LOST';
    },
    complete: async ({ candidate_id, revision, run_id }) => {
      const taskIdentity = identity(candidate_id, revision);
      if (!harness.verified_runs.has(run_id)) throw new Error('MODEL_PUBLICATION_BEFORE_ACCEPTANCE');
      if (harness.terminal_source_tasks.has(taskIdentity)) throw new Error('MODEL_DUPLICATE_COMPLETION');
      harness.events.push(`complete:${taskIdentity}:${run_id}`);
      harness.terminal_source_tasks.add(taskIdentity);
      harness.owners.delete(taskIdentity);
    },
    reopen: async () => {
      throw new Error('MODEL_UNEXPECTED_REOPEN');
    },
    fail: async ({ candidate_id, revision, run_id }) => {
      const taskIdentity = identity(candidate_id, revision);
      if (harness.terminal_source_tasks.has(taskIdentity)) throw new Error('MODEL_DUPLICATE_FAILURE');
      harness.events.push(`fail:${taskIdentity}:${run_id ?? 'NONE'}`);
      harness.terminal_source_tasks.add(taskIdentity);
      harness.owners.delete(taskIdentity);
    },
  };

  harness.runtime = {
    start: async (request) => {
      const index = harness.request_indices.get(request.request_id);
      if (index === undefined) throw new Error('MODEL_UNKNOWN_REQUEST');
      const taskIdentity = identity(candidates[index]!.candidate_id, candidates[index]!.revision);
      if (harness.terminal_source_tasks.has(taskIdentity)) throw new Error('MODEL_TERMINAL_TASK_RESTARTED');
      const runId = harness.logical_runs.get(request.request_id) ?? `run_01HZX3YH8C7Y9QJ4J6M2G5K8N${index + 1}`;
      harness.logical_runs.set(request.request_id, runId);
      const starts = harness.start_runs.get(request.request_id) ?? [];
      starts.push(runId);
      harness.start_runs.set(request.request_id, starts);
      harness.events.push(`start:${request.request_id}:${runId}`);
      if (harness.crash_next_start) {
        harness.crash_next_start = false;
        harness.crash_observed = true;
        throw new Error('PROVIDER_UNAVAILABLE: model crash injected by dispatcher model');
      }
      return runtimeResult(index, runId, 'EXECUTION_STARTED');
    },
    resume: async (runId) => {
      const index = harness.run_indices.get(runId);
      if (index === undefined) throw new Error('MODEL_UNKNOWN_RUN');
      const taskIdentity = identity(candidates[index]!.candidate_id, candidates[index]!.revision);
      if (harness.terminal_source_tasks.has(taskIdentity)) throw new Error('MODEL_TERMINAL_TASK_RESUMED');
      harness.events.push(`resume:${runId}`);
      if (harness.abort_next_resume) {
        harness.abort_next_resume = false;
        harness.abort_observed = true;
        return runtimeResult(index, runId, 'ABORTED');
      }
      return runtimeResult(index, runId, 'FINALIZED');
    },
  };

  harness.post_merge = {
    verify: async ({ run_id }) => {
      if (harness.terminal_source_tasks.has(identity(candidates[harness.run_indices.get(run_id)!]!.candidate_id, REVISION))) {
        throw new Error('MODEL_TERMINAL_TASK_REVERIFIED');
      }
      harness.events.push(`verify:${run_id}`);
      harness.verified_runs.add(run_id);
      return { outcome: 'PASS', evidence_hash: HASH };
    },
  };

  return harness;
}

function createDispatcher(harness: DispatcherModelHarness): AutonomousDispatcherV4 {
  return createAutonomousDispatcherV4({
    state_directory: harness.state_directory,
    policy: harness.policy,
    source: harness.source,
    runtime: harness.runtime,
    post_merge: harness.post_merge,
    now: () => '2026-08-10T13:00:00.000Z',
    lease_id: () => {
      harness.lease_counter += 1;
      return `lease_01HZX3YH8C7Y9QJ4J6M2G5K8N${harness.lease_counter}`;
    },
  });
}

async function runCycle(context: DispatcherModelContext): Promise<void> {
  context.harness.crash_observed = false;
  try {
    await context.dispatcher.runCycle();
  } catch (error: unknown) {
    if (!context.harness.crash_observed) throw error;
    context.harness.crash_observed = false;
  }
}

async function assertInvariants(context: DispatcherModelContext): Promise<void> {
  const { harness } = context;
  const status = await context.dispatcher.status();
  assert.match(status.state_hash, /^[a-f0-9]{64}$/u);

  const currentTasks = new Map(status.tasks.map((task) => [identity(task.candidate_id, task.revision), task]));
  assert.equal(currentTasks.size, status.tasks.length, 'dispatcher task identities must be unique');
  for (const [taskIdentity, previous] of context.previous_tasks) {
    const current = currentTasks.get(taskIdentity);
    assert.ok(current, `task ${taskIdentity} disappeared from durable state`);
    if (isTerminal(previous.status)) assert.deepEqual(current, previous, `terminal task ${taskIdentity} changed after termination`);
    if (previous.run_id !== null) assert.equal(current!.run_id, previous.run_id, `run identity changed for ${taskIdentity}`);
    if (previous.status === 'RUNNING') assert.notEqual(current!.status, 'CLAIMED', `running task ${taskIdentity} went backwards`);
  }

  const activeTasks = status.tasks.filter((task) => task.status === 'CLAIMED' || task.status === 'RUNNING');
  assert.ok(activeTasks.length <= harness.policy.max_active_tasks, 'dispatcher exceeded active task capacity');
  assert.equal(new Set(harness.owners.values()).size, harness.owners.size, 'a lease has more than one owner');
  for (const task of activeTasks) {
    const taskIdentity = identity(task.candidate_id, task.revision);
    assert.ok(harness.owners.has(taskIdentity), `active task ${taskIdentity} has no source lease owner`);
  }
  for (const taskIdentity of harness.owners.keys()) {
    assert.ok(activeTasks.some((task) => identity(task.candidate_id, task.revision) === taskIdentity), `orphan lease owner ${taskIdentity}`);
  }
  for (const [taskIdentity, count] of harness.claim_counts) {
    assert.equal(count, 1, `task ${taskIdentity} was claimed more than once`);
  }
  for (const [requestId, runs] of harness.start_runs) {
    assert.equal(new Set(runs).size, 1, `request ${requestId} created more than one logical run`);
  }

  for (const task of status.tasks) {
    const taskIdentity = identity(task.candidate_id, task.revision);
    if (task.status === 'CLAIMED') assert.equal(task.run_id, null, `claimed task ${taskIdentity} has a run id`);
    else assert.notEqual(task.run_id, null, `non-claimed task ${taskIdentity} has no run id`);
    if (isTerminal(task.status)) {
      const firstTerminal = context.terminal_tasks.get(taskIdentity);
      if (firstTerminal) assert.deepEqual(task, firstTerminal, `terminal task ${taskIdentity} was mutated`);
      else context.terminal_tasks.set(taskIdentity, structuredClone(task));
    }
    context.previous_tasks.set(taskIdentity, structuredClone(task));
  }
}

async function executeCommand(context: DispatcherModelContext, command: Command): Promise<void> {
  const { harness } = context;
  switch (command) {
    case 'PAUSE':
      await context.dispatcher.setMode('PAUSED');
      break;
    case 'RUN':
      await context.dispatcher.setMode('RUNNING');
      break;
    case 'DRAIN':
      await context.dispatcher.setMode('DRAINING');
      break;
    case 'CRASH':
      harness.crash_next_start = true;
      break;
    case 'RECOVER': {
      const before = await context.dispatcher.status();
      context.dispatcher = createDispatcher(harness);
      assert.deepEqual(await context.dispatcher.status(), before, 'recovery changed durable authority');
      break;
    }
    case 'ADMIT': {
      const before = await context.dispatcher.status();
      const eventCount = harness.events.length;
      await runCycle(context);
      const cycleEvents = harness.events.slice(eventCount);
      if (before.mode === 'PAUSED') {
        assert.deepEqual(cycleEvents, [], 'PAUSED admitted or processed external work');
      } else if (before.mode === 'DRAINING') {
        assert.ok(!cycleEvents.some((event) => event.startsWith('list:') || event.startsWith('claim:')), 'DRAINING admitted new work');
      }
      break;
    }
    case 'ABORT': {
      const before = await context.dispatcher.status();
      const running = before.tasks.find((task) => task.status === 'RUNNING');
      if (running === undefined) break;
      harness.abort_next_resume = true;
      harness.abort_observed = false;
      const failuresBefore = harness.events.filter((event) => event.startsWith('fail:')).length;
      await runCycle(context);
      if (!harness.abort_observed) {
        harness.abort_next_resume = false;
        break;
      }
      const failuresAfterAbort = harness.events.filter((event) => event.startsWith('fail:')).length;
      assert.equal(failuresAfterAbort, failuresBefore + 1, 'ABORT did not become one durable failure');
      await runCycle(context);
      assert.equal(harness.events.filter((event) => event.startsWith('fail:')).length, failuresAfterAbort, 'ABORT was not idempotent');
      break;
    }
  }
}

test('bounded dispatcher state machine preserves safety invariants and emits reproducible counterexamples', async () => {
  const seeds = [0x00000001, 0x00000007, 0x12345678, 0x0badcafe, 0x13579bdf, 0x80000000, 0xdeadbeef, 0xffffffff];
  for (const seed of seeds) {
    const commands = nextCommands(seed);
    const harness = createHarness(await mkdtemp(join(tmpdir(), 'autonomous-dispatcher-model-')));
    const context: DispatcherModelContext = {
      harness,
      dispatcher: createDispatcher(harness),
      previous_tasks: new Map(),
      terminal_tasks: new Map(),
    };
    await assertInvariants(context);
    for (const [step, command] of commands.entries()) {
      try {
        await executeCommand(context, command);
        await assertInvariants(context);
      } catch (error: unknown) {
        throw new Error(`dispatcher model counterexample seed=${seed} step=${step} command=${command} commands=${JSON.stringify(commands)}`, { cause: error });
      }
    }
  }
});
