import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  createModelAdapterCapabilitiesV4,
  createModelCapabilityContractV4,
  matchModelCapabilitiesV4,
} from '../src/runtime/capability-contract.js';
import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import {
  createFrontierDecisionEventV4,
  createStoryIterationEventV4,
  type IterativeStoryPlanV4,
} from '../src/runtime/iterative-executor.js';
import { createRuntimeEventV4, type RuntimeEventV4 } from '../src/runtime/telemetry.js';
import { buildRuntimeExecutionGraphV4, evaluateRuntimeTrajectoryV4, exportRuntimeTraceV4 } from '../src/runtime/trajectory.js';
import { createWorkerCapabilityV4, type WorkerCapabilityV4 } from '../src/runtime/worker-capability.js';
import { validWorkContract } from './runtime-contracts.test.js';

const h = (value: string) => value.repeat(64);

function contract(): RuntimeWorkContractV4 {
  const body = {
    ...validWorkContract(),
    allowed_changes: [{ path: 'src/a.ts', operations: ['MODIFY'] }],
    implementation_targets: [{ path: 'src/a.ts', operations: ['MODIFY'] }],
    allowed_validation_ids: ['test'],
  } as Record<string, unknown>;
  delete body.contract_hash;
  return { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
}

function worker(): WorkerCapabilityV4 {
  return createWorkerCapabilityV4({
    schema_version: 4,
    binding_ref: 'trajectory-fixture',
    deployment: {
      provider_ref: 'fixture-provider',
      model_ref: 'fixture-model',
      model_revision: 'fixture-model-r1',
      model_artifact_hash: h('a'),
      endpoint_revision: 'fixture-endpoint-r1',
      harness_ref: 'fixture-harness',
      harness_revision: 'fixture-harness-r1',
      tool_protocol: 'native-json-tools',
      tool_parser_revision: 'fixture-parser-r1',
      tool_bundle_hash: h('b'),
      instruction_bundle_hash: h('d'),
      qualification_evidence_hash: h('c'),
    },
    capabilities: ['patch_application', 'repository_search'],
    limits: {
      max_story_files: 2,
      max_story_changed_lines: 100,
      max_story_context_bytes: 65_536,
      max_acceptance_criteria: 4,
      max_dependency_depth: 2,
      max_steps_per_attempt: 32,
      max_attempts: 3,
      no_progress_repeat_limit: 2,
    },
  });
}

function plan(work: RuntimeWorkContractV4, activeWorker: WorkerCapabilityV4): IterativeStoryPlanV4 {
  const storyBody = {
    story_id: 'story_alpha',
    title: 'Alpha',
    objective: 'Implement alpha',
    priority: 1,
    depends_on: [] as string[],
    allowed_changes: [{ path: 'src/a.ts', operations: ['MODIFY' as const] }],
    validation_ids: ['test'],
    acceptance_criteria: ['passes'],
    required_capabilities: ['patch_application'],
    context_budget_bytes: 4_096,
    max_changed_lines: 20,
    max_steps: 16,
    max_attempts: 2,
  };
  const stories = [{ ...storyBody, story_hash: hashCanonicalV4(storyBody) }];
  const body = {
    schema_version: 4 as const,
    run_id: work.run_id,
    contract_hash: work.contract_hash,
    base_sha: work.base_sha,
    worker_capability_hash: activeWorker.worker_capability_hash,
    max_iterations: 2,
    stories,
  };
  return { ...body, plan_hash: hashCanonicalV4(body) };
}

function storyEvent(work: RuntimeWorkContractV4, storyPlan: IterativeStoryPlanV4) {
  return createStoryIterationEventV4({
    schema_version: 4,
    type: 'STORY_ITERATION_RECORDED',
    run_id: work.run_id,
    plan_hash: storyPlan.plan_hash,
    story_id: 'story_alpha',
    iteration: 1,
    attempt: 1,
    session_id: 'session_0000000000000001',
    input_tree_hash: h('1'),
    candidate_tree_hash: h('2'),
    outcome: 'ACCEPTED',
    changes: [{ path: 'src/a.ts', operation: 'MODIFY' }],
    changed_lines: 10,
    execution_result_hash: h('3'),
    validation_manifest_hash: h('4'),
    review_attestation_hash: h('5'),
    finding_hashes: [],
    repair_packet_hash: null,
    failure_signature_hash: null,
    escalation_reason: null,
  });
}

function runtimeEvents(work: RuntimeWorkContractV4): RuntimeEventV4[] {
  const types = [
    'RUN_PLANNED',
    'EXECUTION_STARTED',
    'EXECUTION_COMPLETED',
    'VALIDATION_RECORDED',
    'REVIEW_STARTED',
    'REVIEW_COMPLETED',
    'FINALIZATION_STARTED',
    'COMMIT_CREATED',
    'BRANCH_PUSHED',
    'PULL_REQUEST_RECORDED',
    'REQUIRED_CHECKS_PASSED',
    'RUN_MERGED',
  ] as const;
  const events: RuntimeEventV4[] = [];
  for (const [index, type] of types.entries())
    events.push(
      createRuntimeEventV4({
        schema_version: 4,
        type,
        event_id: `evt_${String(index + 1).padStart(16, '0')}`,
        run_id: work.run_id,
        sequence: index + 1,
        previous_hash: events.at(-1)?.event_hash ?? null,
        recorded_at: `2026-08-10T12:00:${String(index).padStart(2, '0')}.000Z`,
        contract_hash: work.contract_hash,
        evidence_hashes: [h('a')],
        ...(type === 'VALIDATION_RECORDED'
          ? { duration_ms: 20, findings: [{ id: 'finding-low', severity: 'low', evidence_hash: h('b') }] }
          : {}),
      }),
    );
  return events;
}

test('matches replaceable adapters against an explicit role capability contract', () => {
  const required = createModelCapabilityContractV4({
    schema_version: 4,
    contract_id: 'economy-coder',
    role: 'ECONOMY_EXECUTOR',
    structured_output: true,
    tool_protocol: 'NATIVE',
    filesystem: 'CONTRACT_WRITE',
    network: 'BROKER_GATEWAY',
    context_mode: 'FRESH_PER_ATTEMPT',
    max_steps: 32,
    reasoning_efforts: ['low'],
    temperature_control: false,
  });
  const adapter = createModelAdapterCapabilitiesV4({
    schema_version: 4,
    adapter_id: 'replaceable-adapter',
    structured_output: true,
    tool_protocols: ['NATIVE'],
    filesystems: ['CONTRACT_WRITE'],
    networks: ['BROKER_GATEWAY'],
    context_modes: ['FRESH_PER_ATTEMPT'],
    max_steps: 64,
    reasoning_efforts: ['low', 'medium'],
    temperature_control: false,
  });
  assert.equal(matchModelCapabilitiesV4(required, adapter).compatible, true);
  const { capability_hash: _discarded, ...adapterBody } = adapter;
  assert.throws(
    () => matchModelCapabilitiesV4(required, createModelAdapterCapabilitiesV4({ ...adapterBody, tool_protocols: ['NONE'] })),
    /CAPABILITY_UNVERIFIED/,
  );
  assert.throws(() => matchModelCapabilitiesV4({ ...required, contract_hash: h('0') }, adapter), /CAPABILITY_UNVERIFIED/);
});

test('builds a bounded hash-stable story graph and safe trace export', () => {
  const work = contract();
  const activeWorker = worker();
  const storyPlan = plan(work, activeWorker);
  const graph = buildRuntimeExecutionGraphV4({
    contract: work,
    worker: activeWorker,
    plan: storyPlan,
    initial_tree_hash: h('1'),
    events: [storyEvent(work, storyPlan)],
  });
  assert.equal(graph.status, 'COMPLETE');
  assert.deepEqual(
    graph.nodes.map((node) => [node.node_id, node.status, node.attempts]),
    [['story_alpha', 'ACCEPTED', 1]],
  );
  const trace = exportRuntimeTraceV4(runtimeEvents(work));
  assert.equal(trace.spans.length, 12);
  assert.equal(trace.spans[3]!.attributes.finding_low_count, 1);
  assert.equal(JSON.stringify(trace).includes('finding-low'), false);
  assert.equal(trace.trace_hash.length, 64);
});

test('binds verified frontier retry decisions into the portable execution graph', () => {
  const work = contract();
  const activeWorker = worker();
  const storyPlan = plan(work, activeWorker);
  const rejected = createStoryIterationEventV4({
    schema_version: 4,
    type: 'STORY_ITERATION_RECORDED',
    run_id: work.run_id,
    plan_hash: storyPlan.plan_hash,
    story_id: 'story_alpha',
    iteration: 1,
    attempt: 1,
    session_id: 'session_0000000000000001',
    input_tree_hash: h('1'),
    candidate_tree_hash: h('2'),
    outcome: 'RETRY',
    changes: [{ path: 'src/a.ts', operation: 'MODIFY' }],
    changed_lines: 10,
    execution_result_hash: h('3'),
    validation_manifest_hash: h('4'),
    review_attestation_hash: h('5'),
    finding_hashes: [h('6')],
    repair_packet_hash: null,
    frontier_decision_hash: null,
    failure_signature_hash: h('7'),
    escalation_reason: null,
  });
  const decision = createFrontierDecisionEventV4({
    schema_version: 4,
    type: 'FRONTIER_DECISION_RECORDED',
    run_id: work.run_id,
    plan_hash: storyPlan.plan_hash,
    decision_index: 1,
    previous_decision_hash: null,
    decision_id: 'decision_0000000000000001',
    decision_owner_ref: 'frontier-reviewer',
    authority_evidence_hash: h('8'),
    rejected_event_hash: rejected.event_hash,
    action: 'RETRY',
  });
  const accepted = createStoryIterationEventV4({
    schema_version: 4,
    type: 'STORY_ITERATION_RECORDED',
    run_id: work.run_id,
    plan_hash: storyPlan.plan_hash,
    story_id: 'story_alpha',
    iteration: 2,
    attempt: 2,
    session_id: 'session_0000000000000002',
    input_tree_hash: h('1'),
    candidate_tree_hash: h('3'),
    outcome: 'ACCEPTED',
    changes: [{ path: 'src/a.ts', operation: 'MODIFY' }],
    changed_lines: 10,
    execution_result_hash: h('4'),
    validation_manifest_hash: h('5'),
    review_attestation_hash: h('6'),
    finding_hashes: [],
    repair_packet_hash: h('9'),
    frontier_decision_hash: decision.decision_hash,
    failure_signature_hash: null,
    escalation_reason: null,
  });

  const graph = buildRuntimeExecutionGraphV4({
    contract: work,
    worker: activeWorker,
    plan: storyPlan,
    initial_tree_hash: h('1'),
    events: [rejected, accepted],
    review_control_mode: 'FRONTIER_LED',
    frontier_decisions: [decision],
  });
  assert.equal(graph.status, 'COMPLETE');
  assert.deepEqual(graph.frontier_decision_hashes, [decision.decision_hash]);
});

test('evaluates complete trajectories and reports tampered graph or lifecycle order as FAIL', () => {
  const work = contract();
  const activeWorker = worker();
  const storyPlan = plan(work, activeWorker);
  const accepted = storyEvent(work, storyPlan);
  const passed = evaluateRuntimeTrajectoryV4({
    contract: work,
    worker: activeWorker,
    plan: storyPlan,
    initial_tree_hash: h('1'),
    story_events: [accepted],
    runtime_events: runtimeEvents(work),
  });
  assert.equal(passed.outcome, 'PASS');
  assert.equal(
    passed.rules.every((rule) => rule.outcome === 'PASS'),
    true,
  );

  const badBody = { ...accepted, changes: [{ path: 'src/a.ts', operation: 'DELETE' as const }] } as any;
  delete badBody.event_hash;
  const forged = { ...badBody, event_hash: hashCanonicalV4(badBody) };
  const reordered = runtimeEvents(work);
  const terminal = reordered.pop()!;
  reordered.splice(2, 0, terminal);
  const failed = evaluateRuntimeTrajectoryV4({
    contract: work,
    worker: activeWorker,
    plan: storyPlan,
    initial_tree_hash: h('1'),
    story_events: [forged],
    runtime_events: reordered,
  });
  assert.equal(failed.outcome, 'FAIL');
  assert.equal(failed.rules.find((rule) => rule.rule_id === 'ITERATION_GRAPH')!.outcome, 'FAIL');
  assert.equal(failed.rules.find((rule) => rule.rule_id === 'TELEMETRY_CHAIN')!.outcome, 'FAIL');
});

test('publishes strict schemas for portable capabilities and trajectory reports', async () => {
  const ajv = new Ajv2020({ strict: true });
  const capabilitySchema = JSON.parse(await readFile(new URL('../contracts/runtime-capabilities-v4.schema.json', import.meta.url), 'utf8'));
  const evaluationSchema = JSON.parse(
    await readFile(new URL('../contracts/runtime-trajectory-evaluation-v4.schema.json', import.meta.url), 'utf8'),
  );
  const validateCapability = ajv.compile(capabilitySchema);
  const validateEvaluation = ajv.compile(evaluationSchema);
  const capability = createModelCapabilityContractV4({
    schema_version: 4,
    contract_id: 'reviewer',
    role: 'REVIEWER',
    structured_output: true,
    tool_protocol: 'NONE',
    filesystem: 'READ_ONLY',
    network: 'DENIED',
    context_mode: 'FRESH_PER_ATTEMPT',
    max_steps: 16,
    reasoning_efforts: ['high'],
    temperature_control: false,
  });
  const work = contract();
  const activeWorker = worker();
  const storyPlan = plan(work, activeWorker);
  const evaluation = evaluateRuntimeTrajectoryV4({
    contract: work,
    worker: activeWorker,
    plan: storyPlan,
    initial_tree_hash: h('1'),
    story_events: [storyEvent(work, storyPlan)],
    runtime_events: runtimeEvents(work),
  });
  assert.equal(validateCapability(capability), true, JSON.stringify(validateCapability.errors));
  assert.equal(validateEvaluation(evaluation), true, JSON.stringify(validateEvaluation.errors));
  assert.equal(validateCapability({ ...capability, provider: 'coupled' }), false);
  assert.equal(validateEvaluation({ ...evaluation, reasoning: 'hidden' }), false);
});
