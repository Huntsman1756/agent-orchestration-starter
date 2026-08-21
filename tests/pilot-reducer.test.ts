import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonical } from '../src/pilot/canonical-json.js';
import type { PilotEventV3, PilotManifestV3 } from '../src/pilot/contracts.js';
import { assignArms, freezeManifest, type PilotManifestInputV3 } from '../src/pilot/manifest.js';
import { reduceEvents } from '../src/pilot/reducer.js';
import { replayBlock } from '../src/pilot/state-machine.js';

const hash = (character: string) => character.repeat(64);
const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;
type Arm = (typeof arms)[number];
type Decision = 'ACCEPT' | 'REJECT';

function manifest(overrides: Partial<PilotManifestInputV3> = {}): PilotManifestV3 {
  const block = (id: string): PilotManifestInputV3['blocks'][number] => ({
    block_id: id,
    task_id: 'task-v3',
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: 'triplet-v3',
    case_fingerprint: hash('a'),
    contract_hash: hash('b'),
    base_revision: hash('c'),
    clean_tree_hash: hash('d'),
    fixtures_hash: hash('e'),
    complexity_class: 'mechanical' as const,
    risk_class: 'low' as const,
    changed_line_band: '1-25',
    validation_surface: ['test'],
    cheap_eligible: true as const,
    comparative_eligible: true as const,
    routing_selection_reason: 'preclassified',
    selected_executor_capability_initial: 'cheap' as const,
    selected_executor_capability_final_expected: 'strong' as const,
    exclusion_reason: null,
  });
  const assignmentSeed = 'seed-v3';
  const assignmentAlgorithmVersion = 'stratified-v1';
  const blocks = [block('block-a'), block('block-b'), block('block-c')];
  const assignedArmByBlock = new Map(
    assignArms({
      blocks,
      assignment_seed: assignmentSeed,
      assignment_algorithm_version: assignmentAlgorithmVersion,
    }).map((assignment) => [assignment.block_id, assignment.pilot_arm]),
  );
  const routedBlocks = blocks.map((candidate) => {
    const arm = assignedArmByBlock.get(candidate.block_id)!;
    return {
      ...candidate,
      selected_executor_capability_initial: arm === 'A_STRONG_BASELINE' ? ('strong' as const) : ('cheap' as const),
      selected_executor_capability_final_expected: arm === 'B_CHEAP_NO_EARLY_ESCALATION' ? ('cheap' as const) : ('strong' as const),
    };
  });
  return freezeManifest({
    pilot_id: 'pilot-v3',
    pilot_schema_version: 3,
    created_at: '2026-08-08T12:00:00.000Z',
    blocks: routedBlocks,
    assignment_seed: assignmentSeed,
    assignment_algorithm_version: assignmentAlgorithmVersion,
    binding_policy_version: 'binding-policy-v1',
    binding_registry: [
      { binding_ref: 'binding-cheap', capability_class: 'cheap', profile_hash: hash('f') },
      { binding_ref: 'binding-strong', capability_class: 'strong', profile_hash: hash('0') },
    ],
    routing_reviewer_binding_ref: 'binding-strong',
    routing_reviewer_capability: 'strong',
    review_mode: 'incremental_diff',
    routing_policy_version: 'routing-v1',
    review_policy_version: 'review-v1',
    state_machine_version: 'state-v1',
    reducer_version: 'reducer-v1',
    isolation_policy_version: 'isolation-v1',
    canonical_tree_algorithm_version: 'canonical-tree-v1',
    volatile_paths_policy_hash: hash('1'),
    stage_thresholds: {
      stage_1_blocks_per_arm: 10,
      stage_2_blocks_per_arm: 20,
      stage_3_max_blocks_per_arm: 30,
      material_improvement_rate: 0.1,
      economic_rejection_rate: 0.1,
      max_parent_rework_block_rate: 0.1,
      max_parent_rework_production_line_share: 0.1,
      max_escaped_material_defects: 0,
      max_escaped_high_defects: 0,
      max_escaped_critical_defects: 0,
      min_observed_cost_completeness: 0.9,
      min_observed_strong_token_completeness: 0.9,
      min_stratum_triplets_for_promotion: 10,
      confidence_level: 0.95,
      interval_algorithm_version: 'bootstrap-v1',
      resampling_iterations: 100,
    },
    post_acceptance_window: {
      duration_seconds: 60,
      allowed_clock_skew_seconds: 1,
      closure_rule: 'elapsed_duration',
      late_evidence_policy: 'warn_next_evaluation',
      window_policy_version: 'window-v1',
    },
    pricing_snapshot: {
      pricing_snapshot_id: 'pricing-v1',
      pricing_snapshot_hash: hash('2'),
      currency: 'EUR',
      unit_scale: 1,
      effective_at: '2026-08-08T12:00:00.000Z',
      tariffs: [
        {
          binding_ref: 'binding-cheap',
          input_token_micro_units_per_token: 1,
          output_token_micro_units_per_token: 1,
          cached_input_token_micro_units_per_token: null,
          reasoning_token_micro_units_per_token: null,
          authoritative_charge_supported: false,
        },
        {
          binding_ref: 'binding-strong',
          input_token_micro_units_per_token: 1,
          output_token_micro_units_per_token: 1,
          cached_input_token_micro_units_per_token: null,
          reasoning_token_micro_units_per_token: null,
          authoritative_charge_supported: false,
        },
      ],
    },
    ...overrides,
  });
}

function boundaryHash(event: Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }>): string {
  const p = event.payload;
  return hashCanonical({
    pilot_id: event.pilot_id,
    block_id: event.block_id,
    review_id: p.review_id,
    reviewed_attempt_id: p.reviewed_attempt_id,
    review_boundary_from_revision: p.review_boundary_from_revision,
    review_boundary_to_revision: p.review_boundary_to_revision,
    review_input_diff_hash: p.review_input_diff_hash,
    unresolved_finding_ids: p.unresolved_finding_ids,
    validation_evidence_hashes: p.validation_evidence_hashes,
  });
}

