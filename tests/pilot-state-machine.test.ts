import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonical } from '../src/pilot/canonical-json.js';
import type { PilotEventV3, PilotManifestV3 } from '../src/pilot/contracts.js';
import { assignArms, freezeManifest, type PilotManifestInputV3 } from '../src/pilot/manifest.js';
import { replayBlock, transition, type PilotBlockStateV3 } from '../src/pilot/state-machine.js';

const hash = (character: string) => character.repeat(64);
const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;
type Arm = (typeof arms)[number];
type Decision = 'ACCEPT' | 'REJECT';

function block(id: string): PilotManifestV3['blocks'][number] {
  return {
    block_id: id,
    task_id: 'task-v3',
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: 'triplet-v3',
    case_fingerprint: hash('a'),
    contract_hash: hash('b'),
    base_revision: hash('c'),
    clean_tree_hash: hash('d'),
    fixtures_hash: hash('e'),
    complexity_class: 'mechanical',
    risk_class: 'low',
    changed_line_band: '1-25',
    validation_surface: ['test'],
    cheap_eligible: true,
    comparative_eligible: true,
    routing_selection_reason: 'preclassified',
    selected_executor_capability_initial: 'cheap',
    selected_executor_capability_final_expected: 'strong',
    exclusion_reason: null,
  };
}

function manifest(): PilotManifestV3 {
  const input: PilotManifestInputV3 = {
    pilot_id: 'pilot-v3',
    pilot_schema_version: 3,
    created_at: '2026-08-08T12:00:00.000Z',
    blocks: [block('block-a'), block('block-b'), block('block-c')],
    assignment_seed: 'seed-v3',
    assignment_algorithm_version: 'stratified-v1',
    binding_policy_version: 'binding-policy-v1',
    binding_registry: [
      { binding_ref: 'binding-cheap', capability_class: 'cheap', profile_hash: hash('f') },
      { binding_ref: 'binding-strong', capability_class: 'strong', profile_hash: hash('0') },
      { binding_ref: 'binding-strong-alt', capability_class: 'strong', profile_hash: hash('5') },
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
        {
          binding_ref: 'binding-strong-alt',
          input_token_micro_units_per_token: 1,
          output_token_micro_units_per_token: 1,
          cached_input_token_micro_units_per_token: null,
          reasoning_token_micro_units_per_token: null,
          authoritative_charge_supported: false,
        },
      ],
    },
  };
  const assignedArmByBlock = new Map(assignArms(input).map((assignment) => [assignment.block_id, assignment.pilot_arm]));
  input.blocks = input.blocks.map((candidate) => {
    const arm = assignedArmByBlock.get(candidate.block_id)!;
    return {
      ...candidate,
      selected_executor_capability_initial: arm === 'A_STRONG_BASELINE' ? 'strong' : 'cheap',
      selected_executor_capability_final_expected: arm === 'B_CHEAP_NO_EARLY_ESCALATION' ? 'cheap' : 'strong',
    };
  });
  return freezeManifest(input);
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

