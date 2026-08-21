import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import {
  createFrontierDecisionEventV4,
  inspectIterativeTrajectoryV4,
  loadIterativeStoryPlanV4,
  runIterativeExecutorV4,
  type IterativeStoryPlanV4,
  type StoryIterationEventV4,
} from '../src/runtime/iterative-executor.js';
import { runFrontierSupervisorV4 } from '../src/runtime/frontier-supervisor.js';
import { createWorkerCapabilityV4 } from '../src/runtime/worker-capability.js';
import { validWorkContract } from './runtime-contracts.test.js';

const evidence = (character: string) => character.repeat(64);
const frontierDecision = (rejectedEventHash: string, action: 'RETRY' | 'ESCALATE', decisionId = 'decision_0000000000000001') => ({
  decision_id: decisionId,
  decision_owner_ref: 'frontier-reviewer',
  authority_evidence_hash: evidence('a'),
  rejected_event_hash: rejectedEventHash,
  action,
});

function worker(maxStoryFiles = 3) {
  return createWorkerCapabilityV4({
    schema_version: 4,
    binding_ref: 'fixture-executor',
    deployment: {
      provider_ref: 'fixture-provider',
      model_ref: 'fixture-model',
      model_revision: 'fixture-model-r1',
      model_artifact_hash: evidence('a'),
      endpoint_revision: 'fixture-endpoint-r1',
      harness_ref: 'fixture-harness',
      harness_revision: 'fixture-harness-r1',
      tool_protocol: 'native-json-tools',
      tool_parser_revision: 'fixture-parser-r1',
      tool_bundle_hash: evidence('b'),
      instruction_bundle_hash: evidence('d'),
      qualification_evidence_hash: evidence('c'),
    },
    capabilities: ['patch_application', 'repository_search', 'structured_repair_feedback'],
    limits: {
      max_story_files: maxStoryFiles,
      max_story_changed_lines: 180,
      max_story_context_bytes: 65_536,
      max_acceptance_criteria: 5,
      max_dependency_depth: 4,
      max_steps_per_attempt: 32,
      max_attempts: 3,
      no_progress_repeat_limit: 2,
    },
  });
}