function historyFor(
  pilotManifest: PilotManifestV3,
  arm: Arm | null,
  decisions: readonly Decision[],
  options: { duration_ms?: number; accepted_at?: string } = {},
): PilotEventV3[] {
  const assignment = arm === null ? null : pilotManifest.arm_assignments.find((candidate) => candidate.pilot_arm === arm)!;
  const frozenBlock = assignment
    ? pilotManifest.blocks.find((candidate) => candidate.block_id === assignment.block_id)!
    : pilotManifest.blocks.find((candidate) => !candidate.comparative_eligible)!;
  const events: PilotEventV3[] = [];
  const push = (event_type: PilotEventV3['event_type'], payload: unknown) => {
    const sequence = events.length + 1;
    events.push({
      schema_version: 3,
      event_id: `${frozenBlock.block_id}-event-${sequence}`,
      event_type,
      pilot_id: pilotManifest.pilot_id,
      manifest_hash: pilotManifest.manifest_hash,
      task_id: frozenBlock.task_id,
      block_id: frozenBlock.block_id,
      matching_stratum: frozenBlock.matching_stratum,
      pair_or_triplet_id: frozenBlock.pair_or_triplet_id,
      case_fingerprint: frozenBlock.case_fingerprint,
      pilot_arm: arm,
      sequence_number: sequence,
      occurred_at: `2026-08-08T12:00:${String(sequence).padStart(2, '0')}.000Z`,
      recorded_at: `2026-08-08T12:01:${String(sequence).padStart(2, '0')}.000Z`,
      producer_id: 'test-producer',
      payload,
    } as PilotEventV3);
  };
  push('BLOCK_PLANNED', { planned_block_hash: frozenBlock.contract_hash });
  if (arm !== null) push('ARM_ASSIGNED', { assigned_arm: arm, assignment_algorithm_version: pilotManifest.assignment_algorithm_version });
  push('ISOLATION_ATTESTED', {
    workspace_instance_id: `workspace-${frozenBlock.block_id}`,
    base_revision: frozenBlock.base_revision,
    clean_tree_hash: frozenBlock.clean_tree_hash,
    isolation_status: 'CLEAN',
    observed_tree_hash: frozenBlock.clean_tree_hash,
    isolation_policy_version: pilotManifest.isolation_policy_version,
    attestor_id: 'attestor-v1',
    evidence_hash: hash('3'),
  });
  let inputRevision = frozenBlock.base_revision;
  let previousBoundaryHash: string | null = null;
  let unresolved: string[] = [];
  for (let round = 1; round <= decisions.length; round += 1) {
    if (round === 3 && arm === 'C_ADAPTIVE_EARLY_ESCALATION')
      push('ESCALATION_DECIDED', {
        rejected_review_event_id: events.at(-1)!.event_id,
        escalation_reason: 'second-review-rejected',
        target_binding_ref: 'binding-strong',
        target_capability: 'strong',
        decision_policy_version: pilotManifest.routing_policy_version,
      });
    const attemptId = `${frozenBlock.block_id}-attempt-${round}`;
    const reviewId = `${frozenBlock.block_id}-review-${round}`;
    const capability =
      arm === null || arm === 'A_STRONG_BASELINE' || (arm === 'C_ADAPTIVE_EARLY_ESCALATION' && round === 3) ? 'strong' : 'cheap';
    const binding = capability === 'strong' ? 'binding-strong' : 'binding-cheap';
    const kind = round === 1 ? 'IMPLEMENTATION' : round === 2 ? 'REPAIR_1' : 'FINAL_EXECUTION';
    const start = round * 100;
    const duration = options.duration_ms ?? 10;
    const executorSession = `${frozenBlock.block_id}-executor-${round}`;
    const outputRevision = hash(String(3 + round));
    const outputTreeHash = hash(String(6 + round));
    push('EXECUTION_STARTED', {
      attempt_id: attemptId,
      attempt_number: round,
      attempt_kind: kind,
      executor_capability: capability,
      executor_binding_ref: binding,
      executor_session_id: executorSession,
      input_revision: inputRevision,
      started_monotonic_ms: start,
    });
    push('EXECUTION_COMPLETED', {
      attempt_id: attemptId,
      attempt_number: round,
      attempt_kind: kind,
      executor_capability: capability,
      executor_binding_ref: binding,
      executor_session_id: executorSession,
      input_revision: inputRevision,
      output_revision: outputRevision,
      output_tree_hash: outputTreeHash,
      canonical_tree_algorithm_version: pilotManifest.canonical_tree_algorithm_version,
      volatile_paths_policy_hash: pilotManifest.volatile_paths_policy_hash,
      tree_reproduced: true,
      tree_reproduction_evidence_hash: hash('a'),
      output_diff_hash: hash('b'),
      changed_lines_production: 2,
      changed_lines_tests: 3,
      changed_lines_docs: 4,
      outcome: 'COMPLETED',
      started_monotonic_ms: start,
      finished_monotonic_ms: start + duration,
      duration_ms: duration,
    });
    const validationHash = hash(String(round));
    push('VALIDATION_RECORDED', {
      validation_id: `${frozenBlock.block_id}-validation-${round}`,
      attempt_id: attemptId,
      validation_surface: ['test'],
      passed: true,
      tests_failing: 0,
      tests_passing: round + 2,
      evidence_hashes: [validationHash],
    });
    push('REVIEW_STARTED', {
      review_id: reviewId,
      review_round: round,
      reviewer_binding_ref: pilotManifest.routing_reviewer_binding_ref,
      reviewer_session_id: `${frozenBlock.block_id}-reviewer-${round}`,
      reviewed_attempt_id: attemptId,
      executor_session_id_reviewed: executorSession,
      started_monotonic_ms: start + duration + 1,
    });
    const decision = decisions[round - 1];
    const findings: Array<{
      finding_id: string;
      severity: 'high';
      material: true;
      category_code: string;
      status: 'OPEN' | 'RESOLVED';
      evidence_hashes: string[];
    }> = unresolved.map((finding_id) => ({
      finding_id,
      severity: 'high',
      material: true,
      category_code: 'correctness',
      status: 'RESOLVED',
      evidence_hashes: [hash('c')],
    }));
    unresolved = decision === 'REJECT' ? [`${frozenBlock.block_id}-finding-${round}`] : [];
    if (decision === 'REJECT')
      findings.push({
        finding_id: unresolved[0],
        severity: 'high',
        material: true,
        category_code: 'correctness',
        status: 'OPEN',
        evidence_hashes: [hash('d')],
      });
    const completion = {
      schema_version: 3,
      event_id: `${frozenBlock.block_id}-event-${events.length + 1}`,
      event_type: 'REVIEW_COMPLETED',
      pilot_id: pilotManifest.pilot_id,
      manifest_hash: pilotManifest.manifest_hash,
      task_id: frozenBlock.task_id,
      block_id: frozenBlock.block_id,
      matching_stratum: frozenBlock.matching_stratum,
      pair_or_triplet_id: frozenBlock.pair_or_triplet_id,
      case_fingerprint: frozenBlock.case_fingerprint,
      pilot_arm: arm,
      sequence_number: events.length + 1,
      occurred_at: `2026-08-08T12:00:${String(events.length + 1).padStart(2, '0')}.000Z`,
      recorded_at: `2026-08-08T12:01:${String(events.length + 1).padStart(2, '0')}.000Z`,
      producer_id: 'test-producer',
      payload: {
        review_id: reviewId,
        review_round: round,
        reviewer_binding_ref: pilotManifest.routing_reviewer_binding_ref,
        reviewer_session_id: `${frozenBlock.block_id}-reviewer-${round}`,
        reviewed_attempt_id: attemptId,
        executor_session_id_reviewed: executorSession,
        review_input_diff_hash: hash('e'),
        previous_review_boundary_hash: previousBoundaryHash,
        review_boundary_hash: hash('0'),
        review_boundary_from_revision: inputRevision,
        review_boundary_to_revision: outputRevision,
        unresolved_finding_ids: unresolved,
        validation_evidence_hashes: [validationHash],
        bounded_context_hashes: [],
        additional_context_requests: [],
        material_findings: findings,
        non_material_findings: [],
        decision,
        started_monotonic_ms: start + duration + 1,
        finished_monotonic_ms: start + duration + 11,
        duration_ms: 10,
      },
    } as Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }>;
    completion.payload.review_boundary_hash = boundaryHash(completion);
    events.push(completion);
    previousBoundaryHash = completion.payload.review_boundary_hash;
    inputRevision = outputRevision;
  }
  const last = [...events].reverse().find((event) => event.event_type === 'EXECUTION_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'EXECUTION_COMPLETED' }
  >;
  if (decisions.at(-1) === 'ACCEPT')
    push('BLOCK_ACCEPTED', {
      accepted_revision: last.payload.output_revision,
      accepted_tree_hash: last.payload.output_tree_hash,
      accepted_at: options.accepted_at ?? '2026-08-08T12:02:00.000Z',
    });
  else if (decisions.length === 3) push('BLOCK_FAILED', { reason_code: 'final-review-rejected', evidence_hash: hash('f') });
  return events;
}

