import assert from 'node:assert/strict';
import test from 'node:test';

import type { PilotBlockObservationV3, PilotManifestV3 } from '../src/pilot/contracts.js';
import { computePilotMetrics } from '../src/pilot/metrics.js';
import { assignArms, freezeManifest, type PilotManifestInputV3 } from '../src/pilot/manifest.js';

const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;
type Arm = typeof arms[number];
const routeCapabilities = {
  A_STRONG_BASELINE: { initial: 'strong', final: 'strong' },
  B_CHEAP_NO_EARLY_ESCALATION: { initial: 'cheap', final: 'cheap' },
  C_ADAPTIVE_EARLY_ESCALATION: { initial: 'cheap', final: 'strong' },
} as const;
const hash = (character: string) => character.repeat(64);
const timestamp = '2026-08-08T12:00:00.000Z';

function manifest(tripletCount: number, includeDirect = false): PilotManifestV3 {
  const blocks: PilotManifestInputV3['blocks'] = [];
  for (let triplet = 1; triplet <= tripletCount; triplet += 1) {
    for (let member = 1; member <= 3; member += 1) {
      blocks.push({
        block_id: `triplet-${triplet}-block-${member}`, task_id: `task-${triplet}`,
        matching_stratum: triplet % 2 === 0 ? 'localized-medium' : 'mechanical-low',
        pair_or_triplet_id: `triplet-${triplet}`, case_fingerprint: hash(String(triplet % 10)),
        contract_hash: hash('c'), base_revision: hash('d'), clean_tree_hash: hash('e'), fixtures_hash: hash('f'),
        complexity_class: triplet % 2 === 0 ? 'localized' : 'mechanical', risk_class: triplet % 2 === 0 ? 'medium' : 'low',
        changed_line_band: '1-25', validation_surface: ['typecheck'], cheap_eligible: true,
        comparative_eligible: true, routing_selection_reason: 'preclassified',
        selected_executor_capability_initial: 'cheap', selected_executor_capability_final_expected: 'strong',
        exclusion_reason: null,
      });
    }
  }
  if (includeDirect) blocks.push({
    block_id: 'direct-strong-1', task_id: 'direct-task', matching_stratum: 'systemic-high', pair_or_triplet_id: 'direct-1',
    case_fingerprint: hash('9'), contract_hash: hash('c'), base_revision: hash('d'), clean_tree_hash: hash('e'), fixtures_hash: hash('f'),
    complexity_class: 'systemic', risk_class: 'high', changed_line_band: 'large', validation_surface: ['typecheck'],
    cheap_eligible: false, comparative_eligible: false, routing_selection_reason: 'direct-strong',
    selected_executor_capability_initial: 'strong', selected_executor_capability_final_expected: 'strong', exclusion_reason: 'not-cheap-eligible',
  });
  const assignmentSeed = 'assignment-seed-v3';
  const assignmentAlgorithmVersion = 'stratified-v1';
  const assignedArmByBlock = new Map(assignArms({
    blocks, assignment_seed: assignmentSeed, assignment_algorithm_version: assignmentAlgorithmVersion,
  }).map(assignment => [assignment.block_id, assignment.pilot_arm]));
  const routedBlocks = blocks.map(block => {
    const assignedArm = assignedArmByBlock.get(block.block_id);
    if (!assignedArm) return block;
    const route = routeCapabilities[assignedArm];
    return { ...block, selected_executor_capability_initial: route.initial, selected_executor_capability_final_expected: route.final };
  });
  return freezeManifest({
    pilot_id: 'pilot-metrics-v3', pilot_schema_version: 3, created_at: timestamp, blocks: routedBlocks,
    assignment_seed: assignmentSeed, assignment_algorithm_version: assignmentAlgorithmVersion,
    binding_policy_version: 'binding-v1', binding_registry: [
      { binding_ref: 'cheap-binding', capability_class: 'cheap', profile_hash: hash('1') },
      { binding_ref: 'strong-binding', capability_class: 'strong', profile_hash: hash('2') },
    ],
    routing_reviewer_binding_ref: 'strong-binding', routing_reviewer_capability: 'strong', review_mode: 'incremental_diff',
    routing_policy_version: 'routing-v1', review_policy_version: 'review-v1', state_machine_version: 'state-v1',
    reducer_version: 'reducer-v1', isolation_policy_version: 'isolation-v1', canonical_tree_algorithm_version: 'tree-v1',
    volatile_paths_policy_hash: hash('3'),
    stage_thresholds: {
      stage_1_blocks_per_arm: 10, stage_2_blocks_per_arm: 20, stage_3_max_blocks_per_arm: 30,
      material_improvement_rate: 0.15, economic_rejection_rate: 0.1,
      max_parent_rework_block_rate: 0.1, max_parent_rework_production_line_share: 0.1,
      max_escaped_material_defects: 0, max_escaped_high_defects: 0, max_escaped_critical_defects: 0,
      min_observed_cost_completeness: 0.8, min_observed_strong_token_completeness: 0.8,
      min_stratum_triplets_for_promotion: 1, confidence_level: 0.8,
      interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1', resampling_iterations: 100,
    },
    post_acceptance_window: {
      duration_seconds: 60, allowed_clock_skew_seconds: 0, closure_rule: 'elapsed_duration',
      late_evidence_policy: 'warn_next_evaluation', window_policy_version: 'window-v1',
    },
    pricing_snapshot: {
      pricing_snapshot_id: 'pricing-v1', pricing_snapshot_hash: hash('0'), currency: 'EUR', unit_scale: 1,
      effective_at: timestamp, tariffs: [
        { binding_ref: 'cheap-binding', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 1, cached_input_token_micro_units_per_token: 0, reasoning_token_micro_units_per_token: 0, authoritative_charge_supported: false },
        { binding_ref: 'strong-binding', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 1, cached_input_token_micro_units_per_token: 0, reasoning_token_micro_units_per_token: 0, authoritative_charge_supported: true },
      ],
    },
  });
}