function contract(): RuntimeWorkContractV4 {
  const source = validWorkContract();
  const body = {
    ...source,
    allowed_changes: [
      { path: 'src/a.ts', operations: ['MODIFY'] },
      { path: 'src/b.ts', operations: ['CREATE'] },
    ],
    implementation_targets: [
      { path: 'src/a.ts', operations: ['MODIFY'] },
      { path: 'src/b.ts', operations: ['CREATE'] },
    ],
    allowed_validation_ids: ['typecheck', 'test'],
    max_files_changed: 2,
  } as Record<string, unknown>;
  delete body.contract_hash;
  return { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
}

function story(input: {
  id: string;
  path: string;
  operation: 'CREATE' | 'MODIFY';
  priority: number;
  dependencies?: string[];
  attempts?: number;
}) {
  const body = {
    story_id: input.id,
    title: `Implement ${input.id}`,
    objective: `Complete ${input.id}`,
    priority: input.priority,
    depends_on: input.dependencies ?? [],
    allowed_changes: [{ path: input.path, operations: [input.operation] }],
    validation_ids: ['typecheck', 'test'],
    acceptance_criteria: [`${input.id} is validated`],
    required_capabilities: ['patch_application'],
    context_budget_bytes: 4_096,
    max_changed_lines: 20,
    max_steps: 16,
    max_attempts: input.attempts ?? 2,
  };
  return { ...body, story_hash: hashCanonicalV4(body) };
}

function plan(work = contract(), workerCapability = worker(), storyAttempts = 2): IterativeStoryPlanV4 {
  const stories = [
    story({ id: 'story_alpha', path: 'src/a.ts', operation: 'MODIFY', priority: 1, attempts: storyAttempts }),
    story({ id: 'story_beta', path: 'src/b.ts', operation: 'CREATE', priority: 2, dependencies: ['story_alpha'] }),
  ];
  const body = {
    schema_version: 4 as const,
    run_id: work.run_id,
    contract_hash: work.contract_hash,
    base_sha: work.base_sha,
    worker_capability_hash: workerCapability.worker_capability_hash,
    max_iterations: 6,
    stories,
  };
  return { ...body, plan_hash: hashCanonicalV4(body) };
}

test('rejects a planner story that exceeds the active worker file budget', () => {
  const work = contract();
  const workerCapability = worker(1);
  const original = story({ id: 'story_wide', path: 'src/a.ts', operation: 'MODIFY', priority: 1 });
  const storyBody = {
    ...original,
    allowed_changes: [
      { path: 'src/a.ts', operations: ['MODIFY'] },
      { path: 'src/b.ts', operations: ['CREATE'] },
    ],
  } as any;
  delete storyBody.story_hash;
  const wideStory = { ...storyBody, story_hash: hashCanonicalV4(storyBody) };
  const planBody = {
    schema_version: 4,
    run_id: work.run_id,
    contract_hash: work.contract_hash,
    base_sha: work.base_sha,
    worker_capability_hash: workerCapability.worker_capability_hash,
    max_iterations: 2,
    stories: [wideStory],
  };
  const widePlan = { ...planBody, plan_hash: hashCanonicalV4(planBody) };

  assert.throws(() => (loadIterativeStoryPlanV4 as any)(widePlan, work, workerCapability), /story files exceed worker capability/u);
});

test('rejects worker drift, unsupported capabilities, and oversized step budgets before execution', () => {
  const work = contract();
  const plannedWorker = worker();
  const storyPlan = plan(work, plannedWorker);
  assert.throws(() => loadIterativeStoryPlanV4(storyPlan, work, worker(2)), /worker capability does not match/u);

  const originalStory = storyPlan.stories[0]!;
  const oversizedBody = { ...originalStory, max_steps: 33 } as any;
  delete oversizedBody.story_hash;
  const oversizedStory = { ...oversizedBody, story_hash: hashCanonicalV4(oversizedBody) };
  const oversizedPlanBody = { ...storyPlan, stories: [oversizedStory] } as any;
  delete oversizedPlanBody.plan_hash;
  assert.throws(
    () => loadIterativeStoryPlanV4({ ...oversizedPlanBody, plan_hash: hashCanonicalV4(oversizedPlanBody) }, work, plannedWorker),
    /step budget exceeds worker capability/u,
  );

  const unsupportedBody = { ...originalStory, required_capabilities: ['unqualified_skill'] } as any;
  delete unsupportedBody.story_hash;
  const unsupportedStory = { ...unsupportedBody, story_hash: hashCanonicalV4(unsupportedBody) };
  const unsupportedPlanBody = { ...storyPlan, stories: [unsupportedStory] } as any;
  delete unsupportedPlanBody.plan_hash;
  assert.throws(
    () => loadIterativeStoryPlanV4({ ...unsupportedPlanBody, plan_hash: hashCanonicalV4(unsupportedPlanBody) }, work, plannedWorker),
    /unsupported worker capability/u,
  );
});

function fixture(
  options: {
    rejectFirst?: boolean;
    alwaysReject?: boolean;
    repeatFailureSignature?: boolean;
    prior?: StoryIterationEventV4[];
    priorDecisions?: any[];
    storyAttempts?: number;
  } = {},
) {
  const work = contract();
  const workerCapability = worker();
  const storyPlan = plan(work, workerCapability, options.storyAttempts ?? 2);
  const calls: Array<{
    story: string;
    attempt: number;
    input: string;
    receipts: readonly string[];
    session: string;
    repair: string | null;
  }> = [];
  const events: StoryIterationEventV4[] = [...(options.prior ?? [])];
  const frontierDecisions: any[] = [...(options.priorDecisions ?? [])];
  const promotions: string[] = [];
  let executions = 0;
  return {
    work,
    storyPlan,
    calls,
    events,
    promotions,
    input: {
      contract: work,
      worker: workerCapability,
      plan: storyPlan,
      initial_tree_hash: evidence('1'),
      prior_events: options.prior ?? [],
      prior_frontier_decisions: options.priorDecisions ?? [],
      create_session_id: ({ iteration }: { iteration: number }) => `session_${String(iteration).padStart(16, '0')}`,
      execute: async (value: any) => {
        executions += 1;
        calls.push({
          story: value.story.story_id,
          attempt: value.attempt,
          input: value.input_tree_hash,
          receipts: value.accepted_receipts.map((receipt: any) => receipt.story_id),
          session: value.session_id,
          repair: value.repair_packet?.packet_hash ?? null,
        });
        return {
          candidate_tree_hash: value.input_tree_hash === evidence('1') ? evidence('2') : evidence('3'),
          changes: [{ path: value.story.allowed_changes[0].path, operation: value.story.allowed_changes[0].operations[0] }],
          changed_lines: 10,
          result_hash: evidence('4'),
        };
      },
      load_repair_packet: async (value: any) => {
        const body = {
          schema_version: 4 as const,
          story_id: value.story.story_id,
          failed_attempt: value.failed_attempt,
          findings: value.finding_hashes.map((findingHash: string, index: number) => ({
            finding_id: `finding-${String(index + 1)}`,
            source: 'REVIEW',
            category_code: 'acceptance_mismatch',
            path: value.story.allowed_changes[0].path,
            line: 1,
            instruction: 'Satisfy the rejected acceptance criterion.',
            evidence_hash: findingHash,
          })),
        };
        return { ...body, packet_hash: hashCanonicalV4(body) };
      },
      validate: async () => ({ passed: true, manifest_hash: evidence('5'), finding_hashes: [], failure_signature_hash: null }),
      review: async ({ story }: any) => {
        const rejected =
          options.alwaysReject ||
          (options.rejectFirst && story.story_id === 'story_alpha' && calls.filter((call) => call.story === 'story_alpha').length === 1);
        const attempted = calls.filter((call) => call.story === story.story_id).at(-1)?.attempt ?? 1;
        const signatureCharacter = options.repeatFailureSignature ? '8' : String.fromCharCode(55 + attempted);
        return {
          accepted: !rejected,
          attestation_hash: evidence('6'),
          finding_hashes: rejected ? [evidence('7')] : [],
          failure_signature_hash: rejected ? evidence(signatureCharacter) : null,
        };
      },
      persist_iteration: async ({ event, promotion }: any) => {
        events.push(event);
        if (promotion !== null) promotions.push(promotion.story.story_id);
      },
      persist_frontier_decision: async ({ event }: any) => {
        frontierDecisions.push(event);
      },
    },
    workerCapability,
    frontierDecisions,
  };
}

test('executes one dependency-ordered story per fresh context and carries only accepted receipts', async () => {
  const value = fixture();
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    value.calls.map((call) => [call.story, call.attempt, call.receipts]),
    [
      ['story_alpha', 1, []],
      ['story_beta', 1, ['story_alpha']],
    ],
  );
  assert.notEqual(value.calls[0]!.session, value.calls[1]!.session);
  assert.deepEqual(value.promotions, ['story_alpha', 'story_beta']);
  assert.deepEqual(
    result.events.map((event) => event.outcome),
    ['ACCEPTED', 'ACCEPTED'],
  );
});