function eventAfter(
  events: readonly PilotEventV3[],
  event_type: PilotEventV3['event_type'],
  payload: unknown,
  overrides: Partial<PilotEventV3> = {},
): PilotEventV3 {
  const last = events.at(-1)!;
  return {
    ...last,
    event_id: `${last.block_id}-event-${last.sequence_number + 1}`,
    event_type,
    sequence_number: last.sequence_number + 1,
    occurred_at: '2026-08-08T12:04:00.000Z',
    recorded_at: '2026-08-08T12:04:00.000Z',
    payload,
    ...overrides,
  } as PilotEventV3;
}

function reduceHistory(pilotManifest: PilotManifestV3, events: readonly PilotEventV3[]) {
  return reduceEvents(pilotManifest, events).find((observation) => observation.block_id === events[0]!.block_id)!;
}

function withExecutorUsage(events: readonly PilotEventV3[]): PilotEventV3[] {
  const completionIndex = events.findIndex((event) => event.event_type === 'EXECUTION_COMPLETED');
  const completion = events[completionIndex] as Extract<PilotEventV3, { event_type: 'EXECUTION_COMPLETED' }>;
  const usage = {
    ...completion,
    event_id: `${completion.block_id}-usage-1`,
    event_type: 'USAGE_RECORDED',
    payload: {
      usage_id: 'usage-1',
      attempt_number: 1,
      role: 'executor',
      binding_ref: completion.payload.executor_binding_ref,
      provider_usage_id: null,
      input_tokens_observed: 2,
      output_tokens_observed: 3,
      cached_input_tokens_observed: 0,
      reasoning_tokens_observed: 0,
      input_tokens_estimated: null,
      output_tokens_estimated: null,
      cached_input_tokens_estimated: null,
      reasoning_tokens_estimated: null,
      token_estimator_id: null,
      token_estimator_version: null,
      pricing_snapshot_id: 'pricing-v1',
      cost_observed: null,
      cost_estimated: null,
      currency: 'EUR',
      cost_provenance: 'TARIFF_REPRODUCED',
      attempt_id: completion.payload.attempt_id,
      review_id: null,
      orchestrator_operation_id: null,
    },
  } as PilotEventV3;
  return [...events.slice(0, completionIndex + 1), usage, ...events.slice(completionIndex + 1)].map(
    (event, index) =>
      ({
        ...event,
        sequence_number: index + 1,
        occurred_at: `2026-08-08T12:00:${String(index + 1).padStart(2, '0')}.000Z`,
        recorded_at: `2026-08-08T12:01:${String(index + 1).padStart(2, '0')}.000Z`,
      }) as PilotEventV3,
  );
}

function rehashManifest(frozen: PilotManifestV3, pricing_snapshot: PilotManifestV3['pricing_snapshot']): PilotManifestV3 {
  const { pricing_snapshot_hash: _pricingHash, ...pricingContent } = pricing_snapshot;
  const priced = { ...pricing_snapshot, pricing_snapshot_hash: hashCanonical(pricingContent) };
  const { manifest_hash: _manifestHash, ...content } = { ...frozen, pricing_snapshot: priced };
  return { ...content, manifest_hash: hashCanonical(content) } as PilotManifestV3;
}

function resequence(events: readonly PilotEventV3[]): PilotEventV3[] {
  return events.map(
    (event, index) =>
      ({
        ...event,
        sequence_number: index + 1,
        occurred_at: `2026-08-08T12:00:${String(index + 1).padStart(2, '0')}.000Z`,
      }) as PilotEventV3,
  );
}