type ObservationOptions = {
  accepted?: boolean;
  valid_history?: boolean;
  final_outcome?: 'ACCEPTED' | 'FAILED' | 'BLOCKED' | 'INVALID';
  window_closed?: boolean;
  cost_observed?: number | null;
  cost_estimated?: number | null;
  strong_observed?: number | null;
  strong_estimated?: number | null;
  all_role_observed?: number | null;
  all_role_estimated?: number | null;
  wall_time?: number | null;
  parent_rework_lines?: number;
  changed_production_lines?: number;
  first_pass?: boolean;
  escalated?: boolean;
  defects?: Array<{ severity: 'low' | 'medium' | 'high' | 'critical'; material: boolean }>;
  late?: number;
};

function aggregate(value: number | null) {
  return { value, complete: value === null ? 0 : 1, total: 1, completeness_ratio: value === null ? 0 : 1 };
}

function observationFor(manifestValue: PilotManifestV3, triplet: number, arm: Arm, options: ObservationOptions = {}): PilotBlockObservationV3 {
  const assignment = manifestValue.arm_assignments.find(candidate => candidate.pilot_arm === arm
    && manifestValue.blocks.find(block => block.block_id === candidate.block_id)?.pair_or_triplet_id === `triplet-${triplet}`)!;
  const block = manifestValue.blocks.find(candidate => candidate.block_id === assignment.block_id)!;
  return observationForBlock(manifestValue, block, arm, options);
}