function historyFor(pilotManifest: PilotManifestV3, arm: Arm, decisions: readonly Decision[]): PilotEventV3[] {
  const assignment = pilotManifest.arm_assignments.find((candidate) => candidate.pilot_arm === arm)!;
  const frozenBlock = pilotManifest.blocks.find((candidate) => candidate.block_id === assignment.block_id)!;
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
  push('ARM_ASSIGNED', { assigned_arm: arm, assignment_algorithm_version: pilotManifest.assignment_algorithm_version });
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
    if (round === 3 && arm === 'C_ADAPTIVE_EARLY_ESCALATION') {
      push('ESCALATION_DECIDED', {
        rejected_review_event_id: `${frozenBlock.block_id}-event-${events.length}`,
        escalation_reason: 'second-review-rejected',
        target_binding_ref: 'binding-strong',
        target_capability: 'strong',
        decision_policy_version: pilotManifest.routing_policy_version,
      });
    }
    const attemptId = `${frozenBlock.block_id}-attempt-${round}`;
    const reviewId = `${frozenBlock.block_id}-review-${round}`;
    const capability = arm === 'A_STRONG_BASELINE' || (arm === 'C_ADAPTIVE_EARLY_ESCALATION' && round === 3) ? 'strong' : 'cheap';
    const binding = capability === 'strong' ? 'binding-strong' : 'binding-cheap';
    const kind = round === 1 ? 'IMPLEMENTATION' : round === 2 ? 'REPAIR_1' : 'FINAL_EXECUTION';
    const executorSession = `${frozenBlock.block_id}-executor-${round}`;
    const outputRevision = hash(String(3 + round));
    const outputTreeHash = hash(String(6 + round));
    const start = round * 100;
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
      changed_lines_production: 1,
      changed_lines_tests: 1,
      changed_lines_docs: 0,
      outcome: 'COMPLETED',
      started_monotonic_ms: start,
      finished_monotonic_ms: start + 10,
      duration_ms: 10,
    });
    const validationHash = hash(String(round));
    push('VALIDATION_RECORDED', {
      validation_id: `${frozenBlock.block_id}-validation-${round}`,
      attempt_id: attemptId,
      validation_surface: ['test'],
      passed: true,
      tests_failing: 0,
      tests_passing: 1,
      evidence_hashes: [validationHash],
    });
    push('REVIEW_STARTED', {
      review_id: reviewId,
      review_round: round,
      reviewer_binding_ref: pilotManifest.routing_reviewer_binding_ref,
      reviewer_session_id: `${frozenBlock.block_id}-reviewer-${round}`,
      reviewed_attempt_id: attemptId,
      executor_session_id_reviewed: executorSession,
      started_monotonic_ms: start + 20,
    });
    const decision = decisions[round - 1];
    const findings = [] as Array<{
      finding_id: string;
      severity: 'high';
      material: true;
      category_code: string;
      status: 'OPEN' | 'RESOLVED';
      evidence_hashes: string[];
    }>;
    if (unresolved.length > 0)
      findings.push(
        ...unresolved.map((finding_id) => ({
          finding_id,
          severity: 'high' as const,
          material: true as const,
          category_code: 'correctness',
          status: 'RESOLVED' as const,
          evidence_hashes: [hash('c')],
        })),
      );
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
        started_monotonic_ms: start + 20,
        finished_monotonic_ms: start + 30,
        duration_ms: 10,
      },
    } as Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }>;
    completion.payload.review_boundary_hash = boundaryHash(completion);
    events.push(completion);
    previousBoundaryHash = completion.payload.review_boundary_hash;
    inputRevision = outputRevision;
  }
  const lastReview = [...events].reverse().find((event) => event.event_type === 'REVIEW_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'REVIEW_COMPLETED' }
  >;
  const lastCompletion = [...events].reverse().find((event) => event.event_type === 'EXECUTION_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'EXECUTION_COMPLETED' }
  >;
  if (decisions.at(-1) === 'ACCEPT')
    push('BLOCK_ACCEPTED', {
      accepted_revision: lastCompletion.payload.output_revision,
      accepted_tree_hash: lastCompletion.payload.output_tree_hash,
      accepted_at: '2026-08-08T12:02:00.000Z',
    });
  else if (decisions.length === 3) push('BLOCK_FAILED', { reason_code: 'final-review-rejected', evidence_hash: hash('f') });
  void lastReview;
  return events;
}

function mutate<K extends PilotEventV3['event_type']>(
  events: readonly PilotEventV3[],
  type: K,
  change: (event: Extract<PilotEventV3, { event_type: K }>) => PilotEventV3,
): PilotEventV3[] {
  let changed = false;
  return events.map((event) => {
    if (!changed && event.event_type === type) {
      changed = true;
      return change(event as Extract<PilotEventV3, { event_type: K }>);
    }
    return event;
  });
}

function renumber(events: readonly PilotEventV3[]): PilotEventV3[] {
  return events.map(
    (event, index) =>
      ({
        ...event,
        sequence_number: index + 1,
        occurred_at: `2026-08-08T12:00:${String(index + 1).padStart(2, '0')}.000Z`,
        recorded_at: `2026-08-08T12:01:${String(index + 1).padStart(2, '0')}.000Z`,
      }) as PilotEventV3,
  );
}

function usageFrom(
  owner: PilotEventV3,
  id: string,
  ownership: { attempt_id: string | null; review_id: string | null; role: 'executor' | 'reviewer'; binding_ref: string },
): PilotEventV3 {
  return {
    ...owner,
    event_id: `${owner.block_id}-${id}`,
    event_type: 'USAGE_RECORDED',
    payload: {
      usage_id: id,
      attempt_number: 1,
      role: ownership.role,
      binding_ref: ownership.binding_ref,
      provider_usage_id: null,
      input_tokens_observed: null,
      output_tokens_observed: null,
      cached_input_tokens_observed: null,
      reasoning_tokens_observed: null,
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
      attempt_id: ownership.attempt_id,
      review_id: ownership.review_id,
      orchestrator_operation_id: null,
    },
  } as PilotEventV3;
}

function orchestratorOperationFrom(owner: PilotEventV3, id: string, overrides: Record<string, unknown> = {}): PilotEventV3 {
  return {
    ...owner,
    event_id: `${owner.block_id}-${id}`,
    event_type: 'ORCHESTRATOR_OPERATION_RECORDED',
    payload: {
      orchestrator_operation_id: id,
      attempt_number: 1,
      binding_ref: 'binding-strong',
      evidence_hash: hash('8'),
      ...overrides,
    },
  } as PilotEventV3;
}

function orchestratorUsageFrom(
  owner: PilotEventV3,
  id: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
): PilotEventV3 {
  return {
    ...owner,
    event_id: `${owner.block_id}-${id}`,
    event_type: 'USAGE_RECORDED',
    payload: {
      usage_id: id,
      attempt_number: 1,
      role: 'orchestrator',
      binding_ref: 'binding-strong',
      provider_usage_id: null,
      input_tokens_observed: null,
      output_tokens_observed: null,
      cached_input_tokens_observed: null,
      reasoning_tokens_observed: null,
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
      attempt_id: null,
      review_id: null,
      orchestrator_operation_id: operationId,
      ...overrides,
    },
  } as PilotEventV3;
}

test('every normative transition row executes for A, B, and C, including terminal accept/fail paths', () => {
  const frozen = manifest();
  for (const arm of arms) {
    for (const decisions of [['ACCEPT'], ['REJECT', 'ACCEPT'], ['REJECT', 'REJECT', 'ACCEPT'], ['REJECT', 'REJECT', 'REJECT']] as const) {
      const events = historyFor(frozen, arm, decisions);
      let state: PilotBlockStateV3 | null = null;
      for (const event of events) state = transition(state, event, frozen);
      const expected = decisions.at(-1) === 'ACCEPT' ? 'ACCEPTED' : decisions.length === 3 ? 'FAILED' : state;
      assert.equal(state, expected, `${arm}: ${decisions.join('/')}`);
      assert.equal(replayBlock(frozen, events).state, expected, `${arm}: replay ${decisions.join('/')}`);
    }
  }
});

test('BLOCKED is terminal, visible, and distinct from FAILED and INVALID', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 3);
  const prior = events.at(-1)!;
  events.push({
    ...prior,
    event_id: `${prior.block_id}-blocked`,
    event_type: 'BLOCK_BLOCKED',
    sequence_number: 4,
    occurred_at: '2026-08-08T12:00:04.000Z',
    payload: { cause: 'ENVIRONMENTAL', reason_code: 'runner-unavailable', evidence_hash: hash('4') },
  } as PilotEventV3);
  const result = replayBlock(frozen, events);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.valid_history, true);
  assert.notEqual(result.state, 'FAILED');
  assert.notEqual(result.state, 'INVALID');
});