function directManifest(): PilotManifestV3 {
  const baseline = manifest();
  const direct = {
    ...baseline.blocks[0],
    block_id: 'direct-strong',
    pair_or_triplet_id: 'direct-only',
    cheap_eligible: false as const,
    comparative_eligible: false as const,
    selected_executor_capability_initial: 'strong' as const,
    selected_executor_capability_final_expected: 'strong' as const,
    exclusion_reason: 'direct-to-strong',
  };
  return manifest({ blocks: [...baseline.blocks, direct] });
}

function acceptedReferences(events: readonly PilotEventV3[]) {
  const accepted = events.find(
    (event): event is Extract<PilotEventV3, { event_type: 'BLOCK_ACCEPTED' }> => event.event_type === 'BLOCK_ACCEPTED',
  )!;
  const review = [...events]
    .reverse()
    .find(
      (event): event is Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }> =>
        event.event_type === 'REVIEW_COMPLETED' && event.payload.decision === 'ACCEPT',
    )!;
  return { accepted, review };
}

function defectAfter(
  events: readonly PilotEventV3[],
  overrides: Partial<Extract<PilotEventV3, { event_type: 'POST_ACCEPT_DEFECT_RECORDED' }>['payload']> = {},
  envelope: Partial<PilotEventV3> = {},
): PilotEventV3 {
  const { accepted, review } = acceptedReferences(events);
  return eventAfter(
    events,
    'POST_ACCEPT_DEFECT_RECORDED',
    {
      defect_id: `defect-${events.length}`,
      severity: 'low',
      material: false,
      discovered_at: '2026-08-08T12:02:30.000Z',
      evidence_id: `evidence-${events.length}`,
      affected_revision: accepted.payload.accepted_revision,
      accepted_review_id: review.payload.review_id,
      category_code: 'correctness',
      ...overrides,
    },
    envelope,
  );
}

function insertExecutorUsage(events: readonly PilotEventV3[], payloadOverrides: Record<string, unknown> = {}): PilotEventV3[] {
  const completionIndex = events.findIndex((event) => event.event_type === 'EXECUTION_COMPLETED');
  const completion = events[completionIndex] as Extract<PilotEventV3, { event_type: 'EXECUTION_COMPLETED' }>;
  const usage = {
    ...completion,
    event_id: `${completion.block_id}-usage-matrix`,
    event_type: 'USAGE_RECORDED',
    payload: {
      usage_id: 'usage-matrix',
      attempt_number: 1,
      role: 'executor',
      binding_ref: completion.payload.executor_binding_ref,
      provider_usage_id: null,
      input_tokens_observed: 2,
      output_tokens_observed: 3,
      cached_input_tokens_observed: 0,
      reasoning_tokens_observed: 0,
      input_tokens_estimated: null,
      output_tokens_estimated: null,
      cached_input_tokens_estimated: null,
      reasoning_tokens_estimated: null,
      token_estimator_id: null,
      token_estimator_version: null,
      pricing_snapshot_id: 'pricing-v1',
      cost_observed: null,
      cost_estimated: null,
      currency: 'EUR',
      cost_provenance: 'TARIFF_REPRODUCED',
      attempt_id: completion.payload.attempt_id,
      review_id: null,
      orchestrator_operation_id: null,
      ...payloadOverrides,
    },
  } as PilotEventV3;
  return resequence([...events.slice(0, completionIndex + 1), usage, ...events.slice(completionIndex + 1)]);
}

test('reduces equivalent shuffled audit input into ordered deeply immutable canonical observations', () => {
  const frozen = manifest();
  const all = arms.flatMap((arm) => historyFor(frozen, arm, ['ACCEPT']));
  const ordered = reduceEvents(frozen, all);
  const shuffled = reduceEvents(frozen, [...all].reverse());
  assert.deepEqual(shuffled, ordered);
  assert.deepEqual(
    ordered.map((item) => item.block_id),
    [...ordered].map((item) => item.block_id).sort(),
  );
  assert.equal(Object.isFrozen(ordered), true);
  assert.equal(Object.isFrozen(ordered[0]), true);
  assert.equal(Object.isFrozen(ordered[0].strong_tokens_observed), true);
});

test('cross-block workspace reuse invalidates every affected observation during reduction', () => {
  const frozen = manifest();
  const a = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const b = historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['ACCEPT']);
  const workspace = (
    a.find((event) => event.event_type === 'ISOLATION_ATTESTED') as Extract<PilotEventV3, { event_type: 'ISOLATION_ATTESTED' }>
  ).payload.workspace_instance_id;
  const reused = b.map((event) =>
    event.event_type === 'ISOLATION_ATTESTED'
      ? ({ ...event, payload: { ...event.payload, workspace_instance_id: workspace } } as PilotEventV3)
      : event,
  );
  const affected = reduceEvents(frozen, [...a, ...reused]).filter(
    (observation) => observation.block_id === a[0].block_id || observation.block_id === b[0].block_id,
  );

  assert.deepEqual(
    affected.map((observation) => observation.final_outcome),
    ['INVALID', 'INVALID'],
  );
  assert.ok(affected.every((observation) => observation.invalid_reason_codes.includes('WORKSPACE_REUSED_ACROSS_BLOCKS')));
});

test('fails closed for invalid pricing and carries verified aggregate economics only', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const accepted = reduceHistory(frozen, withExecutorUsage(events));
  assert.deepEqual(
    [accepted.cost_observed, accepted.cost_observed_completeness, accepted.executor_usage, accepted.strong_tokens_observed.total],
    [5, 1, { operations: 1, observed_tokens: 5, estimated_tokens: null }, { value: 5, complete: 1, total: 1, completeness_ratio: 1 }],
  );
  const invalid = { ...frozen, pricing_snapshot: { ...frozen.pricing_snapshot, pricing_snapshot_hash: hash('9') } };
  assert.throws(() => reduceEvents(invalid, events), /pricing snapshot|manifest/i);
});