function observationForBlock(
  manifestValue: PilotManifestV3,
  block: PilotManifestV3['blocks'][number],
  arm: Arm | null,
  options: ObservationOptions = {},
): PilotBlockObservationV3 {
  const accepted = options.accepted ?? true;
  const finalOutcome = options.final_outcome ?? (accepted ? 'ACCEPTED' : 'FAILED');
  const validHistory = options.valid_history ?? (finalOutcome !== 'INVALID');
  const defects = (options.defects ?? []).map((defect, index) => ({
    defect_id: `defect-${block.block_id}-${index}`, ...defect, discovered_at: timestamp,
    evidence_id: `evidence-${index}`, affected_revision: hash('a'), category_code: 'correctness',
  }));
  const complete = (value: number | null | undefined, fallback: number) => value === undefined ? fallback : value;
  const observedCost = complete(options.cost_observed, arm === 'A_STRONG_BASELINE' ? 100 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 80 : 90);
  const estimatedCost = complete(options.cost_estimated, arm === 'A_STRONG_BASELINE' ? 110 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 88 : 99);
  const strongObserved = complete(options.strong_observed, arm === 'A_STRONG_BASELINE' ? 1000 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 700 : 100);
  const strongEstimated = complete(options.strong_estimated, arm === 'A_STRONG_BASELINE' ? 1100 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 770 : 110);
  const allRoleObserved = complete(options.all_role_observed, arm === 'A_STRONG_BASELINE' ? 1500 : 1000);
  const allRoleEstimated = complete(options.all_role_estimated, arm === 'A_STRONG_BASELINE' ? 1600 : 1100);
  const windowClosed = options.window_closed ?? accepted;
  return {
    schema_version: 3, pilot_id: manifestValue.pilot_id, manifest_hash: manifestValue.manifest_hash,
    task_id: block.task_id, block_id: block.block_id, matching_stratum: block.matching_stratum,
    pair_or_triplet_id: block.pair_or_triplet_id, case_fingerprint: block.case_fingerprint, pilot_arm: arm,
    complexity_class: block.complexity_class, risk_class: block.risk_class, changed_line_band: block.changed_line_band,
    cheap_eligible: block.cheap_eligible, comparative_eligible: block.comparative_eligible,
    state: finalOutcome, valid_history: validHistory, invalid_reason_codes: validHistory ? [] : ['invalid_event_history'],
    executor_binding_initial: arm === 'A_STRONG_BASELINE' || arm === null ? 'strong-binding' : 'cheap-binding',
    executor_binding_final: 'strong-binding', reviewer_binding_refs: ['strong-binding'], execution_attempts: options.escalated ? 3 : 1,
    repair_rounds: 0, escalated: options.escalated ?? false, escalation_reason: options.escalated ? 'review-rejected' : null,
    first_pass_accept: accepted && (options.first_pass ?? true), accept_after_one_repair: accepted,
    final_accepted: accepted, tests_initially_failing: 0, tests_finally_passing: accepted ? 1 : 0,
    review_findings_material: 0, review_findings_non_material: 0,
    parent_rework_files: { production: (options.parent_rework_lines ?? 0) > 0 ? 1 : 0, tests: 0, docs: 0 },
    parent_rework_lines_production: options.parent_rework_lines ?? 0, parent_rework_lines_tests: 0, parent_rework_lines_docs: 0,
    changed_lines_production: options.changed_production_lines ?? 10, changed_lines_tests: 0, changed_lines_docs: 0,
    orchestrator_usage: { operations: 1, observed_tokens: 100, estimated_tokens: 110 },
    executor_usage: { operations: 1, observed_tokens: allRoleObserved === null ? null : Math.max(0, allRoleObserved - 200), estimated_tokens: allRoleEstimated === null ? null : Math.max(0, allRoleEstimated - 220) },
    reviewer_usage: { operations: 1, observed_tokens: 100, estimated_tokens: 110 },
    total_usage: { operations: 3, observed_tokens: allRoleObserved, estimated_tokens: allRoleEstimated },
    cost_observed: observedCost, cost_estimated: estimatedCost,
    cost_observed_completeness: observedCost === null ? 0 : 1, cost_estimated_completeness: estimatedCost === null ? 0 : 1,
    strong_tokens_observed: { input: aggregate(strongObserved), output: aggregate(0), cached_input: aggregate(0), reasoning: aggregate(0), total: aggregate(strongObserved) },
    strong_tokens_estimated: { input: aggregate(strongEstimated), output: aggregate(0), cached_input: aggregate(0), reasoning: aggregate(0), total: aggregate(strongEstimated) },
    wall_time_seconds: options.wall_time === undefined ? 10.125 : options.wall_time,
    executor_time_seconds: 5.125, review_time_seconds: 5,
    blocked_cause: finalOutcome === 'BLOCKED' ? 'EXTERNAL' : null,
    blocked_reason_code: finalOutcome === 'BLOCKED' ? 'dependency' : null,
    post_acceptance_window_closed: windowClosed,
    accepted_at: accepted ? timestamp : null, window_opens_at: accepted ? timestamp : null,
    window_closes_at: accepted ? '2026-08-08T12:01:00.000Z' : null,
    post_accept_defects: defects, post_accept_defects_count: defects.length,
    post_accept_max_severity: defects.length ? defects.map(defect => defect.severity).sort().at(-1)! : null,
    late_quality_evidence_count: options.late ?? 0, quality_warnings: (options.late ?? 0) > 0 ? ['LATE_QUALITY_EVIDENCE'] : [],
    final_outcome: finalOutcome,
  } as PilotBlockObservationV3;
}