test('replay fail-closes every transition guard and evidence ownership mutation', () => {
  const frozen = manifest();
  const valid = historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']);
  const cases: Array<[string, PilotEventV3[]]> = [
    ['wrong manifest hash', mutate(valid, 'BLOCK_PLANNED', (event) => ({ ...event, manifest_hash: hash('9') }) as PilotEventV3)],
    ['sequence gap', valid.map((event, index) => (index === 3 ? ({ ...event, sequence_number: 99 } as PilotEventV3) : event))],
    [
      'regressive occurred_at',
      valid.map((event, index) => (index === 4 ? ({ ...event, occurred_at: '2026-08-08T11:00:00.000Z' } as PilotEventV3) : event)),
    ],
    [
      'contaminated workspace',
      mutate(
        valid,
        'ISOLATION_ATTESTED',
        (event) =>
          ({ ...event, payload: { ...event.payload, isolation_status: 'CONTAMINATED', observed_tree_hash: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'clean baseline mismatch',
      mutate(
        valid,
        'ISOLATION_ATTESTED',
        (event) => ({ ...event, payload: { ...event.payload, clean_tree_hash: hash('9'), observed_tree_hash: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'wrong completion owner',
      mutate(
        valid,
        'EXECUTION_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, attempt_id: 'wrong-attempt' } }) as PilotEventV3,
      ),
    ],
    [
      'wrong input revision chain',
      mutate(
        valid,
        'EXECUTION_STARTED',
        (event) => ({ ...event, payload: { ...event.payload, input_revision: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'unreproduced tree',
      mutate(
        valid,
        'EXECUTION_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, tree_reproduced: false } }) as PilotEventV3,
      ),
    ],
    [
      'wrong tree algorithm',
      mutate(
        valid,
        'EXECUTION_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, canonical_tree_algorithm_version: 'wrong-v1' } }) as PilotEventV3,
      ),
    ],
    [
      'wrong volatile policy',
      mutate(
        valid,
        'EXECUTION_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, volatile_paths_policy_hash: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'reviewer equals executor',
      mutate(
        valid,
        'REVIEW_STARTED',
        (event) =>
          ({ ...event, payload: { ...event.payload, reviewer_session_id: event.payload.executor_session_id_reviewed } }) as PilotEventV3,
      ),
    ],
    [
      'wrong reviewer binding',
      mutate(
        valid,
        'REVIEW_STARTED',
        (event) => ({ ...event, payload: { ...event.payload, reviewer_binding_ref: 'binding-cheap' } }) as PilotEventV3,
      ),
    ],
    [
      'arbitrary attempt review',
      mutate(
        valid,
        'REVIEW_STARTED',
        (event) => ({ ...event, payload: { ...event.payload, reviewed_attempt_id: 'other-attempt' } }) as PilotEventV3,
      ),
    ],
    [
      'arbitrary executor session review',
      mutate(
        valid,
        'REVIEW_STARTED',
        (event) => ({ ...event, payload: { ...event.payload, executor_session_id_reviewed: 'other-session' } }) as PilotEventV3,
      ),
    ],
    [
      'wrong review completion',
      mutate(
        valid,
        'REVIEW_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, review_id: 'other-review' } }) as PilotEventV3,
      ),
    ],
    [
      'broken boundary hash',
      mutate(
        valid,
        'REVIEW_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, review_boundary_hash: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'wrong boundary from',
      mutate(
        valid,
        'REVIEW_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, review_boundary_from_revision: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'wrong boundary to',
      mutate(
        valid,
        'REVIEW_COMPLETED',
        (event) => ({ ...event, payload: { ...event.payload, review_boundary_to_revision: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'wrong previous boundary',
      valid.map((event) =>
        event.event_type === 'REVIEW_COMPLETED' && event.payload.review_round === 2
          ? ({ ...event, payload: { ...event.payload, previous_review_boundary_hash: hash('9') } } as PilotEventV3)
          : event,
      ),
    ],
    [
      'orphan validation',
      mutate(
        valid,
        'VALIDATION_RECORDED',
        (event) => ({ ...event, payload: { ...event.payload, attempt_id: 'orphan-attempt' } }) as PilotEventV3,
      ),
    ],
    [
      'passing validation with failing tests',
      mutate(
        valid,
        'VALIDATION_RECORDED',
        (event) => ({ ...event, payload: { ...event.payload, passed: true, tests_failing: 1 } }) as PilotEventV3,
      ),
    ],
    [
      'failed validation without failing tests',
      mutate(
        valid,
        'VALIDATION_RECORDED',
        (event) => ({ ...event, payload: { ...event.payload, passed: false, tests_failing: 0 } }) as PilotEventV3,
      ),
    ],
    [
      'orphan usage',
      mutate(
        valid,
        'VALIDATION_RECORDED',
        (event) =>
          ({
            ...event,
            event_type: 'USAGE_RECORDED',
            payload: {
              usage_id: 'usage-orphan',
              attempt_number: 1,
              role: 'executor',
              binding_ref: 'binding-cheap',
              provider_usage_id: null,
              input_tokens_observed: null,
              output_tokens_observed: null,
              cached_input_tokens_observed: null,
              reasoning_tokens_observed: null,
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
              attempt_id: 'orphan-attempt',
              review_id: null,
              orchestrator_operation_id: null,
            },
          }) as PilotEventV3,
      ),
    ],
    [
      'orphan rework',
      mutate(
        valid,
        'VALIDATION_RECORDED',
        (event) =>
          ({
            ...event,
            event_type: 'PARENT_REWORK_RECORDED',
            payload: {
              review_id: 'orphan-review',
              attempt_id: 'orphan-attempt',
              files_production: [],
              files_tests: [],
              files_docs: [],
              lines_production: 0,
              lines_tests: 0,
              lines_docs: 0,
              diff_hash: hash('8'),
              actor_role: 'human',
              reason_code: 'manual-fix',
            },
          }) as PilotEventV3,
      ),
    ],
    [
      'orphan finding resolution',
      valid.map((event) =>
        event.event_type === 'REVIEW_COMPLETED' && event.payload.review_round === 2
          ? ({
              ...event,
              payload: {
                ...event.payload,
                material_findings: event.payload.material_findings.map((finding) =>
                  finding.status === 'RESOLVED' ? { ...finding, finding_id: 'orphan-finding' } : finding,
                ),
              },
            } as PilotEventV3)
          : event,
      ),
    ],
    [
      'accepted revision mismatch',
      mutate(
        valid,
        'BLOCK_ACCEPTED',
        (event) => ({ ...event, payload: { ...event.payload, accepted_revision: hash('9') } }) as PilotEventV3,
      ),
    ],
    [
      'accepted tree mismatch',
      mutate(
        valid,
        'BLOCK_ACCEPTED',
        (event) => ({ ...event, payload: { ...event.payload, accepted_tree_hash: hash('5') } }) as PilotEventV3,
      ),
    ],
    [
      'conflicting terminal',
      [
        ...valid,
        {
          ...valid.at(-1)!,
          event_id: `${valid[0].block_id}-terminal-conflict`,
          event_type: 'BLOCK_FAILED',
          sequence_number: valid.length + 1,
          occurred_at: '2026-08-08T12:00:30.000Z',
          payload: { reason_code: 'conflict', evidence_hash: hash('9') },
        } as PilotEventV3,
      ],
    ],
    [
      'illegal event state pair',
      mutate(
        valid,
        'EXECUTION_STARTED',
        (event) =>
          ({ ...event, event_type: 'BLOCK_FAILED', payload: { reason_code: 'too-early', evidence_hash: hash('9') } }) as PilotEventV3,
      ),
    ],
  ];
  for (const [name, events] of cases) {
    const result = replayBlock(frozen, events);
    assert.equal(result.state, 'INVALID', name);
    assert.equal(result.valid_history, false, name);
    assert.ok(result.invalid_reason_codes.length > 0, name);
  }
});

test('arm ceilings reject strong rescue in B, cheap final execution in C, missing escalation, and a fourth execution', () => {
  const frozen = manifest();
  const b = historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']);
  const strongB = b.map((event) =>
    (event.event_type === 'EXECUTION_STARTED' || event.event_type === 'EXECUTION_COMPLETED') && event.payload.attempt_number === 3
      ? ({ ...event, payload: { ...event.payload, executor_capability: 'strong', executor_binding_ref: 'binding-strong' } } as PilotEventV3)
      : event,
  );
  const c = historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']);
  const cheapC = c.map((event) =>
    (event.event_type === 'EXECUTION_STARTED' || event.event_type === 'EXECUTION_COMPLETED') && event.payload.attempt_number === 3
      ? ({ ...event, payload: { ...event.payload, executor_capability: 'cheap', executor_binding_ref: 'binding-cheap' } } as PilotEventV3)
      : event,
  );
  const missingEscalation = c
    .filter((event) => event.event_type !== 'ESCALATION_DECIDED')
    .map((event, index) => ({ ...event, sequence_number: index + 1 }) as PilotEventV3);
  const fourth = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'REJECT', 'REJECT']);
  const terminal = fourth.pop()!;
  fourth.push({
    ...terminal,
    event_id: `${terminal.block_id}-attempt-four`,
    event_type: 'EXECUTION_STARTED',
    sequence_number: fourth.length + 1,
    payload: {
      attempt_id: 'attempt-4',
      attempt_number: 4,
      attempt_kind: 'FINAL_EXECUTION',
      executor_capability: 'strong',
      executor_binding_ref: 'binding-strong',
      executor_session_id: 'executor-4',
      input_revision: hash('6'),
      started_monotonic_ms: 400,
    },
  } as PilotEventV3);
  for (const [name, events] of [
    ['strong B', strongB],
    ['cheap C', cheapC],
    ['missing escalation', missingEscalation],
    ['fourth', fourth],
  ] as const)
    assert.equal(replayBlock(frozen, events).state, 'INVALID', name);
});

test('transition itself rejects an execution completion without the frozen reproducibility proof', () => {
  const frozen = manifest();
  const completion = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).find(
    (event) => event.event_type === 'EXECUTION_COMPLETED',
  ) as Extract<PilotEventV3, { event_type: 'EXECUTION_COMPLETED' }>;
  assert.equal(transition('EXECUTING_1', { ...completion, payload: { ...completion.payload, tree_reproduced: false } }, frozen), 'INVALID');
});

test('review boundaries retain unresolved findings and acceptance/defects bind the reviewed revision, tree, and review', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  assert.deepEqual(replayBlock(frozen, events).unresolved_finding_ids, []);
  const rejectedOnly = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT']);
  assert.deepEqual(replayBlock(frozen, rejectedOnly).unresolved_finding_ids, [rejectedOnly[0].block_id + '-finding-1']);
  const accepted = replayBlock(frozen, events);
  const last = events.at(-1)!;
  const defect = {
    ...last,
    event_id: `${last.block_id}-defect`,
    event_type: 'POST_ACCEPT_DEFECT_RECORDED',
    sequence_number: last.sequence_number + 1,
    occurred_at: '2026-08-08T12:00:20.000Z',
    payload: {
      defect_id: 'defect-1',
      severity: 'high',
      material: true,
      discovered_at: '2026-08-08T12:03:00.000Z',
      evidence_id: 'evidence-1',
      affected_revision: accepted.accepted_revision,
      accepted_review_id: accepted.accepted_review_id,
      category_code: 'correctness',
    },
  } as PilotEventV3;
  assert.equal(replayBlock(frozen, [...events, defect]).state, 'ACCEPTED');
  for (const payload of [
    { ...defect.payload, affected_revision: hash('9') },
    { ...defect.payload, accepted_review_id: 'wrong-review' },
  ])
    assert.equal(replayBlock(frozen, [...events, { ...defect, payload } as PilotEventV3]).state, 'INVALID');
});

test('workspace IDs are unique across blocks and arms', () => {
  const frozen = manifest();
  const a = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const b = historyFor(frozen, 'B_CHEAP_NO_EARLY_ESCALATION', ['ACCEPT']);
  const aWorkspace = (
    a.find((event) => event.event_type === 'ISOLATION_ATTESTED') as Extract<PilotEventV3, { event_type: 'ISOLATION_ATTESTED' }>
  ).payload.workspace_instance_id;
  const reused = mutate(
    b,
    'ISOLATION_ATTESTED',
    (event) => ({ ...event, payload: { ...event.payload, workspace_instance_id: aWorkspace } }) as PilotEventV3,
  );
  assert.equal(replayBlock(frozen, [...a, ...reused]).state, 'INVALID');
});

test('later contamination and an invalidation that removes a required predecessor fail closed through activeEvents', () => {
  const frozen = manifest();
  const clean = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const isolation = clean.find((event) => event.event_type === 'ISOLATION_ATTESTED') as Extract<
    PilotEventV3,
    { event_type: 'ISOLATION_ATTESTED' }
  >;
  const tail = clean.at(-1)!;
  const contamination = {
    ...isolation,
    event_id: `${isolation.block_id}-contamination`,
    sequence_number: clean.length + 1,
    occurred_at: '2026-08-08T12:00:20.000Z',
    payload: { ...isolation.payload, isolation_status: 'CONTAMINATED', observed_tree_hash: hash('9'), evidence_hash: hash('8') },
  } as PilotEventV3;
  assert.equal(replayBlock(frozen, [...clean, contamination]).state, 'INVALID');
  const invalidation = {
    ...tail,
    event_id: `${tail.block_id}-invalidation`,
    event_type: 'EVENT_INVALIDATED',
    sequence_number: clean.length + 1,
    occurred_at: '2026-08-08T12:00:20.000Z',
    payload: {
      invalidated_event_id: isolation.event_id,
      expected_event_content_hash: hashCanonical(isolation),
      reason_code: 'bad-attestation',
    },
  } as PilotEventV3;
  assert.equal(replayBlock(frozen, [...clean, invalidation]).state, 'INVALID');
});

test('attempt and review evidence is rejected outside its explicit ownership window', () => {
  const frozen = manifest();
  const firstRound = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT']);
  const validation = firstRound.find((event) => event.event_type === 'VALIDATION_RECORDED')!;
  const reviewCompletion = firstRound.find((event) => event.event_type === 'REVIEW_COMPLETED') as Extract<
    PilotEventV3,
    { event_type: 'REVIEW_COMPLETED' }
  >;
  const completionWithoutValidation = {
    ...reviewCompletion,
    payload: { ...reviewCompletion.payload, validation_evidence_hashes: [], review_boundary_hash: hash('0') },
  } as Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }>;
  completionWithoutValidation.payload.review_boundary_hash = boundaryHash(completionWithoutValidation);
  const withoutValidation = firstRound
    .map((event) => (event.event_id === reviewCompletion.event_id ? completionWithoutValidation : event))
    .filter((event) => event.event_id !== validation.event_id);
  const lateValidation = renumber([...withoutValidation, validation]);
  const lateAttemptUsage = renumber([
    ...firstRound,
    usageFrom(firstRound.at(-1)!, 'usage-attempt-late', {
      attempt_id: `${firstRound[0].block_id}-attempt-1`,
      review_id: null,
      role: 'executor',
      binding_ref: 'binding-strong',
    }),
  ]);

  const twoRounds = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const secondStartIndex = twoRounds.findIndex((event) => event.event_type === 'EXECUTION_STARTED' && event.payload.attempt_number === 2);
  const lateReviewUsage = usageFrom(twoRounds[secondStartIndex], 'usage-review-late', {
    attempt_id: null,
    review_id: `${twoRounds[0].block_id}-review-1`,
    role: 'reviewer',
    binding_ref: 'binding-strong',
  });
  const lateRework = {
    ...twoRounds[secondStartIndex],
    event_id: `${twoRounds[0].block_id}-rework-late`,
    event_type: 'PARENT_REWORK_RECORDED',
    payload: {
      review_id: `${twoRounds[0].block_id}-review-1`,
      attempt_id: `${twoRounds[0].block_id}-attempt-1`,
      files_production: [],
      files_tests: [],
      files_docs: [],
      lines_production: 0,
      lines_tests: 0,
      lines_docs: 0,
      diff_hash: hash('8'),
      actor_role: 'human',
      reason_code: 'manual-fix',
    },
  } as PilotEventV3;
  const histories = [
    ['late validation', lateValidation],
    ['late attempt usage', lateAttemptUsage],
    [
      'late review usage',
      renumber([...twoRounds.slice(0, secondStartIndex + 1), lateReviewUsage, ...twoRounds.slice(secondStartIndex + 1)]),
    ],
    ['late parent rework', renumber([...twoRounds.slice(0, secondStartIndex + 1), lateRework, ...twoRounds.slice(secondStartIndex + 1)])],
  ] as const;
  for (const [name, events] of histories) assert.equal(replayBlock(frozen, events).state, 'INVALID', name);
});

test('attempt usage, review usage, and parent rework remain legal inside their explicit windows', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const reviewStartIndex = events.findIndex((event) => event.event_type === 'REVIEW_STARTED' && event.payload.review_round === 1);
  const secondStartIndex = events.findIndex((event) => event.event_type === 'EXECUTION_STARTED' && event.payload.attempt_number === 2);
  const attemptUsage = usageFrom(events[reviewStartIndex], 'usage-attempt-in-window', {
    attempt_id: `${events[0].block_id}-attempt-1`,
    review_id: null,
    role: 'executor',
    binding_ref: 'binding-strong',
  });
  const reviewUsage = usageFrom(events[secondStartIndex], 'usage-review-in-window', {
    attempt_id: null,
    review_id: `${events[0].block_id}-review-1`,
    role: 'reviewer',
    binding_ref: 'binding-strong',
  });
  const rework = {
    ...events[secondStartIndex],
    event_id: `${events[0].block_id}-rework-in-window`,
    event_type: 'PARENT_REWORK_RECORDED',
    payload: {
      review_id: `${events[0].block_id}-review-1`,
      attempt_id: `${events[0].block_id}-attempt-1`,
      files_production: [],
      files_tests: [],
      files_docs: [],
      lines_production: 0,
      lines_tests: 0,
      lines_docs: 0,
      diff_hash: hash('8'),
      actor_role: 'human',
      reason_code: 'manual-fix',
    },
  } as PilotEventV3;
  const withAttemptUsage = [...events.slice(0, reviewStartIndex), attemptUsage, ...events.slice(reviewStartIndex)];
  const shiftedSecondStart = withAttemptUsage.findIndex(
    (event) => event.event_type === 'EXECUTION_STARTED' && event.payload.attempt_number === 2,
  );
  const inWindow = renumber([
    ...withAttemptUsage.slice(0, shiftedSecondStart),
    reviewUsage,
    rework,
    ...withAttemptUsage.slice(shiftedSecondStart),
  ]);
  assert.equal(replayBlock(frozen, inWindow).state, 'ACCEPTED');
});

test('attempt and review usage reject misattributed role, binding, and attempt number inside valid owner windows', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const reviewStartIndex = events.findIndex((event) => event.event_type === 'REVIEW_STARTED' && event.payload.review_round === 1);
  const secondStartIndex = events.findIndex((event) => event.event_type === 'EXECUTION_STARTED' && event.payload.attempt_number === 2);
  const attemptUsage = usageFrom(events[reviewStartIndex], 'usage-attempt-owner', {
    attempt_id: `${events[0].block_id}-attempt-1`,
    review_id: null,
    role: 'executor',
    binding_ref: 'binding-strong',
  });
  const reviewUsage = usageFrom(events[secondStartIndex], 'usage-review-owner', {
    attempt_id: null,
    review_id: `${events[0].block_id}-review-1`,
    role: 'reviewer',
    binding_ref: 'binding-strong',
  });
  const insertAttempt = (usage: PilotEventV3) => renumber([...events.slice(0, reviewStartIndex), usage, ...events.slice(reviewStartIndex)]);
  const insertReview = (usage: PilotEventV3) => renumber([...events.slice(0, secondStartIndex), usage, ...events.slice(secondStartIndex)]);
  const withPayload = (usage: PilotEventV3, mutation: Record<string, unknown>) =>
    ({ ...usage, payload: { ...usage.payload, ...mutation } }) as PilotEventV3;
  const cases: Array<[string, PilotEventV3[]]> = [
    ['attempt wrong role', insertAttempt(withPayload(attemptUsage, { role: 'reviewer' }))],
    ['attempt wrong binding', insertAttempt(withPayload(attemptUsage, { binding_ref: 'binding-cheap' }))],
    ['attempt wrong number', insertAttempt(withPayload(attemptUsage, { attempt_number: 2 }))],
    ['review wrong role', insertReview(withPayload(reviewUsage, { role: 'executor' }))],
    ['review wrong binding', insertReview(withPayload(reviewUsage, { binding_ref: 'binding-cheap' }))],
    ['review wrong number', insertReview(withPayload(reviewUsage, { attempt_number: 2 }))],
  ];
  for (const [name, history] of cases) assert.equal(replayBlock(frozen, history).state, 'INVALID', name);
});

test('orchestrator operation opens a consecutive owned-usage window without changing block state', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const operation = orchestratorOperationFrom(events[0], 'operation-1');
  const usageOne = orchestratorUsageFrom(events[0], 'orchestrator-usage-1', 'operation-1');
  const usageTwo = orchestratorUsageFrom(events[0], 'orchestrator-usage-2', 'operation-1');
  const withOperation = renumber([events[0], operation, usageOne, usageTwo, ...events.slice(1)]);

  assert.equal(transition('PLANNED', operation, frozen), 'PLANNED');
  assert.equal(replayBlock(frozen, withOperation).state, 'ACCEPTED');
});

test('an unrelated usage record closes the orchestrator operation window', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const reviewStartIndex = events.findIndex((event) => event.event_type === 'REVIEW_STARTED');
  const operation = orchestratorOperationFrom(events[reviewStartIndex], 'operation-1');
  const ownedUsage = orchestratorUsageFrom(events[reviewStartIndex], 'orchestrator-usage-1', 'operation-1');
  const unrelatedUsage = usageFrom(events[reviewStartIndex], 'executor-usage-between', {
    attempt_id: `${events[0].block_id}-attempt-1`,
    review_id: null,
    role: 'executor',
    binding_ref: 'binding-strong',
  });
  const lateOwnedUsage = orchestratorUsageFrom(events[reviewStartIndex], 'orchestrator-usage-late', 'operation-1');
  const history = renumber([
    ...events.slice(0, reviewStartIndex),
    operation,
    ownedUsage,
    unrelatedUsage,
    lateOwnedUsage,
    ...events.slice(reviewStartIndex),
  ]);

  assert.equal(replayBlock(frozen, history).state, 'INVALID');
});

test('orchestrator usage rejects orphan, late, wrong-role, wrong-binding, wrong-attempt, duplicate, and unknown-binding ownership', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const operation = orchestratorOperationFrom(events[0], 'operation-1');
  const validUsage = orchestratorUsageFrom(events[0], 'orchestrator-usage-1', 'operation-1');
  const insert = (...evidence: PilotEventV3[]) => renumber([events[0], ...evidence, ...events.slice(1)]);
  const duplicate = orchestratorOperationFrom(events[0], 'operation-1');
  const unknownBinding = orchestratorOperationFrom(events[0], 'operation-unknown', { binding_ref: 'binding-unknown' });

  const cases: Array<[string, PilotEventV3[]]> = [
    ['orphan', insert(orchestratorUsageFrom(events[0], 'usage-orphan-operation', 'missing-operation'))],
    ['late after non-usage closes window', insert(operation, events[1], validUsage)],
    ['wrong role', insert(operation, orchestratorUsageFrom(events[0], 'usage-wrong-role', 'operation-1', { role: 'executor' }))],
    [
      'wrong binding',
      insert(operation, orchestratorUsageFrom(events[0], 'usage-wrong-binding', 'operation-1', { binding_ref: 'binding-cheap' })),
    ],
    ['wrong attempt', insert(operation, orchestratorUsageFrom(events[0], 'usage-wrong-attempt', 'operation-1', { attempt_number: 2 }))],
    ['duplicate operation id', insert(operation, duplicate)],
    ['unknown operation binding', insert(unknownBinding)],
  ];
  for (const [name, history] of cases) assert.equal(replayBlock(frozen, history).state, 'INVALID', name);
});

test('orchestrator operation is illegal before planning, after terminal state, or when invalidated', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const operation = orchestratorOperationFrom(events[0], 'operation-1');
  const usage = orchestratorUsageFrom(events[0], 'orchestrator-usage-1', 'operation-1');
  const beforePlanning = renumber([operation, ...events]);
  const afterTerminal = renumber([...events, operation]);
  const declared = renumber([events[0], operation, usage, ...events.slice(1)]);
  const activeOperation = declared.find((event) => event.event_type === 'ORCHESTRATOR_OPERATION_RECORDED')!;
  const tail = declared.at(-1)!;
  const invalidation = {
    ...tail,
    event_id: `${tail.block_id}-invalidate-operation`,
    event_type: 'EVENT_INVALIDATED',
    sequence_number: declared.length + 1,
    occurred_at: '2026-08-08T12:00:30.000Z',
    payload: {
      invalidated_event_id: activeOperation.event_id,
      expected_event_content_hash: hashCanonical(activeOperation),
      reason_code: 'operation-evidence-invalid',
    },
  } as PilotEventV3;

  assert.equal(replayBlock(frozen, beforePlanning).state, 'INVALID');
  assert.equal(replayBlock(frozen, afterTerminal).state, 'INVALID');
  assert.equal(replayBlock(frozen, [...declared, invalidation]).state, 'INVALID');
});

test('reviewer sessions are unique across review rounds', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['REJECT', 'ACCEPT']);
  const firstSession = (
    events.find((event) => event.event_type === 'REVIEW_STARTED') as Extract<PilotEventV3, { event_type: 'REVIEW_STARTED' }>
  ).payload.reviewer_session_id;
  const reused = events.map((event) =>
    (event.event_type === 'REVIEW_STARTED' || event.event_type === 'REVIEW_COMPLETED') && event.payload.review_round === 2
      ? ({ ...event, payload: { ...event.payload, reviewer_session_id: firstSession } } as PilotEventV3)
      : event,
  );
  assert.equal(replayBlock(frozen, reused).state, 'INVALID');

  const reviewerReusedAsExecutor = events.map((event) => {
    if ((event.event_type === 'EXECUTION_STARTED' || event.event_type === 'EXECUTION_COMPLETED') && event.payload.attempt_number === 2)
      return { ...event, payload: { ...event.payload, executor_session_id: firstSession } } as PilotEventV3;
    if ((event.event_type === 'REVIEW_STARTED' || event.event_type === 'REVIEW_COMPLETED') && event.payload.review_round === 2)
      return { ...event, payload: { ...event.payload, executor_session_id_reviewed: firstSession } } as PilotEventV3;
    return event;
  });
  assert.equal(replayBlock(frozen, reviewerReusedAsExecutor).state, 'INVALID');
});

test('C final execution uses the exact strong binding recorded by ESCALATION_DECIDED', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']);
  const wrongBinding = events.map((event) =>
    (event.event_type === 'EXECUTION_STARTED' || event.event_type === 'EXECUTION_COMPLETED') && event.payload.attempt_number === 3
      ? ({ ...event, payload: { ...event.payload, executor_binding_ref: 'binding-strong-alt' } } as PilotEventV3)
      : event,
  );
  assert.equal(replayBlock(frozen, wrongBinding).state, 'INVALID');
});

test('occurred_at ordering compares parsed UTC instants when milliseconds are optional', () => {
  const frozen = manifest();
  const events = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']);
  const ambiguous = events.map((event, index) =>
    index === 3
      ? ({ ...event, occurred_at: '2026-08-08T12:00:04.900Z' } as PilotEventV3)
      : index === 4
        ? ({ ...event, occurred_at: '2026-08-08T12:00:04Z' } as PilotEventV3)
        : event,
  );
  assert.equal(replayBlock(frozen, ambiguous).state, 'INVALID');
});

test('occurred_at rejects a nonexistent calendar date after schema acceptance', () => {
  const frozen = manifest();
  const prefix = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 4);
  const calendarBase = prefix.map((event, index) => ({ ...event, occurred_at: `2026-02-28T12:00:0${index + 1}.000Z` }) as PilotEventV3);
  const nonexistentDate = calendarBase.map((event, index) =>
    index === 3 ? ({ ...event, occurred_at: '2026-02-31T12:00:04.000Z' } as PilotEventV3) : event,
  );
  assert.equal(replayBlock(frozen, nonexistentDate).state, 'INVALID', 'February 31 must not normalize into March');
});

test('occurred_at rejects an impossible clock range after schema acceptance', () => {
  const frozen = manifest();
  const prefix = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 4);
  const calendarBase = prefix.map((event, index) => ({ ...event, occurred_at: `2026-02-28T12:00:0${index + 1}.000Z` }) as PilotEventV3);
  const impossibleHour = calendarBase.map((event, index) =>
    index === 3 ? ({ ...event, occurred_at: '2026-02-28T24:00:00Z' } as PilotEventV3) : event,
  );
  assert.equal(replayBlock(frozen, impossibleHour).state, 'INVALID', '24:00 must not normalize into the next day');
});

test('occurred_at accepts leap-day and equivalent or ordered contractual millisecond forms', () => {
  const frozen = manifest();
  const prefix = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 4);
  const occurred = ['2028-02-29T12:00:00Z', '2028-02-29T12:00:00.000Z', '2028-02-29T12:00:00.001Z', '2028-02-29T12:00:01Z'];
  const leapDay = prefix.map((event, index) => ({ ...event, occurred_at: occurred[index] }) as PilotEventV3);
  const replay = replayBlock(frozen, leapDay);
  assert.equal(replay.valid_history, true);
  assert.equal(replay.state, 'EXECUTING_1');
});

test('occurred_at accepts proleptic Gregorian leap days in years 0000 and 0096', () => {
  const frozen = manifest();
  const prefix = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 4);
  for (const year of ['0000', '0096']) {
    const leapDay = prefix.map((event, index) => ({ ...event, occurred_at: `${year}-02-29T12:00:0${index + 1}.000Z` }) as PilotEventV3);
    const replay = replayBlock(frozen, leapDay);
    assert.equal(replay.valid_history, true, year);
    assert.equal(replay.state, 'EXECUTING_1', year);
  }
});

test('occurred_at rejects proleptic Gregorian February 29 in low non-leap years', () => {
  const frozen = manifest();
  const prefix = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 4);
  for (const year of ['0001', '0095']) {
    const base = prefix.map((event, index) => ({ ...event, occurred_at: `${year}-02-28T12:00:0${index + 1}.000Z` }) as PilotEventV3);
    const invalidLeapDay = base.map((event, index) =>
      index === 3 ? ({ ...event, occurred_at: `${year}-02-29T12:00:04.000Z` } as PilotEventV3) : event,
    );
    assert.equal(replayBlock(frozen, invalidLeapDay).state, 'INVALID', year);
  }
});