test('derives A/B/C bindings, repair outcomes, escalation, exact duration and validation endpoints', () => {
  const frozen = manifest();
  const a = reduceHistory(frozen, historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT'], { duration_ms: 1500 }));
  const b = reduceHistory(frozen, historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']));
  const c = reduceHistory(frozen, historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']));
  assert.deepEqual(
    [
      a.execution_attempts,
      a.repair_rounds,
      a.executor_binding_initial,
      a.executor_binding_final,
      a.first_pass_accept,
      a.accept_after_one_repair,
      a.executor_time_seconds,
      a.review_time_seconds,
      a.wall_time_seconds,
    ],
    [2, 1, 'binding-strong', 'binding-strong', false, true, 3, 0.02, 10],
  );
  assert.deepEqual([b.execution_attempts, b.repair_rounds, b.final_accepted], [3, 1, true]);
  assert.equal(c.valid_history, true, c.invalid_reason_codes.join(', '));
  assert.deepEqual(
    [c.execution_attempts, c.repair_rounds, c.escalated, c.escalation_reason, c.executor_binding_initial, c.executor_binding_final],
    [3, 1, true, 'second-review-rejected', 'binding-cheap', 'binding-strong'],
  );
  assert.deepEqual([a.tests_initially_failing, a.tests_finally_passing], [0, 4]);
});

test('keeps parent rework separate from execution attempts and sums file and line evidence', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const review = [...events].reverse().find((event) => event.event_type === 'REVIEW_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'REVIEW_COMPLETED' }
  >;
  const completion = [...events].reverse().find((event) => event.event_type === 'EXECUTION_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'EXECUTION_COMPLETED' }
  >;
  const observation = reduceEvents(frozen, [
    ...events,
    eventAfter(events, 'PARENT_REWORK_RECORDED', {
      review_id: review.payload.review_id,
      attempt_id: completion.payload.attempt_id,
      files_production: ['src-a', 'src-b'],
      files_tests: ['test-a'],
      files_docs: ['doc-a'],
      lines_production: 5,
      lines_tests: 7,
      lines_docs: 11,
      diff_hash: hash('7'),
      actor_role: 'human',
      reason_code: 'manual-fix',
    }),
  ])[0];
  assert.deepEqual(
    [
      observation.execution_attempts,
      observation.parent_rework_files,
      observation.parent_rework_lines_production,
      observation.parent_rework_lines_tests,
      observation.parent_rework_lines_docs,
      observation.changed_lines_production,
    ],
    [2, { production: 2, tests: 1, docs: 1 }, 5, 7, 11, 4],
  );
});

test('deduplicates parent rework paths while retaining exact line sums', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const review = [...events].reverse().find((event) => event.event_type === 'REVIEW_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'REVIEW_COMPLETED' }
  >;
  const completion = [...events].reverse().find((event) => event.event_type === 'EXECUTION_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'EXECUTION_COMPLETED' }
  >;
  const first = eventAfter(events, 'PARENT_REWORK_RECORDED', {
    review_id: review.payload.review_id,
    attempt_id: completion.payload.attempt_id,
    files_production: ['same-file'],
    files_tests: ['same-test'],
    files_docs: [],
    lines_production: 2,
    lines_tests: 3,
    lines_docs: 0,
    diff_hash: hash('7'),
    actor_role: 'human',
    reason_code: 'manual-fix',
  });
  const second = eventAfter([...events, first], 'PARENT_REWORK_RECORDED', {
    review_id: review.payload.review_id,
    attempt_id: completion.payload.attempt_id,
    files_production: ['same-file', 'other-file'],
    files_tests: ['same-test'],
    files_docs: ['doc-a'],
    lines_production: 5,
    lines_tests: 7,
    lines_docs: 11,
    diff_hash: hash('8'),
    actor_role: 'human',
    reason_code: 'manual-fix',
  });
  const observation = reduceHistory(frozen, [...events, first, second]);
  assert.deepEqual(
    [
      observation.parent_rework_files,
      observation.parent_rework_lines_production,
      observation.parent_rework_lines_tests,
      observation.parent_rework_lines_docs,
    ],
    [{ production: 2, tests: 1, docs: 1 }, 7, 10, 11],
  );
});

test('rejects unsafe frozen pricing and turns aggregation failures into invalid observations', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const unsafe = rehashManifest(frozen, { ...frozen.pricing_snapshot, unit_scale: Number.MAX_SAFE_INTEGER + 1 });
  assert.throws(() => reduceEvents(unsafe, events), /MANIFEST_OR_PRICING_INVALID/);
  const overflowing = withExecutorUsage(events).map((event) =>
    event.event_type === 'USAGE_RECORDED'
      ? ({
          ...event,
          payload: { ...event.payload, input_tokens_observed: Number.MAX_SAFE_INTEGER, output_tokens_observed: 1 },
        } as PilotEventV3)
      : event,
  );
  const observation = reduceHistory(frozen, overflowing);
  assert.deepEqual(
    [observation.final_outcome, observation.valid_history, observation.invalid_reason_codes.includes('USAGE_AGGREGATION_INVALID')],
    ['INVALID', false, true],
  );
});

test('contains duration overflow as affected-block invalidity while preserving route evidence', () => {
  const frozen = manifest();
  const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
  const overflowing = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT'], { duration_ms: huge });
  const invalid = reduceHistory(frozen, overflowing);
  assert.deepEqual(
    [invalid.final_outcome, invalid.valid_history, invalid.invalid_reason_codes.includes('SAFE_ARITHMETIC_INVALID')],
    ['INVALID', false, true],
  );
  assert.deepEqual(
    [invalid.execution_attempts, invalid.executor_binding_initial, invalid.executor_binding_final],
    [2, 'binding-strong', 'binding-strong'],
  );
});

test('preserves empty role economics as null without inventing zero-token evidence', () => {
  const frozen = manifest();
  const empty = reduceHistory(frozen, historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['ACCEPT']));
  assert.deepEqual(
    [empty.orchestrator_usage, empty.executor_usage, empty.reviewer_usage, empty.total_usage],
    [
      { operations: 0, observed_tokens: null, estimated_tokens: null },
      { operations: 0, observed_tokens: null, estimated_tokens: null },
      { operations: 0, observed_tokens: null, estimated_tokens: null },
      { operations: 0, observed_tokens: null, estimated_tokens: null },
    ],
  );
});

test('rejects a post-acceptance defect discovered before accepted_at instead of treating it as late telemetry', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const accepted = events.at(-1) as Extract<PilotEventV3, { event_type: 'BLOCK_ACCEPTED' }>;
  const defect = eventAfter(events, 'POST_ACCEPT_DEFECT_RECORDED', {
    defect_id: 'preaccept-defect',
    severity: 'low',
    material: false,
    discovered_at: '2026-08-08T12:01:59.000Z',
    evidence_id: 'preaccept-evidence',
    affected_revision: accepted.payload.accepted_revision,
    accepted_review_id: `${accepted.block_id}-review-1`,
    category_code: 'correctness',
  });
  const observation = reduceHistory(frozen, [...events, defect]);
  assert.deepEqual(
    [observation.final_outcome, observation.valid_history, observation.invalid_reason_codes.includes('QUALITY_TIMESTAMP_INVALID')],
    ['INVALID', false, true],
  );
});

test('rejects globally unresolved raw identities and invalid quality UTC calendar evidence', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  assert.throws(
    () => reduceEvents(frozen, [...events, { ...events[0], event_id: 'unknown-block', block_id: 'missing-block' } as PilotEventV3]),
    /RAW_EVENT_IDENTITY_INVALID/,
  );
  const accepted = events.at(-1) as Extract<PilotEventV3, { event_type: 'BLOCK_ACCEPTED' }>;
  const invalidDate = eventAfter(events, 'POST_ACCEPT_DEFECT_RECORDED', {
    defect_id: 'invalid-date',
    severity: 'low',
    material: false,
    discovered_at: '2026-02-30T12:00:00.000Z',
    evidence_id: 'evidence-invalid',
    affected_revision: accepted.payload.accepted_revision,
    accepted_review_id: `${accepted.block_id}-review-1`,
    category_code: 'correctness',
  });
  const observation = reduceHistory(frozen, [...events, invalidDate]);
  assert.deepEqual([observation.final_outcome, observation.valid_history], ['INVALID', false]);
});

test('uses accepted recorded-at watermark, discovered-at inclusive membership, and deterministic late-quality telemetry', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const accepted = events.at(-1)!;
  const defectPayload = {
    defect_id: 'defect-in',
    severity: 'high' as const,
    material: true,
    discovered_at: '2026-08-08T12:03:00.000Z',
    evidence_id: 'evidence-in',
    affected_revision: (accepted as Extract<PilotEventV3, { event_type: 'BLOCK_ACCEPTED' }>).payload.accepted_revision,
    accepted_review_id: 'block-a-review-1',
    category_code: 'correctness',
  };
  const inWindowLateRecorded = eventAfter(events, 'POST_ACCEPT_DEFECT_RECORDED', defectPayload, {
    recorded_at: '2026-08-08T12:04:00.000Z',
  });
  const watermark = eventAfter(
    [...events, inWindowLateRecorded],
    'POST_ACCEPT_DEFECT_RECORDED',
    { ...defectPayload, defect_id: 'defect-late', discovered_at: '2026-08-08T12:03:01.000Z', evidence_id: 'evidence-late' },
    { occurred_at: '2026-08-08T12:04:01.000Z', recorded_at: '2026-08-08T12:03:01.000Z' },
  );
  const closed = reduceEvents(frozen, [...events, inWindowLateRecorded, watermark])[0];
  assert.deepEqual(
    [
      closed.post_accept_defects_count,
      closed.post_accept_max_severity,
      closed.late_quality_evidence_count,
      closed.post_acceptance_window_closed,
      closed.quality_warnings,
    ],
    [1, 'high', 1, true, ['LATE_QUALITY_EVIDENCE']],
  );
});