function completeTriplet(manifestValue: PilotManifestV3, triplet: number, byArm: Partial<Record<Arm, ObservationOptions>> = {}) {
  return arms.map(arm => observationFor(manifestValue, triplet, arm, byArm[arm]));
}

test('admits only exact complete triplets and retains missing-member and direct operational evidence', () => {
  const frozen = manifest(2, true);
  const directBlock = frozen.blocks.find(block => block.block_id === 'direct-strong-1')!;
  const direct = observationForBlock(frozen, directBlock, null, { cost_observed: 250, wall_time: null, late: 2 });
  const incomplete = completeTriplet(frozen, 2).filter(observation => observation.pilot_arm !== 'B_CHEAP_NO_EARLY_ESCALATION');

  const result = computePilotMetrics(frozen, [...completeTriplet(frozen, 1), ...incomplete, direct]);

  assert.deepEqual({ candidate: result.denominators.candidate_triplets, admitted: result.denominators.admitted_triplets, excluded: result.denominators.excluded_triplets }, { candidate: 2, admitted: 1, excluded: 1 });
  assert.deepEqual(result.denominators.comparable_blocks_by_arm, Object.fromEntries(arms.map(arm => [arm, 1])));
  assert.deepEqual(result.exclusions[0].reason_codes, ['missing_observation']);
  assert.deepEqual(result.exclusions[0].members_by_arm.B_CHEAP_NO_EARLY_ESCALATION.block_ids, []);
  assert.equal(result.exclusions[0].operational_resources.cost_observed.known_sum, 180);
  assert.equal(result.operational_totals.direct_to_strong.cost_observed.complete_value, 250);
  assert.equal(result.operational_totals.direct_to_strong.wall_time_seconds.complete_value, null);
  assert.equal(result.late_quality_evidence_count, 2);
});

const exclusionCases: Array<[string, (triplet: PilotBlockObservationV3[]) => PilotBlockObservationV3[]]> = [
  ['duplicate_observation', triplet => [...triplet, triplet[0]]],
  ['invalid_event_history', triplet => triplet.map((value, index) => index === 0 ? { ...value, valid_history: false, final_outcome: 'INVALID', state: 'INVALID', invalid_reason_codes: ['invalid_event_history'], final_accepted: false, first_pass_accept: false, accept_after_one_repair: false } as PilotBlockObservationV3 : value)],
  ['blocked_observation', triplet => triplet.map((value, index) => index === 1 ? { ...value, final_outcome: 'BLOCKED', state: 'BLOCKED', final_accepted: false, first_pass_accept: false, accept_after_one_repair: false, blocked_cause: 'EXTERNAL', blocked_reason_code: 'dependency', accepted_at: null, window_opens_at: null, window_closes_at: null, post_acceptance_window_closed: false } as PilotBlockObservationV3 : value)],
  ['manifest_identity_mismatch', triplet => triplet.map((value, index) => index === 2 ? { ...value, case_fingerprint: hash('8') } : value)],
  ['quality_window_open', triplet => triplet.map((value, index) => index === 2 ? { ...value, post_acceptance_window_closed: false } : value)],
];

for (const [reason, mutate] of exclusionCases) {
  test(`excludes ${reason} triplets symmetrically with a stable reason`, () => {
    const frozen = manifest(1);
    const result = computePilotMetrics(frozen, mutate(completeTriplet(frozen, 1)));
    assert.equal(result.denominators.admitted_triplets, 0, reason);
    assert.ok(result.exclusions[0].reason_codes.includes(reason), `${reason}: ${result.exclusions[0].reason_codes.join(',')}`);
    assert.deepEqual(result.denominators.comparable_blocks_by_arm, Object.fromEntries(arms.map(arm => [arm, 0])), reason);
  });
}

