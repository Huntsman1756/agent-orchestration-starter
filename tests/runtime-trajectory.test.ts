import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { createModelAdapterCapabilitiesV4, createModelCapabilityContractV4, matchModelCapabilitiesV4 } from '../src/runtime/capability-contract.js';
import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { createStoryIterationEventV4, type IterativeStoryPlanV4 } from '../src/runtime/iterative-executor.js';
import { createRuntimeEventV4, type RuntimeEventV4 } from '../src/runtime/telemetry.js';
import { buildRuntimeExecutionGraphV4, evaluateRuntimeTrajectoryV4, exportRuntimeTraceV4 } from '../src/runtime/trajectory.js';
import { validWorkContract } from './runtime-contracts.test.js';

const h = (value: string) => value.repeat(64);

function contract(): RuntimeWorkContractV4 {
  const body = { ...validWorkContract(), allowed_changes: [{ path: 'src/a.ts', operations: ['MODIFY'] }], allowed_validation_ids: ['test'] } as Record<string, unknown>;
  delete body.contract_hash;
  return { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
}

function plan(work: RuntimeWorkContractV4): IterativeStoryPlanV4 {
  const storyBody = { story_id: 'story_alpha', title: 'Alpha', objective: 'Implement alpha', priority: 1, depends_on: [] as string[], allowed_changes: [{ path: 'src/a.ts', operations: ['MODIFY' as const] }], validation_ids: ['test'], acceptance_criteria: ['passes'], max_attempts: 2 };
  const stories = [{ ...storyBody, story_hash: hashCanonicalV4(storyBody) }];
  const body = { schema_version: 4 as const, run_id: work.run_id, contract_hash: work.contract_hash, base_sha: work.base_sha, max_iterations: 2, stories };
  return { ...body, plan_hash: hashCanonicalV4(body) };
}

function storyEvent(work: RuntimeWorkContractV4, storyPlan: IterativeStoryPlanV4) {
  return createStoryIterationEventV4({ schema_version: 4, type: 'STORY_ITERATION_RECORDED', run_id: work.run_id, plan_hash: storyPlan.plan_hash, story_id: 'story_alpha', iteration: 1, attempt: 1, session_id: 'session_0000000000000001', input_tree_hash: h('1'), candidate_tree_hash: h('2'), outcome: 'ACCEPTED', changes: [{ path: 'src/a.ts', operation: 'MODIFY' }], execution_result_hash: h('3'), validation_manifest_hash: h('4'), review_attestation_hash: h('5'), finding_hashes: [] });
}

function runtimeEvents(work: RuntimeWorkContractV4): RuntimeEventV4[] {
  const types = ['RUN_PLANNED', 'EXECUTION_STARTED', 'EXECUTION_COMPLETED', 'VALIDATION_RECORDED', 'REVIEW_STARTED', 'REVIEW_COMPLETED', 'FINALIZATION_STARTED', 'COMMIT_CREATED', 'BRANCH_PUSHED', 'PULL_REQUEST_RECORDED', 'REQUIRED_CHECKS_PASSED', 'RUN_MERGED'] as const;
  const events: RuntimeEventV4[] = [];
  for (const [index, type] of types.entries()) events.push(createRuntimeEventV4({ schema_version: 4, type, event_id: `evt_${String(index + 1).padStart(16, '0')}`, run_id: work.run_id, sequence: index + 1, previous_hash: events.at(-1)?.event_hash ?? null, recorded_at: `2026-08-10T12:00:${String(index).padStart(2, '0')}.000Z`, contract_hash: work.contract_hash, evidence_hashes: [h('a')], ...(type === 'VALIDATION_RECORDED' ? { duration_ms: 20, findings: [{ id: 'finding-low', severity: 'low', evidence_hash: h('b') }] } : {}) }));
  return events;
}

test('matches replaceable adapters against an explicit role capability contract', () => {
  const required = createModelCapabilityContractV4({ schema_version: 4, contract_id: 'economy-coder', role: 'ECONOMY_EXECUTOR', structured_output: true, tool_protocol: 'NATIVE', filesystem: 'CONTRACT_WRITE', network: 'BROKER_GATEWAY', context_mode: 'FRESH_PER_ATTEMPT', max_steps: 32, reasoning_efforts: ['low'], temperature_control: false });
  const adapter = createModelAdapterCapabilitiesV4({ schema_version: 4, adapter_id: 'replaceable-adapter', structured_output: true, tool_protocols: ['NATIVE'], filesystems: ['CONTRACT_WRITE'], networks: ['BROKER_GATEWAY'], context_modes: ['FRESH_PER_ATTEMPT'], max_steps: 64, reasoning_efforts: ['low', 'medium'], temperature_control: false });
  assert.equal(matchModelCapabilitiesV4(required, adapter).compatible, true);
  const { capability_hash: _discarded, ...adapterBody } = adapter;
  assert.throws(() => matchModelCapabilitiesV4(required, createModelAdapterCapabilitiesV4({ ...adapterBody, tool_protocols: ['NONE'] })), /CAPABILITY_UNVERIFIED/);
  assert.throws(() => matchModelCapabilitiesV4({ ...required, contract_hash: h('0') }, adapter), /CAPABILITY_UNVERIFIED/);
});

test('builds a bounded hash-stable story graph and safe trace export', () => {
  const work = contract();
  const storyPlan = plan(work);
  const graph = buildRuntimeExecutionGraphV4({ contract: work, plan: storyPlan, initial_tree_hash: h('1'), events: [storyEvent(work, storyPlan)] });
  assert.equal(graph.status, 'COMPLETE');
  assert.deepEqual(graph.nodes.map((node) => [node.node_id, node.status, node.attempts]), [['story_alpha', 'ACCEPTED', 1]]);
  const trace = exportRuntimeTraceV4(runtimeEvents(work));
  assert.equal(trace.spans.length, 12);
  assert.equal(trace.spans[3]!.attributes.finding_low_count, 1);
  assert.equal(JSON.stringify(trace).includes('finding-low'), false);
  assert.equal(trace.trace_hash.length, 64);
});

test('evaluates complete trajectories and reports tampered graph or lifecycle order as FAIL', () => {
  const work = contract();
  const storyPlan = plan(work);
  const accepted = storyEvent(work, storyPlan);
  const passed = evaluateRuntimeTrajectoryV4({ contract: work, plan: storyPlan, initial_tree_hash: h('1'), story_events: [accepted], runtime_events: runtimeEvents(work) });
  assert.equal(passed.outcome, 'PASS');
  assert.equal(passed.rules.every((rule) => rule.outcome === 'PASS'), true);

  const badBody = { ...accepted, changes: [{ path: 'src/a.ts', operation: 'DELETE' as const }] } as any;
  delete badBody.event_hash;
  const forged = { ...badBody, event_hash: hashCanonicalV4(badBody) };
  const reordered = runtimeEvents(work);
  const terminal = reordered.pop()!;
  reordered.splice(2, 0, terminal);
  const failed = evaluateRuntimeTrajectoryV4({ contract: work, plan: storyPlan, initial_tree_hash: h('1'), story_events: [forged], runtime_events: reordered });
  assert.equal(failed.outcome, 'FAIL');
  assert.equal(failed.rules.find((rule) => rule.rule_id === 'ITERATION_GRAPH')!.outcome, 'FAIL');
  assert.equal(failed.rules.find((rule) => rule.rule_id === 'TELEMETRY_CHAIN')!.outcome, 'FAIL');
});

test('publishes strict schemas for portable capabilities and trajectory reports', async () => {
  const ajv = new Ajv2020({ strict: true });
  const capabilitySchema = JSON.parse(await readFile(new URL('../contracts/runtime-capabilities-v4.schema.json', import.meta.url), 'utf8'));
  const evaluationSchema = JSON.parse(await readFile(new URL('../contracts/runtime-trajectory-evaluation-v4.schema.json', import.meta.url), 'utf8'));
  const validateCapability = ajv.compile(capabilitySchema);
  const validateEvaluation = ajv.compile(evaluationSchema);
  const capability = createModelCapabilityContractV4({ schema_version: 4, contract_id: 'reviewer', role: 'REVIEWER', structured_output: true, tool_protocol: 'NONE', filesystem: 'READ_ONLY', network: 'DENIED', context_mode: 'FRESH_PER_ATTEMPT', max_steps: 16, reasoning_efforts: ['high'], temperature_control: false });
  const work = contract();
  const storyPlan = plan(work);
  const evaluation = evaluateRuntimeTrajectoryV4({ contract: work, plan: storyPlan, initial_tree_hash: h('1'), story_events: [storyEvent(work, storyPlan)], runtime_events: runtimeEvents(work) });
  assert.equal(validateCapability(capability), true, JSON.stringify(validateCapability.errors));
  assert.equal(validateEvaluation(evaluation), true, JSON.stringify(validateEvaluation.errors));
  assert.equal(validateCapability({ ...capability, provider: 'coupled' }), false);
  assert.equal(validateEvaluation({ ...evaluation, reasoning: 'hidden' }), false);
});