test('retries a rejected candidate from the last accepted tree without promoting rejected bytes', async () => {
  const value = fixture({ rejectFirst: true });
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    value.calls.slice(0, 2).map((call) => [call.story, call.attempt, call.input]),
    [
      ['story_alpha', 1, evidence('1')],
      ['story_alpha', 2, evidence('1')],
    ],
  );
  assert.equal(value.calls[0]!.repair, null);
  assert.match(value.calls[1]!.repair!, /^[a-f0-9]{64}$/u);
  assert.equal((result.events[1] as any).repair_packet_hash, value.calls[1]!.repair);
  assert.deepEqual(value.promotions, ['story_alpha', 'story_beta']);
  assert.deepEqual(
    result.events.slice(0, 2).map((event) => event.outcome),
    ['RETRY', 'ACCEPTED'],
  );
});

test('frontier-led review control never launches a repair attempt without an event-bound frontier decision', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);

  assert.equal(waiting.status, 'AWAITING_FRONTIER_DECISION');
  assert.equal(first.calls.length, 1);
  assert.equal(waiting.events[0]?.outcome, 'RETRY');

  const undecided = fixture({ prior: [...waiting.events] });
  (undecided.input as any).review_control = { mode: 'FRONTIER_LED' };
  const stillWaiting = await runIterativeExecutorV4(undecided.input);
  assert.equal(stillWaiting.status, 'AWAITING_FRONTIER_DECISION');
  assert.equal(undecided.calls.length, 0);

  const resumed = fixture({ prior: [...waiting.events] });
  (resumed.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: frontierDecision(waiting.events[0]!.event_hash, 'RETRY'),
  };
  const completed = await runIterativeExecutorV4(resumed.input);
  assert.equal(completed.status, 'COMPLETE');
  assert.deepEqual(
    resumed.calls.slice(0, 1).map((call) => [call.story, call.attempt]),
    [['story_alpha', 2]],
  );
  assert.match(resumed.calls[0]!.repair!, /^[a-f0-9]{64}$/u);
});