test('attributes each mismatched observation once by its expected manifest block identity', () => {
  const frozen = manifest(1);
  const values = completeTriplet(frozen, 1);
  values[0] = { ...values[0], pilot_arm: 'B_CHEAP_NO_EARLY_ESCALATION' } as PilotBlockObservationV3;
  const result = computePilotMetrics(frozen, values);
  assert.equal(result.exclusions[0].operational_resources.cost_observed.total, 3);
  assert.equal(result.exclusions[0].operational_resources.cost_observed.known_sum,
    values.reduce((sum, value) => sum + (value.cost_observed ?? 0), 0));
});

test('reports literal paired acceptance and quality discordance counts over the same admitted triplets', () => {
  const frozen = manifest(4);
  const observations = [
    ...completeTriplet(frozen, 1),
    ...completeTriplet(frozen, 2, { C_ADAPTIVE_EARLY_ESCALATION: { accepted: false } }),
    ...completeTriplet(frozen, 3, { A_STRONG_BASELINE: { accepted: false } }),
    ...completeTriplet(frozen, 4, { A_STRONG_BASELINE: { accepted: false }, C_ADAPTIVE_EARLY_ESCALATION: { accepted: false } }),
  ];
  const result = computePilotMetrics(frozen, observations);

  assert.deepEqual(result.metrics.paired_comparisons.final_acceptance, {
    baseline_successes: 2, candidate_successes: 2, both_success: 1,
    baseline_only_success: 1, candidate_only_success: 1, neither_success: 1,
    denominator: 4, difference: 0, confidence_interval: null,
  });
  assert.deepEqual(result.metrics.by_arm.A_STRONG_BASELINE.final_acceptance_rate, { numerator: 2, denominator: 4, value: 0.5, confidence_interval: null });
  assert.deepEqual(result.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION.final_acceptance_rate, { numerator: 2, denominator: 4, value: 0.5, confidence_interval: null });
});

test('uses ratio-of-sums rework and symmetric economic populations without mixing observed and estimated tokens', () => {
  const frozen = manifest(2);
  const observations = [
    ...completeTriplet(frozen, 1, {
      C_ADAPTIVE_EARLY_ESCALATION: { parent_rework_lines: 2, changed_production_lines: 4, cost_observed: 80, all_role_observed: 1000, all_role_estimated: 1200 },
    }),
    ...completeTriplet(frozen, 2, {
      A_STRONG_BASELINE: { cost_observed: null },
      C_ADAPTIVE_EARLY_ESCALATION: { accepted: false, parent_rework_lines: 0, changed_production_lines: 6, cost_observed: 20, all_role_observed: 500, all_role_estimated: 700 },
    }),
  ];
  const result = computePilotMetrics(frozen, observations);
  const candidate = result.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION;

  assert.deepEqual(candidate.parent_rework_block_rate, { numerator: 1, denominator: 2, value: 0.5, confidence_interval: null });
  assert.deepEqual(candidate.parent_rework_production_line_share, { numerator: 2, denominator: 10, value: 0.2, confidence_interval: null });
  assert.deepEqual(candidate.observed_cost_per_accepted_block, { numerator: 80, denominator: 1, value: 80, confidence_interval: null });
  assert.deepEqual(candidate.all_role_tokens_observed_per_accepted_block, { numerator: 1500, denominator: 1, value: 1500, confidence_interval: null });
  assert.deepEqual(candidate.all_role_tokens_estimated_per_accepted_block, { numerator: 1900, denominator: 1, value: 1900, confidence_interval: null });
  assert.equal(result.completeness.observed_cost_by_arm.A_STRONG_BASELINE, 0.5);
  assert.equal(result.populations.observed_cost_triplet_ids.length, 1);
});