test('includes a defect discovered exactly at the opening boundary', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const defect = defectAfter(events, { discovered_at: '2026-08-08T12:02:00.000Z' });
  const observation = reduceHistory(frozen, [...events, defect]);
  assert.deepEqual([observation.post_accept_defects_count, observation.late_quality_evidence_count], [1, 0]);
});

test('keeps the quality window open when the recorded watermark is below close plus skew', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).map((event) =>
    event.event_type === 'BLOCK_ACCEPTED' ? ({ ...event, recorded_at: '2026-08-08T12:03:00.999Z' } as PilotEventV3) : event,
  );
  assert.equal(reduceHistory(frozen, events).post_acceptance_window_closed, false);
});

test('closes the quality window at the exact nominal-close plus skew watermark', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).map((event) =>
    event.event_type === 'BLOCK_ACCEPTED' ? ({ ...event, recorded_at: '2026-08-08T12:03:01.000Z' } as PilotEventV3) : event,
  );
  assert.equal(reduceHistory(frozen, events).post_acceptance_window_closed, true);
});

test('does not widen defect membership by the allowed clock skew', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const defect = defectAfter(events, { discovered_at: '2026-08-08T12:03:00.500Z' });
  const observation = reduceHistory(frozen, [...events, defect]);
  assert.deepEqual(
    [observation.post_accept_defects_count, observation.late_quality_evidence_count, observation.quality_warnings],
    [0, 1, ['LATE_QUALITY_EVIDENCE']],
  );
});

test('terminal material policy closes early on an in-window material defect', () => {
  const base = manifest();
  const frozen = manifest({ post_acceptance_window: { ...base.post_acceptance_window, closure_rule: 'terminal_material_defect' } });
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const defect = defectAfter(
    events,
    { material: true, discovered_at: '2026-08-08T12:02:30.000Z' },
    { recorded_at: '2026-08-08T12:02:30.000Z' },
  );
  assert.equal(reduceHistory(frozen, [...events, defect]).post_acceptance_window_closed, true);
});

test('terminal material policy also closes through elapsed watermark evidence', () => {
  const base = manifest();
  const frozen = manifest({ post_acceptance_window: { ...base.post_acceptance_window, closure_rule: 'terminal_material_defect' } });
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).map((event) =>
    event.event_type === 'BLOCK_ACCEPTED' ? ({ ...event, recorded_at: '2026-08-08T12:03:01.000Z' } as PilotEventV3) : event,
  );
  assert.equal(reduceHistory(frozen, events).post_acceptance_window_closed, true);
});