test('frontier supervisor turns a rejected worker attempt into a durable repair cycle', async () => {
  const value = fixture({ rejectFirst: true });
  const decisions: string[] = [];

  const result = await runFrontierSupervisorV4({
    execution: value.input,
    limits: { max_frontier_decisions: 2 },
    decide: async ({ rejected_event }) => {
      decisions.push(rejected_event.event_hash);
      return {
        decision_id: 'decision_0000000000000001',
        decision_owner_ref: 'frontier-reviewer',
        authority_evidence_hash: evidence('a'),
        action: 'RETRY',
      };
    },
  });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0], result.events[0]!.event_hash);
  assert.deepEqual(
    value.calls.slice(0, 2).map((call) => [call.attempt, call.repair === null]),
    [
      [1, true],
      [2, false],
    ],
  );
  assert.equal(result.frontier_decisions.length, 1);
  assert.equal(result.events[1]!.frontier_decision_hash, result.frontier_decisions[0]!.decision_hash);
});

test('frontier supervisor persists escalation and never launches another worker attempt', async () => {
  const value = fixture({ rejectFirst: true });

  const result = await runFrontierSupervisorV4({
    execution: value.input,
    limits: { max_frontier_decisions: 2 },
    decide: async () => ({
      decision_id: 'decision_0000000000000001',
      decision_owner_ref: 'frontier-reviewer',
      authority_evidence_hash: evidence('a'),
      action: 'ESCALATE',
    }),
  });

  assert.equal(result.status, 'ESCALATE');
  assert.equal(result.escalation_reason, 'FRONTIER_DECISION');
  assert.equal(value.calls.length, 1);
  assert.equal(result.frontier_decisions[0]!.action, 'ESCALATE');
});

test('frontier supervisor fails closed when the frontier decision is malformed', async () => {
  const value = fixture({ rejectFirst: true });

  await assert.rejects(
    runFrontierSupervisorV4({
      execution: value.input,
      limits: { max_frontier_decisions: 2 },
      decide: async () => ({
        decision_id: 'not-canonical',
        decision_owner_ref: 'frontier-reviewer',
        authority_evidence_hash: evidence('a'),
        action: 'RETRY',
      }),
    }),
    /frontier returned an invalid decision/u,
  );

  assert.equal(value.calls.length, 1);
  assert.equal(value.frontierDecisions.length, 0);
});

test('frontier supervisor stops before requesting or launching work beyond its decision budget', async () => {
  const value = fixture({ alwaysReject: true, storyAttempts: 3 });
  let decisionNumber = 0;

  await assert.rejects(
    runFrontierSupervisorV4({
      execution: value.input,
      limits: { max_frontier_decisions: 1 },
      decide: async () => {
        decisionNumber += 1;
        return {
          decision_id: `decision_${String(decisionNumber).padStart(16, '0')}`,
          decision_owner_ref: 'frontier-reviewer',
          authority_evidence_hash: evidence('a'),
          action: 'RETRY',
        };
      },
    }),
    /frontier decision budget reached/u,
  );

  assert.equal(decisionNumber, 1);
  assert.equal(value.calls.length, 2);
  assert.equal(value.frontierDecisions.length, 1);
});