test('duration arithmetic, reviewer ownership, escalation binding, and post-BLOCKED terminality are guarded explicitly', () => {
  const frozen = manifest();
  const valid = historyFor(frozen, 'C_ADAPTIVE_EARLY_ESCALATION', ['REJECT', 'REJECT', 'ACCEPT']);
  const badExecutionDuration = mutate(
    valid,
    'EXECUTION_COMPLETED',
    (event) => ({ ...event, payload: { ...event.payload, duration_ms: event.payload.duration_ms + 1 } }) as PilotEventV3,
  );
  const badReviewDuration = mutate(
    valid,
    'REVIEW_COMPLETED',
    (event) =>
      ({ ...event, payload: { ...event.payload, finished_monotonic_ms: event.payload.finished_monotonic_ms - 1 } }) as PilotEventV3,
  );
  for (const [name, events] of [
    ['execution duration', badExecutionDuration],
    ['review duration', badReviewDuration],
  ] as const)
    assert.equal(replayBlock(frozen, events).state, 'INVALID', name);

  const blocked = historyFor(frozen, 'A_STRONG_BASELINE', ['ACCEPT']).slice(0, 3);
  const prior = blocked.at(-1)!;
  blocked.push({
    ...prior,
    event_id: `${prior.block_id}-blocked-terminal`,
    event_type: 'BLOCK_BLOCKED',
    sequence_number: 4,
    occurred_at: '2026-08-08T12:00:04.000Z',
    payload: { cause: 'EXTERNAL', reason_code: 'dependency-down', evidence_hash: hash('6') },
  } as PilotEventV3);
  blocked.push({
    ...prior,
    event_id: `${prior.block_id}-failed-after-blocked`,
    event_type: 'BLOCK_FAILED',
    sequence_number: 5,
    occurred_at: '2026-08-08T12:00:05.000Z',
    payload: { reason_code: 'conflict', evidence_hash: hash('7') },
  } as PilotEventV3);
  assert.equal(replayBlock(frozen, blocked).state, 'INVALID');
});