test('hashes the complete observation multiset canonically while preserving duplicate and direct evidence', () => {
  const frozen = manifest(1, true);
  const direct = observationForBlock(frozen, frozen.blocks.find(block => block.block_id === 'direct-strong-1')!, null);
  const values = [...completeTriplet(frozen, 1), direct];
  const forward = computePilotMetrics(frozen, values);
  const reverse = computePilotMetrics(frozen, [...values].reverse());
  const duplicate = computePilotMetrics(frozen, [...values, values[0]]);

  assert.equal(forward.observation_set_hash, reverse.observation_set_hash);
  assert.notEqual(forward.observation_set_hash, duplicate.observation_set_hash);
  assert.deepEqual(forward, reverse);
});

test('counts every escaped material, high and critical defect retained in accepted work', () => {
  const frozen = manifest(2);
  const observations = [
    ...completeTriplet(frozen, 1, { C_ADAPTIVE_EARLY_ESCALATION: { defects: [
      { severity: 'high', material: true }, { severity: 'critical', material: true },
    ] } }),
    ...completeTriplet(frozen, 2, { C_ADAPTIVE_EARLY_ESCALATION: { accepted: false } }),
  ];
  const candidate = computePilotMetrics(frozen, observations).metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION;
  assert.deepEqual(candidate.escaped_material_defect_rate, { numerator: 2, denominator: 1, value: 2, confidence_interval: null });
  assert.deepEqual(candidate.escaped_high_defects, { numerator: 1, denominator: 2, value: 0.5, confidence_interval: null });
  assert.deepEqual(candidate.escaped_critical_defects, { numerator: 1, denominator: 2, value: 0.5, confidence_interval: null });
});

test('sums canonical fractional wall time without binary drift and fails closed past safe integer economics', () => {
  const frozen = manifest(2);
  const exact = [
    ...completeTriplet(frozen, 1, { C_ADAPTIVE_EARLY_ESCALATION: { wall_time: 0.1 } }),
    ...completeTriplet(frozen, 2, { C_ADAPTIVE_EARLY_ESCALATION: { wall_time: 0.2 } }),
  ];
  assert.equal(computePilotMetrics(frozen, exact).metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION.wall_time_per_accepted_block.numerator, 0.3);

  const overflow = [
    ...completeTriplet(frozen, 1, { C_ADAPTIVE_EARLY_ESCALATION: { cost_observed: Number.MAX_SAFE_INTEGER } }),
    ...completeTriplet(frozen, 2, { C_ADAPTIVE_EARLY_ESCALATION: { cost_observed: 1 } }),
  ];
  assert.throws(() => computePilotMetrics(frozen, overflow), /SAFE_METRIC_ARITHMETIC_INVALID/);
});

test('retains every duplicate member block id and flags observations for unknown manifest blocks', () => {
  const frozen = manifest(1);
  const triplet = completeTriplet(frozen, 1);
  const duplicate = computePilotMetrics(frozen, [...triplet, triplet[0]]);
  const duplicateArm = triplet[0].pilot_arm!;
  assert.deepEqual(duplicate.exclusions[0].members_by_arm[duplicateArm].block_ids, [triplet[0].block_id, triplet[0].block_id]);

  const unknown = { ...triplet[0], block_id: 'unknown-block', pair_or_triplet_id: 'unknown-triplet' } as PilotBlockObservationV3;
  assert.deepEqual(computePilotMetrics(frozen, [...triplet, unknown]).integrity_reasons, ['unknown_manifest_block']);
});

test('hashes owned closures, in-window defects, and late-count markers into the combined quality evidence', () => {
  const frozen = manifest(1);
  const triplet = completeTriplet(frozen, 1, {
    A_STRONG_BASELINE: { defects: [{ severity: 'low', material: false }], late: 1 },
    C_ADAPTIVE_EARLY_ESCALATION: { defects: [{ severity: 'high', material: false }] },
  });
  const forward = computePilotMetrics(frozen, triplet);
  const reverse = computePilotMetrics(frozen, [...triplet].reverse());
  assert.deepEqual([forward.quality_evidence_count, forward.late_quality_evidence_count], [6, 1]);
  assert.equal(forward.quality_evidence_hash, reverse.quality_evidence_hash);

  const increasedLate = triplet.map(value => value.pilot_arm === 'A_STRONG_BASELINE'
    ? { ...value, late_quality_evidence_count: 2 }
    : value) as PilotBlockObservationV3[];
  const increased = computePilotMetrics(frozen, increasedLate);
  assert.deepEqual([increased.quality_evidence_count, increased.late_quality_evidence_count], [7, 2]);
  assert.notEqual(forward.quality_evidence_hash, increased.quality_evidence_hash);

  const moved = triplet.map(value => ({ ...value, post_accept_defects: [] })) as PilotBlockObservationV3[];
  moved[1] = { ...moved[1], post_accept_defects: triplet[0].post_accept_defects, post_accept_defects_count: 1 } as PilotBlockObservationV3;
  moved[2] = { ...moved[2], post_accept_defects: triplet[2].post_accept_defects, post_accept_defects_count: 1 } as PilotBlockObservationV3;
  assert.notEqual(forward.quality_evidence_hash, computePilotMetrics(frozen, moved).quality_evidence_hash);
});