test('frontier supervisor reuses a durable retry decision after a crash without consulting frontier twice', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);

  const interrupted = fixture({ prior: [...waiting.events] });
  (interrupted.input as any).execute = async () => {
    throw new Error('simulated crash before worker launch');
  };
  await assert.rejects(
    runFrontierSupervisorV4({
      execution: interrupted.input,
      limits: { max_frontier_decisions: 2 },
      decide: async () => ({
        decision_id: 'decision_0000000000000001',
        decision_owner_ref: 'frontier-reviewer',
        authority_evidence_hash: evidence('a'),
        action: 'RETRY',
      }),
    }),
    /simulated crash/u,
  );
  assert.equal(interrupted.frontierDecisions.length, 1);

  const recovered = fixture({ prior: [...waiting.events], priorDecisions: [...interrupted.frontierDecisions] });
  const result = await runFrontierSupervisorV4({
    execution: recovered.input,
    limits: { max_frontier_decisions: 2 },
    decide: async () => {
      throw new Error('frontier must not be consulted twice');
    },
  });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(recovered.calls[0]!.attempt, 2);
  assert.equal(result.frontier_decisions.length, 1);
});

test('persists a canonical frontier retry decision before the worker and binds it into replay', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);

  const resumed = fixture({ prior: [...waiting.events] });
  (resumed.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: {
      decision_id: 'decision_0000000000000001',
      decision_owner_ref: 'frontier-reviewer',
      authority_evidence_hash: evidence('a'),
      rejected_event_hash: waiting.events[0]!.event_hash,
      action: 'RETRY',
    },
  };
  const completed = await runIterativeExecutorV4(resumed.input);

  assert.equal(completed.status, 'COMPLETE');
  assert.equal(resumed.frontierDecisions.length, 1);
  assert.match(resumed.frontierDecisions[0].decision_hash, /^[a-f0-9]{64}$/u);
  assert.equal((completed.events[1] as any).frontier_decision_hash, resumed.frontierDecisions[0].decision_hash);
});

test('resumes from a durable frontier retry decision after its persistence response is lost', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);

  const interrupted = fixture({ prior: [...waiting.events] });
  (interrupted.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: {
      decision_id: 'decision_0000000000000001',
      decision_owner_ref: 'frontier-reviewer',
      authority_evidence_hash: evidence('a'),
      rejected_event_hash: waiting.events[0]!.event_hash,
      action: 'RETRY',
    },
  };
  interrupted.input.persist_frontier_decision = async ({ event }: any) => {
    interrupted.frontierDecisions.push(event);
    throw new Error('simulated lost frontier decision persistence response');
  };
  await assert.rejects(runIterativeExecutorV4(interrupted.input), /lost frontier decision persistence response/u);
  assert.equal(interrupted.calls.length, 0);

  const resumed = fixture({ prior: [...waiting.events], priorDecisions: [...interrupted.frontierDecisions] });
  (resumed.input as any).review_control = { mode: 'FRONTIER_LED' };
  const completed = await runIterativeExecutorV4(resumed.input);
  assert.equal(completed.status, 'COMPLETE');
  assert.deepEqual(
    resumed.calls.map((call) => [call.story, call.attempt]),
    [
      ['story_alpha', 2],
      ['story_beta', 1],
    ],
  );
  assert.equal((completed.events[1] as any).frontier_decision_hash, interrupted.frontierDecisions[0].decision_hash);
});

test('rejects reuse of a durable frontier decision identity before another worker attempt', async () => {
  const first = fixture({ alwaysReject: true, storyAttempts: 3 });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const firstWaiting = await runIterativeExecutorV4(first.input);

  const second = fixture({ alwaysReject: true, storyAttempts: 3, prior: [...firstWaiting.events] });
  (second.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: {
      decision_id: 'decision_0000000000000001',
      decision_owner_ref: 'frontier-reviewer',
      authority_evidence_hash: evidence('a'),
      rejected_event_hash: firstWaiting.events[0]!.event_hash,
      action: 'RETRY',
    },
  };
  const secondWaiting = await runIterativeExecutorV4(second.input);
  assert.equal(secondWaiting.status, 'AWAITING_FRONTIER_DECISION');

  const duplicate = fixture({
    alwaysReject: true,
    storyAttempts: 3,
    prior: [...secondWaiting.events],
    priorDecisions: [...second.frontierDecisions],
  });
  (duplicate.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: {
      decision_id: 'decision_0000000000000001',
      decision_owner_ref: 'frontier-reviewer',
      authority_evidence_hash: evidence('b'),
      rejected_event_hash: secondWaiting.events[1]!.event_hash,
      action: 'RETRY',
    },
  };
  await assert.rejects(runIterativeExecutorV4(duplicate.input), /frontier decision is duplicated/u);
  assert.equal(duplicate.calls.length, 0);
  assert.equal(duplicate.frontierDecisions.length, 1);
});