test('counts late-recorded in-window evidence by discovered_at and closes from its watermark', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const defect = defectAfter(events, { discovered_at: '2026-08-08T12:02:30.000Z' }, { recorded_at: '2026-08-08T12:03:01.000Z' });
  const observation = reduceHistory(frozen, [...events, defect]);
  assert.deepEqual(
    [observation.post_accept_defects_count, observation.late_quality_evidence_count, observation.post_acceptance_window_closed],
    [1, 0, true],
  );
});

test('retains low, medium, high, and critical in-window defects independently', () => {
  const frozen = manifest();
  let events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  for (const [index, severity] of (['low', 'medium', 'high', 'critical'] as const).entries()) {
    events = [
      ...events,
      defectAfter(events, {
        defect_id: `severity-${severity}`,
        evidence_id: `severity-evidence-${severity}`,
        severity,
        material: severity !== 'low',
        discovered_at: `2026-08-08T12:02:${String(10 + index).padStart(2, '0')}.000Z`,
      }),
    ];
  }
  const observation = reduceHistory(frozen, events);
  assert.deepEqual(
    observation.post_accept_defects.map((defect) => defect.severity),
    ['low', 'medium', 'high', 'critical'],
  );
  assert.deepEqual([observation.post_accept_defects_count, observation.post_accept_max_severity], [4, 'critical']);
});

test('uses earliest failing and latest passing validation counts without summing runs', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']).map((event) => {
    if (event.event_type !== 'VALIDATION_RECORDED') return event;
    return event.payload.validation_id.endsWith('-1')
      ? ({ ...event, payload: { ...event.payload, passed: false, tests_failing: 7, tests_passing: 2 } } as PilotEventV3)
      : ({ ...event, payload: { ...event.payload, passed: true, tests_failing: 0, tests_passing: 13 } } as PilotEventV3);
  });
  assert.deepEqual([reduceHistory(frozen, events).tests_initially_failing, reduceHistory(frozen, events).tests_finally_passing], [7, 13]);
});

test('derives first-pass acceptance independently', () => {
  const observation = reduceHistory(manifest(), historyFor(manifest(), 'A_STRONG_BASELINE', ['ACCEPT']));
  assert.deepEqual([observation.execution_attempts, observation.first_pass_accept, observation.accept_after_one_repair], [1, true, true]);
});

test('derives cumulative acceptance after exactly one repair independently', () => {
  const frozen = manifest();
  const observation = reduceHistory(frozen, historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['REJECT', 'ACCEPT']));
  assert.deepEqual(
    [observation.execution_attempts, observation.repair_rounds, observation.first_pass_accept, observation.accept_after_one_repair],
    [2, 1, false, true],
  );
});

test('keeps third-attempt acceptance outside the one-repair cumulative metric', () => {
  const frozen = manifest();
  const observation = reduceHistory(frozen, historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']));
  assert.deepEqual([observation.execution_attempts, observation.first_pass_accept, observation.accept_after_one_repair], [3, false, false]);
});

test('keeps invalid, blocked, failed, and open accepted observations visible and schema-valid', () => {
  const frozen = manifest();
  const accepted = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const blockedBase = historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', []);
  const blocked = [
    ...blockedBase,
    eventAfter(blockedBase, 'BLOCK_BLOCKED', { cause: 'EXTERNAL', reason_code: 'dependency', evidence_hash: hash('8') }),
  ];
  const failed = historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'REJECT']);
  const invalid = [{ ...accepted[0], event_id: 'invalid-event', sequence_number: 99 } as PilotEventV3];
  assert.equal(reduceEvents(frozen, accepted).find((item) => item.block_id === accepted[0].block_id)!.final_outcome, 'ACCEPTED');
  assert.equal(reduceEvents(frozen, blocked).find((item) => item.block_id === blocked[0].block_id)!.final_outcome, 'BLOCKED');
  assert.deepEqual(reduceHistory(frozen, blocked).blocked_cause, 'EXTERNAL');
  assert.deepEqual(reduceHistory(frozen, blocked).blocked_reason_code, 'dependency');
  assert.equal(reduceEvents(frozen, failed).find((item) => item.block_id === failed[0].block_id)!.final_outcome, 'FAILED');
  const open = reduceEvents(frozen, accepted).find((item) => item.block_id === accepted[0].block_id)!;
  assert.equal(open.post_acceptance_window_closed, false);
  assert.equal(reduceEvents(frozen, invalid).find((item) => item.block_id === invalid[0].block_id)!.final_outcome, 'INVALID');
});

test('reduces an unassigned direct-to-strong block with a null arm through the strong three-attempt path', () => {
  const baseline = manifest();
  const direct = {
    ...baseline.blocks[0],
    block_id: 'direct-strong',
    pair_or_triplet_id: 'direct-only',
    cheap_eligible: false as const,
    comparative_eligible: false as const,
    selected_executor_capability_initial: 'strong' as const,
    selected_executor_capability_final_expected: 'strong' as const,
    exclusion_reason: 'direct-to-strong',
  };
  const frozen = manifest({ blocks: [...baseline.blocks, direct] });
  const events = historyFor(frozen, null, ['REJECT', 'REJECT', 'ACCEPT']);
  const replay = replayBlock(frozen, events);
  const observation = reduceHistory(frozen, events);
  assert.deepEqual([replay.valid_history, replay.state], [true, 'ACCEPTED']);
  assert.deepEqual(
    [
      observation.pilot_arm,
      observation.valid_history,
      observation.execution_attempts,
      observation.repair_rounds,
      observation.escalated,
      observation.executor_binding_initial,
      observation.executor_binding_final,
      observation.final_outcome,
    ],
    [null, true, 3, 1, false, 'binding-strong', 'binding-strong', 'ACCEPTED'],
  );
});

test('rejects a non-null arm on direct descriptive telemetry', () => {
  const frozen = directManifest();
  const events = historyFor(frozen, null, ['ACCEPT']).map((event) => ({ ...event, pilot_arm: 'A_STRONG_BASELINE' }) as PilotEventV3);
  assert.throws(() => reduceEvents(frozen, events), /RAW_EVENT_IDENTITY_INVALID/);
});