test('quality evidence counts and owner-binds defect-free window closure markers', () => {
  const frozen = manifest(1);
  const candidateOpen = completeTriplet(frozen, 1, {
    C_ADAPTIVE_EARLY_ESCALATION: { window_closed: false },
  });
  const candidateClosed = completeTriplet(frozen, 1);
  const baselineOpen = completeTriplet(frozen, 1, {
    A_STRONG_BASELINE: { window_closed: false },
  });
  const before = computePilotMetrics(frozen, candidateOpen);
  const after = computePilotMetrics(frozen, candidateClosed);
  const differentOwner = computePilotMetrics(frozen, baselineOpen);

  assert.deepEqual([before.quality_evidence_count, after.quality_evidence_count], [2, 3]);
  assert.notEqual(before.quality_evidence_hash, after.quality_evidence_hash);
  assert.equal(differentOwner.quality_evidence_count, before.quality_evidence_count);
  assert.notEqual(differentOwner.quality_evidence_hash, before.quality_evidence_hash);
});

test('keeps zero-operation economics descriptively zero but outside every observed branch population', () => {
  const frozen = manifest(1);
  const zeroOperation = completeTriplet(frozen, 1).map(value => ({
    ...value,
    total_usage: { operations: 0, observed_tokens: 0, estimated_tokens: 0 },
    cost_observed: 0, cost_estimated: 0, cost_observed_completeness: 1, cost_estimated_completeness: 1,
    strong_tokens_observed: { ...value.strong_tokens_observed, total: aggregate(0) },
    strong_tokens_estimated: { ...value.strong_tokens_estimated, total: aggregate(0) },
  } as PilotBlockObservationV3));
  const result = computePilotMetrics(frozen, zeroOperation);
  assert.deepEqual(result.populations.observed_cost_triplet_ids, []);
  assert.deepEqual(result.operational_totals.comparative_by_arm.A_STRONG_BASELINE.cost_observed, {
    known_sum: 0, complete: 0, total: 0, completeness_ratio: null, complete_value: 0,
  });
});

test('zero-operation nonzero economics canonicalize to zero and trigger integrity failure', () => {
  const frozen = manifest(1);
  const invalid = completeTriplet(frozen, 1).map((value, index) => index === 0 ? {
    ...value,
    total_usage: { operations: 0, observed_tokens: 1, estimated_tokens: 1 },
    cost_observed: 1,
    cost_estimated: 1,
  } as PilotBlockObservationV3 : value);
  const result = computePilotMetrics(frozen, invalid);
  assert.ok(result.integrity_reasons.includes('zero_operation_economic_value'));
  assert.ok(result.exclusions[0].reason_codes.includes('zero_operation_economic_value'));
  assert.deepEqual(result.operational_totals.comparative_by_arm.A_STRONG_BASELINE.cost_observed, {
    known_sum: 0, complete: 0, total: 0, completeness_ratio: null, complete_value: 0,
  });
});

test('freezes only owned result snapshots and never caller observation objects', () => {
  const frozen = manifest(1);
  const input = completeTriplet(frozen, 1);
  const result = computePilotMetrics(frozen, input);
  assert.equal(Object.isFrozen(input[0]), false);
  assert.notEqual(result.populations.core_triplets[0].members.A_STRONG_BASELINE, input[0]);
  assert.ok(Object.isFrozen(result.populations.core_triplets[0].members.A_STRONG_BASELINE));
});