test('replay rejects absent, altered, duplicate, and stale frontier decision evidence', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);
  const resumed = fixture({ prior: [...waiting.events] });
  (resumed.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: frontierDecision(waiting.events[0]!.event_hash, 'RETRY'),
  };
  const completed = await runIterativeExecutorV4(resumed.input);
  const recorded = resumed.frontierDecisions[0];

  const snapshot = inspectIterativeTrajectoryV4({
    contract: resumed.work,
    worker: resumed.workerCapability,
    plan: resumed.storyPlan,
    initial_tree_hash: evidence('1'),
    events: completed.events,
    review_control_mode: 'FRONTIER_LED',
    frontier_decisions: resumed.frontierDecisions,
  });
  assert.equal(snapshot.status, 'COMPLETE');

  const absent = fixture({ prior: [...completed.events] });
  (absent.input as any).review_control = { mode: 'FRONTIER_LED' };
  await assert.rejects(runIterativeExecutorV4(absent.input), /frontier-led retry lacks its exact durable decision/u);
  assert.equal(absent.calls.length, 0);

  const altered = fixture({ prior: [...completed.events], priorDecisions: [{ ...recorded, decision_owner_ref: 'altered-owner' }] });
  (altered.input as any).review_control = { mode: 'FRONTIER_LED' };
  await assert.rejects(runIterativeExecutorV4(altered.input), /frontier decision hash is invalid/u);
  assert.equal(altered.calls.length, 0);

  const duplicateBody = { ...recorded, decision_index: 2, previous_decision_hash: recorded.decision_hash } as any;
  delete duplicateBody.decision_hash;
  const duplicated = { ...duplicateBody, decision_hash: hashCanonicalV4(duplicateBody) };
  const duplicateHistory = fixture({ prior: [...completed.events], priorDecisions: [recorded, duplicated] });
  (duplicateHistory.input as any).review_control = { mode: 'FRONTIER_LED' };
  await assert.rejects(runIterativeExecutorV4(duplicateHistory.input), /frontier decision is duplicated/u);
  assert.equal(duplicateHistory.calls.length, 0);

  const staleBody = { ...recorded, rejected_event_hash: evidence('9') } as any;
  delete staleBody.decision_hash;
  const stale = fixture({ prior: [...completed.events], priorDecisions: [{ ...staleBody, decision_hash: hashCanonicalV4(staleBody) }] });
  (stale.input as any).review_control = { mode: 'FRONTIER_LED' };
  await assert.rejects(runIterativeExecutorV4(stale.input), /stale or not bound/u);
  assert.equal(stale.calls.length, 0);
});