test('rejects cheap executor capability on a direct-to-strong attempt', () => {
  const frozen = directManifest();
  const events = historyFor(frozen, null, ['ACCEPT']).map((event) =>
    event.event_type === 'EXECUTION_STARTED' || event.event_type === 'EXECUTION_COMPLETED'
      ? ({ ...event, payload: { ...event.payload, executor_capability: 'cheap', executor_binding_ref: 'binding-cheap' } } as PilotEventV3)
      : event,
  );
  const observation = reduceHistory(frozen, events);
  assert.deepEqual([observation.final_outcome, observation.valid_history], ['INVALID', false]);
});

test('rejects escalation evidence on the direct non-C third-attempt path', () => {
  const frozen = directManifest();
  const valid = historyFor(frozen, null, ['REJECT', 'REJECT', 'ACCEPT']);
  const thirdStart = valid.findIndex((event) => event.event_type === 'EXECUTION_STARTED' && event.payload.attempt_number === 3);
  const priorReview = valid
    .slice(0, thirdStart)
    .reverse()
    .find((event) => event.event_type === 'REVIEW_COMPLETED')!;
  const escalation = {
    ...priorReview,
    event_id: 'direct-escalation',
    event_type: 'ESCALATION_DECIDED',
    payload: {
      rejected_review_event_id: priorReview.event_id,
      escalation_reason: 'forbidden-direct-escalation',
      target_binding_ref: 'binding-strong',
      target_capability: 'strong',
      decision_policy_version: frozen.routing_policy_version,
    },
  } as PilotEventV3;
  const observation = reduceHistory(frozen, resequence([...valid.slice(0, thirdStart), escalation, ...valid.slice(thirdStart)]));
  assert.deepEqual([observation.final_outcome, observation.valid_history], ['INVALID', false]);
});

test('preserves incomplete observed and complete estimated strong-token aggregates independently', () => {
  const frozen = manifest();
  const events = insertExecutorUsage(historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']), {
    output_tokens_observed: null,
    input_tokens_estimated: 4,
    output_tokens_estimated: 5,
    cached_input_tokens_estimated: 0,
    reasoning_tokens_estimated: 1,
    token_estimator_id: 'estimator-v1',
    token_estimator_version: 'v1',
  });
  const observation = reduceHistory(frozen, events);
  assert.deepEqual(
    [
      observation.cost_observed,
      observation.cost_observed_completeness,
      observation.cost_estimated,
      observation.cost_estimated_completeness,
    ],
    [null, 0, 9, 1],
  );
  assert.deepEqual(observation.strong_tokens_observed.total, { value: null, complete: 0, total: 1, completeness_ratio: 0 });
  assert.deepEqual(observation.strong_tokens_estimated.total, { value: 10, complete: 1, total: 1, completeness_ratio: 1 });
});

test('rejects an unsafe tariff integer before reduction even without usage', () => {
  const frozen = manifest();
  const tariffs = frozen.pricing_snapshot.tariffs.map((tariff, index) =>
    index === 0 ? { ...tariff, input_token_micro_units_per_token: Number.MAX_SAFE_INTEGER + 1 } : tariff,
  );
  const unsafe = rehashManifest(frozen, { ...frozen.pricing_snapshot, tariffs });
  assert.throws(() => reduceEvents(unsafe, historyFor(unsafe, 'A_STRONG_BASELINE', ['ACCEPT'])), /MANIFEST_OR_PRICING_INVALID/);
});

test('rejects a frozen snapshot missing a registered binding tariff before reduction', () => {
  const frozen = manifest();
  const missing = rehashManifest(frozen, {
    ...frozen.pricing_snapshot,
    tariffs: frozen.pricing_snapshot.tariffs.filter((tariff) => tariff.binding_ref !== 'binding-strong'),
  });
  assert.throws(() => reduceEvents(missing, historyFor(missing, 'A_STRONG_BASELINE', ['ACCEPT'])), /MANIFEST_OR_PRICING_INVALID/);
});

test('dependency-orders supersession references under permutation and fails the projected gap closed', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const accepted = events.at(-1)!;
  const correcting = {
    ...accepted,
    event_id: 'accepted-correction',
    sequence_number: accepted.sequence_number + 1,
    supersedes_event_id: accepted.event_id,
    expected_superseded_event_content_hash: hashCanonical(accepted),
  } as PilotEventV3;
  const forward = reduceHistory(frozen, [...events, correcting]);
  const reversed = reduceHistory(frozen, [correcting, ...events].reverse());
  assert.deepEqual(
    [forward.final_outcome, reversed.final_outcome, forward.invalid_reason_codes, reversed.invalid_reason_codes],
    ['INVALID', 'INVALID', forward.invalid_reason_codes, forward.invalid_reason_codes],
  );
});

test('dependency-orders invalidation references under permutation and fails a removed predecessor closed', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const validation = events.find((event) => event.event_type === 'VALIDATION_RECORDED')!;
  const last = events.at(-1)!;
  const invalidation = {
    ...last,
    event_id: 'validation-invalidation',
    event_type: 'EVENT_INVALIDATED',
    sequence_number: last.sequence_number + 1,
    payload: {
      invalidated_event_id: validation.event_id,
      expected_event_content_hash: hashCanonical(validation),
      reason_code: 'bad-validation',
    },
  } as PilotEventV3;
  const forward = reduceHistory(frozen, [...events, invalidation]);
  const reversed = reduceHistory(frozen, [invalidation, ...events].reverse());
  assert.deepEqual(
    [forward.final_outcome, reversed.final_outcome, forward.invalid_reason_codes, reversed.invalid_reason_codes],
    ['INVALID', 'INVALID', forward.invalid_reason_codes, forward.invalid_reason_codes],
  );
});

test('rethrows observation schema errors instead of relabeling them as safe arithmetic', () => {
  const frozen = manifest();
  let events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  for (let index = 0; index < 129; index += 1)
    events = [
      ...events,
      defectAfter(events, {
        defect_id: `overflow-defect-${index}`,
        evidence_id: `overflow-evidence-${index}`,
        discovered_at: '2026-08-08T12:02:30.000Z',
      }),
    ];
  assert.throws(() => reduceHistory(frozen, events), /128|array|too_big/i);
});