test('frontier-led review control rejects stale decisions and can escalate without another worker call', async () => {
  const first = fixture({ rejectFirst: true });
  (first.input as any).review_control = { mode: 'FRONTIER_LED' };
  const waiting = await runIterativeExecutorV4(first.input);

  const stale = fixture({ prior: [...waiting.events] });
  (stale.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: frontierDecision(evidence('9'), 'RETRY'),
  };
  await assert.rejects(runIterativeExecutorV4(stale.input), /not bound to the pending rejected iteration/u);
  assert.equal(stale.calls.length, 0);

  const malformed = fixture({ prior: [...waiting.events] });
  (malformed.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: { ...frontierDecision(waiting.events[0]!.event_hash, 'RETRY'), action: 'KEEP_TRYING' },
  };
  await assert.rejects(runIterativeExecutorV4(malformed.input), /review control is invalid/u);
  assert.equal(malformed.calls.length, 0);

  const unavailable = fixture({ prior: [...waiting.events] });
  (unavailable.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: frontierDecision(waiting.events[0]!.event_hash, 'RETRY'),
  };
  delete (unavailable.input as any).persist_frontier_decision;
  await assert.rejects(runIterativeExecutorV4(unavailable.input), /frontier decision persistence is unavailable/u);
  assert.equal(unavailable.calls.length, 0);

  const escalated = fixture({ prior: [...waiting.events] });
  (escalated.input as any).review_control = {
    mode: 'FRONTIER_LED',
    frontier_decision: frontierDecision(waiting.events[0]!.event_hash, 'ESCALATE'),
  };
  const result = await runIterativeExecutorV4(escalated.input);
  assert.equal(result.status, 'ESCALATE');
  assert.equal(result.escalation_reason, 'FRONTIER_DECISION');
  assert.equal(escalated.calls.length, 0);
  assert.equal(result.frontier_decisions[0]?.action, 'ESCALATE');

  const replayed = fixture({ prior: [...waiting.events], priorDecisions: [...result.frontier_decisions] });
  (replayed.input as any).review_control = { mode: 'FRONTIER_LED' };
  const replayedResult = await runIterativeExecutorV4(replayed.input);
  assert.equal(replayedResult.status, 'ESCALATE');
  assert.equal(replayedResult.escalation_reason, 'FRONTIER_DECISION');
  assert.equal(replayed.calls.length, 0);
});

test('rejects a repair packet that is not derived from persisted failure evidence', async () => {
  const value = fixture({ rejectFirst: true });
  value.input.load_repair_packet = async (input: any) => {
    const body = {
      schema_version: 4 as const,
      story_id: input.story.story_id,
      failed_attempt: input.failed_attempt,
      findings: [
        {
          finding_id: 'finding-1',
          source: 'REVIEW' as const,
          category_code: 'different_failure',
          path: 'src/a.ts',
          line: 1,
          instruction: 'Unrelated repair.',
          evidence_hash: evidence('9'),
        },
      ],
    };
    return { ...body, packet_hash: hashCanonicalV4(body) };
  };
  await assert.rejects(runIterativeExecutorV4(value.input), /differs from persisted failure evidence/u);
  assert.deepEqual(value.promotions, []);
});

test('escalates after the story attempt budget instead of looping indefinitely', async () => {
  const value = fixture({ alwaysReject: true });
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'ESCALATE');
  assert.equal(result.escalation_story_id, 'story_alpha');
  assert.equal(result.escalation_reason, 'ATTEMPT_LIMIT');
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.promotions, []);

  const forgedBody = { ...result.events[1], outcome: 'RETRY' as const, escalation_reason: null } as any;
  delete forgedBody.event_hash;
  const forgedRetry = { ...forgedBody, event_hash: hashCanonicalV4(forgedBody) };
  const replayed = fixture({ prior: [result.events[0]!, forgedRetry] });
  await assert.rejects(runIterativeExecutorV4(replayed.input), /retry should have escalated/u);
});

test('escalates repeated normalized failures before spending the remaining attempt budget', async () => {
  const value = fixture({ alwaysReject: true, repeatFailureSignature: true, storyAttempts: 3 });
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'ESCALATE');
  assert.equal((result as any).escalation_reason, 'NO_PROGRESS');
  assert.equal(value.calls.length, 2);
  assert.equal((result.events[1] as any).escalation_reason, 'NO_PROGRESS');
});

test('rejects a candidate whose measured changed lines exceed the active story budget', async () => {
  const value = fixture();
  value.input.execute = async (input: any) => ({
    candidate_tree_hash: evidence('2'),
    changes: [{ path: input.story.allowed_changes[0].path, operation: input.story.allowed_changes[0].operations[0] }],
    changed_lines: 21,
    result_hash: evidence('4'),
  });
  await assert.rejects(runIterativeExecutorV4(value.input), /changed-line budget/u);
});

test('resumes from verified events and rejects forged plans, sessions, paths, and histories', async () => {
  const first = fixture();
  const persisted: StoryIterationEventV4[] = [];
  first.input.persist_iteration = async ({ event }: any) => {
    persisted.push(event);
    throw new Error('simulated lost response after atomic persistence');
  };
  await assert.rejects(runIterativeExecutorV4(first.input), /simulated lost response/);
  const resumed = fixture({ prior: persisted });
  const result = await runIterativeExecutorV4(resumed.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(
    resumed.calls.map((call) => call.story),
    ['story_beta'],
  );

  const forgedEventBody = structuredClone(persisted[0]) as any;
  delete forgedEventBody.event_hash;
  forgedEventBody.changes[0].operation = 'DELETE';
  const forgedEvent = { ...forgedEventBody, event_hash: hashCanonicalV4(forgedEventBody) };
  const forgedHistory = fixture({ prior: [forgedEvent] });
  await assert.rejects(runIterativeExecutorV4(forgedHistory.input), /change authority/);

  const invalid = fixture();
  assert.throws(
    () => loadIterativeStoryPlanV4({ ...invalid.storyPlan, plan_hash: evidence('0') }, invalid.work, invalid.workerCapability),
    /INVALID_CONTRACT/,
  );
  const outsideStory = story({ id: 'story_bad1', path: 'src/outside.ts', operation: 'MODIFY', priority: 1 });
  const outsideBody = { ...invalid.storyPlan, stories: [outsideStory] } as any;
  delete outsideBody.plan_hash;
  assert.throws(
    () => loadIterativeStoryPlanV4({ ...outsideBody, plan_hash: hashCanonicalV4(outsideBody) }, invalid.work, invalid.workerCapability),
    /allowed changes/,
  );
  const duplicateSession = fixture();
  duplicateSession.input.create_session_id = () => 'session_0000000000000001';
  await assert.rejects(runIterativeExecutorV4(duplicateSession.input), /fresh and valid/);

  const wrongOperation = fixture();
  wrongOperation.input.execute = async (value: any) => ({
    candidate_tree_hash: evidence('2'),
    changes: [{ path: value.story.allowed_changes[0].path, operation: 'DELETE' }],
    changed_lines: 10,
    result_hash: evidence('4'),
  });
  await assert.rejects(runIterativeExecutorV4(wrongOperation.input), /change authority/);
});

test('publishes strict provider-neutral JSON schemas for plans, decisions, and iteration receipts', async () => {
  const value = fixture();
  const result = await runIterativeExecutorV4(value.input);
  const ajv = new Ajv2020({ strict: true });
  const planSchema = JSON.parse(await readFile(new URL('../contracts/runtime-story-plan-v4.schema.json', import.meta.url), 'utf8'));
  const iterationSchema = JSON.parse(
    await readFile(new URL('../contracts/runtime-story-iteration-v4.schema.json', import.meta.url), 'utf8'),
  );
  const decisionSchema = JSON.parse(
    await readFile(new URL('../contracts/runtime-frontier-decision-v4.schema.json', import.meta.url), 'utf8'),
  );
  const validatePlan = ajv.compile(planSchema);
  const validateIteration = ajv.compile(iterationSchema);
  const validateDecision = ajv.compile(decisionSchema);
  const decision = createFrontierDecisionEventV4({
    schema_version: 4,
    type: 'FRONTIER_DECISION_RECORDED',
    run_id: value.storyPlan.run_id,
    plan_hash: value.storyPlan.plan_hash,
    decision_index: 1,
    previous_decision_hash: null,
    ...frontierDecision(result.events[0]!.event_hash, 'RETRY'),
  });
  assert.equal(validatePlan(value.storyPlan), true, JSON.stringify(validatePlan.errors));
  assert.equal(validateIteration(result.events[0]), true, JSON.stringify(validateIteration.errors));
  assert.equal(validateDecision(decision), true, JSON.stringify(validateDecision.errors));
  assert.equal(validatePlan({ ...value.storyPlan, provider: 'coupled-provider' }), false);
  assert.equal(validateIteration({ ...result.events[0], raw_reasoning: 'hidden context' }), false);
  assert.equal(validateDecision({ ...decision, raw_reasoning: 'hidden context' }), false);
});
