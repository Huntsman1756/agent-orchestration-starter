import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonical } from '../src/pilot/canonical-json.js';
import type { PilotBlockObservationV3, PilotManifestV3, PilotRoutingGateV3 } from '../src/pilot/contracts.js';
import {
  appendEvaluation,
  deterministicBootstrapIndices,
  evaluatePilot as evaluatePilotStrict,
  type PilotEvaluationContextV3,
  type PilotEvaluationHistoryV3,
} from '../src/pilot/evaluate.js';
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

type ManifestOptions = {
  minSupport?: number;
  direct?: boolean;
  economicRejection?: number;
  maxReworkBlockRate?: number;
  maxHighDefects?: number;
  maxMaterialDefects?: number;
};

function manifest(count: number, options: ManifestOptions = {}): PilotManifestV3 {
  const blocks: PilotManifestInputV3['blocks'] = [];
  for (let triplet = 1; triplet <= count; triplet += 1) {
    for (let member = 1; member <= 3; member += 1) blocks.push({
      block_id: `t-${String(triplet).padStart(2, '0')}-b-${member}`, task_id: `task-${triplet}`,
      matching_stratum: 'mechanical-low', pair_or_triplet_id: `t-${String(triplet).padStart(2, '0')}`,
      case_fingerprint: hash(String(triplet % 10)), contract_hash: hash('c'), base_revision: hash('d'),
      clean_tree_hash: hash('e'), fixtures_hash: hash('f'), complexity_class: 'mechanical', risk_class: 'low',
      changed_line_band: '1-25', validation_surface: ['typecheck'], cheap_eligible: true, comparative_eligible: true,
      routing_selection_reason: 'preclassified', selected_executor_capability_initial: 'cheap',
      selected_executor_capability_final_expected: 'strong', exclusion_reason: null,
    });
  }
  if (options.direct) blocks.push({
    block_id: 'direct-strong-1', task_id: 'direct-task', matching_stratum: 'systemic-high',
    pair_or_triplet_id: 'direct-1', case_fingerprint: hash('9'), contract_hash: hash('c'),
    base_revision: hash('d'), clean_tree_hash: hash('e'), fixtures_hash: hash('f'),
    complexity_class: 'systemic', risk_class: 'high', changed_line_band: 'large',
    validation_surface: ['typecheck'], cheap_eligible: false, comparative_eligible: false,
    routing_selection_reason: 'direct-strong', selected_executor_capability_initial: 'strong',
    selected_executor_capability_final_expected: 'strong', exclusion_reason: 'not-cheap-eligible',
  });
  const assignmentSeed = 'assignment-seed';
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
    pilot_id: 'pilot-evaluate-v3', pilot_schema_version: 3, created_at: timestamp, blocks: routedBlocks,
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
      material_improvement_rate: 0.15, economic_rejection_rate: options.economicRejection ?? 0.1,
      max_parent_rework_block_rate: options.maxReworkBlockRate ?? 0.1, max_parent_rework_production_line_share: 0.1,
      max_escaped_material_defects: options.maxMaterialDefects ?? 0, max_escaped_high_defects: options.maxHighDefects ?? 0, max_escaped_critical_defects: 0,
      min_observed_cost_completeness: 0.8, min_observed_strong_token_completeness: 0.8,
      min_stratum_triplets_for_promotion: options.minSupport ?? 1, confidence_level: 0.8,
      interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1', resampling_iterations: 100,
    },
    post_acceptance_window: { duration_seconds: 60, allowed_clock_skew_seconds: 0, closure_rule: 'elapsed_duration', late_evidence_policy: 'warn_next_evaluation', window_policy_version: 'window-v1' },
    pricing_snapshot: {
      pricing_snapshot_id: 'pricing-v1', pricing_snapshot_hash: hash('0'), currency: 'EUR', unit_scale: 1, effective_at: timestamp,
      tariffs: [
        { binding_ref: 'cheap-binding', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 1, cached_input_token_micro_units_per_token: 0, reasoning_token_micro_units_per_token: 0, authoritative_charge_supported: false },
        { binding_ref: 'strong-binding', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 1, cached_input_token_micro_units_per_token: 0, reasoning_token_micro_units_per_token: 0, authoritative_charge_supported: true },
      ],
    },
  });
}

type Options = {
  accepted?: boolean; cost?: number | null; strong?: number | null; wall?: number | null;
  defects?: Array<{ severity: 'low' | 'medium' | 'high' | 'critical'; material: boolean }>;
  valid?: boolean; window?: boolean; rework?: number; changed?: number; late?: number;
  reworkFile?: boolean;
};

function aggregate(value: number | null) {
  return { value, complete: value === null ? 0 : 1, total: 1, completeness_ratio: value === null ? 0 : 1 };
}

function observation(manifestValue: PilotManifestV3, triplet: number, arm: Arm, options: Options = {}): PilotBlockObservationV3 {
  const tripletId = `t-${String(triplet).padStart(2, '0')}`;
  const assignment = manifestValue.arm_assignments.find(item => item.pilot_arm === arm
    && manifestValue.blocks.find(block => block.block_id === item.block_id)?.pair_or_triplet_id === tripletId)!;
  const block = manifestValue.blocks.find(item => item.block_id === assignment.block_id)!;
  const accepted = options.accepted ?? true;
  const valid = options.valid ?? true;
  const cost = options.cost === undefined ? (arm === 'A_STRONG_BASELINE' ? 100 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 80 : 90) : options.cost;
  const strong = options.strong === undefined ? (arm === 'A_STRONG_BASELINE' ? 1000 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 700 : 100) : options.strong;
  const defects = (options.defects ?? []).map((defect, index) => ({
    defect_id: `defect-${triplet}-${arm}-${index}`, ...defect, discovered_at: timestamp,
    evidence_id: `evidence-${triplet}-${index}`, affected_revision: hash('a'), category_code: 'correctness',
  }));
  return {
    schema_version: 3, pilot_id: manifestValue.pilot_id, manifest_hash: manifestValue.manifest_hash,
    task_id: block.task_id, block_id: block.block_id, matching_stratum: block.matching_stratum,
    pair_or_triplet_id: block.pair_or_triplet_id, case_fingerprint: block.case_fingerprint, pilot_arm: arm,
    complexity_class: block.complexity_class, risk_class: block.risk_class, changed_line_band: block.changed_line_band,
    cheap_eligible: true, comparative_eligible: true, state: valid ? (accepted ? 'ACCEPTED' : 'FAILED') : 'INVALID',
    valid_history: valid, invalid_reason_codes: valid ? [] : ['reviewer_session_not_independent'],
    executor_binding_initial: arm === 'A_STRONG_BASELINE' ? 'strong-binding' : 'cheap-binding', executor_binding_final: 'strong-binding',
    reviewer_binding_refs: ['strong-binding'], execution_attempts: 1, repair_rounds: 0, escalated: false, escalation_reason: null,
    first_pass_accept: accepted, accept_after_one_repair: accepted, final_accepted: accepted,
    tests_initially_failing: 0, tests_finally_passing: accepted ? 1 : 0, review_findings_material: 0, review_findings_non_material: 0,
    parent_rework_files: { production: options.reworkFile || (options.rework ?? 0) > 0 ? 1 : 0, tests: 0, docs: 0 },
    parent_rework_lines_production: options.rework ?? 0, parent_rework_lines_tests: 0, parent_rework_lines_docs: 0,
    changed_lines_production: options.changed ?? 10, changed_lines_tests: 0, changed_lines_docs: 0,
    orchestrator_usage: { operations: 1, observed_tokens: 100, estimated_tokens: 110 },
    executor_usage: { operations: 1, observed_tokens: strong, estimated_tokens: strong },
    reviewer_usage: { operations: 1, observed_tokens: 100, estimated_tokens: 110 },
    total_usage: { operations: 3, observed_tokens: strong === null ? null : strong + 200, estimated_tokens: strong === null ? null : strong + 220 },
    cost_observed: cost, cost_estimated: cost, cost_observed_completeness: cost === null ? 0 : 1, cost_estimated_completeness: cost === null ? 0 : 1,
    strong_tokens_observed: { input: aggregate(strong), output: aggregate(0), cached_input: aggregate(0), reasoning: aggregate(0), total: aggregate(strong) },
    strong_tokens_estimated: { input: aggregate(strong), output: aggregate(0), cached_input: aggregate(0), reasoning: aggregate(0), total: aggregate(strong) },
    wall_time_seconds: options.wall === undefined ? 10 : options.wall, executor_time_seconds: 5, review_time_seconds: 5,
    blocked_cause: null, blocked_reason_code: null, post_acceptance_window_closed: options.window ?? accepted,
    accepted_at: accepted ? timestamp : null, window_opens_at: accepted ? timestamp : null,
    window_closes_at: accepted ? '2026-08-08T12:01:00.000Z' : null,
    post_accept_defects: defects, post_accept_defects_count: defects.length,
    post_accept_max_severity: defects.length ? defects.map(item => item.severity).sort().at(-1)! : null,
    late_quality_evidence_count: options.late ?? 0, quality_warnings: (options.late ?? 0) > 0 ? ['LATE_QUALITY_EVIDENCE'] : [],
    final_outcome: valid ? (accepted ? 'ACCEPTED' : 'FAILED') : 'INVALID',
  } as PilotBlockObservationV3;
}

function observations(manifestValue: PilotManifestV3, configure: (triplet: number, arm: Arm) => Options = () => ({})) {
  const count = new Set(manifestValue.blocks.filter(block => block.comparative_eligible).map(block => block.pair_or_triplet_id)).size;
  return Array.from({ length: count }, (_, index) => index + 1).flatMap(triplet => arms.map(arm => observation(manifestValue, triplet, arm, configure(triplet, arm))));
}

function directObservation(manifestValue: PilotManifestV3): PilotBlockObservationV3 {
  const direct = manifestValue.blocks.find(block => block.block_id === 'direct-strong-1')!;
  const template = observation(manifestValue, 1, 'A_STRONG_BASELINE');
  return {
    ...template,
    task_id: direct.task_id,
    block_id: direct.block_id,
    matching_stratum: direct.matching_stratum,
    pair_or_triplet_id: direct.pair_or_triplet_id,
    case_fingerprint: direct.case_fingerprint,
    pilot_arm: null,
    complexity_class: direct.complexity_class,
    risk_class: direct.risk_class,
    changed_line_band: direct.changed_line_band,
    cheap_eligible: direct.cheap_eligible,
    comparative_eligible: direct.comparative_eligible,
    executor_binding_initial: 'strong-binding',
  } as PilotBlockObservationV3;
}

function gate(manifestValue: PilotManifestV3, stage: 1 | 2 | 3, options: { eligible?: boolean; seed?: string } = {}): PilotRoutingGateV3 {
  const threshold = stage === 1 ? 10 : stage === 2 ? 20 : 30;
  const source = manifestValue.stage_thresholds;
  return {
    schema_version: 3, gate_policy_id: 'gate-policy-v1', pilot_id: manifestValue.pilot_id,
    manifest_hash: manifestValue.manifest_hash, stage, evaluated_at: timestamp,
    resampling_seed: options.seed ?? 'bootstrap-seed-v1',
    strata_policy: [...new Map(manifestValue.blocks.map(block => [block.matching_stratum, block])).values()]
      .sort((left, right) => left.matching_stratum < right.matching_stratum ? -1 : 1)
      .map(block => {
        const structurallyEligible = block.complexity_class !== 'systemic' && block.risk_class !== 'high' && block.risk_class !== 'restricted';
        const promotionEligible = structurallyEligible && (options.eligible ?? true);
        return {
          matching_stratum: block.matching_stratum,
          complexity_class: block.complexity_class,
          risk_class: block.risk_class,
          promotion_eligible: promotionEligible,
          exclusion_reason: promotionEligible ? null : 'policy-excluded',
        };
      }),
    thresholds: {
      minimum_blocks_per_arm: threshold,
      material_improvement_rate: source.material_improvement_rate, economic_rejection_rate: source.economic_rejection_rate,
      max_parent_rework_block_rate: source.max_parent_rework_block_rate,
      max_parent_rework_production_line_share: source.max_parent_rework_production_line_share,
      max_escaped_material_defects: source.max_escaped_material_defects,
      max_escaped_high_defects: source.max_escaped_high_defects,
      max_escaped_critical_defects: source.max_escaped_critical_defects,
      min_observed_cost_completeness: source.min_observed_cost_completeness,
      min_observed_strong_token_completeness: source.min_observed_strong_token_completeness,
      min_stratum_triplets_for_promotion: source.min_stratum_triplets_for_promotion,
      confidence_level: source.confidence_level, interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1',
      resampling_iterations: source.resampling_iterations,
    },
  } as PilotRoutingGateV3;
}

function context(version = 1, prior: PilotEvaluationContextV3['prior_report'] = null): PilotEvaluationContextV3 {
  return { evaluation_id: `evaluation-${version}`, evaluation_version: version, prior_report: prior };
}

function gateAtStage(source: PilotRoutingGateV3, stage: 1 | 2 | 3): PilotRoutingGateV3 {
  return {
    ...source,
    stage,
    thresholds: { ...source.thresholds, minimum_blocks_per_arm: stage === 1 ? 10 : stage === 2 ? 20 : 30 },
  } as PilotRoutingGateV3;
}

function evaluatePilot(
  manifestValue: PilotManifestV3,
  values: readonly PilotBlockObservationV3[],
  targetGate: PilotRoutingGateV3,
  targetContext: PilotEvaluationContextV3,
) {
  if (targetGate.stage === 1 || targetContext.prior_report !== null || targetContext.evaluation_version !== 1) {
    return evaluatePilotStrict(manifestValue, values, targetGate, targetContext);
  }
  const first = evaluatePilotStrict(manifestValue, values, gateAtStage(targetGate, 1), context());
  if (targetGate.stage === 2) return evaluatePilotStrict(manifestValue, values, targetGate, context(2, first));
  let second = evaluatePilotStrict(manifestValue, values, gateAtStage(targetGate, 2), context(2, first));
  if (second.decision === 'REJECT' || second.decision === 'PROMOTE_BOUNDED') {
    const suppliedBlockIds = new Set(values.map(value => value.block_id));
    const fallback = observations(manifestValue, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
      ? { cost: triplet <= 10 ? 70 : 100, strong: triplet <= 10 ? 700 : 1000 }
      : {}).filter(value => suppliedBlockIds.has(value.block_id));
    const fallbackFirst = evaluatePilotStrict(manifestValue, fallback, gateAtStage(targetGate, 1), context());
    second = evaluatePilotStrict(manifestValue, fallback, gateAtStage(targetGate, 2), context(2, fallbackFirst));
  }
  return evaluatePilotStrict(manifestValue, values, targetGate, context(3, second));
}

test('uses exact zero-based SHA256 counter bootstrap indices', () => {
  assert.deepEqual(deterministicBootstrapIndices({ seed: 'seed', manifest_hash: hash('a'), stage: 2, population_size: 3, iterations: 2 }), [
    [2, 0, 0], [2, 2, 0],
  ]);
});

test('fails closed when gate thresholds or complete unique strata policy diverge from the manifest', () => {
  const frozen = manifest(20); const values = observations(frozen);
  assert.throws(() => evaluatePilot(frozen, values, { ...gate(frozen, 2), thresholds: { ...gate(frozen, 2).thresholds, material_improvement_rate: 0.16 } } as PilotRoutingGateV3, context()), /GATE_THRESHOLD_MISMATCH/);
  assert.throws(() => evaluatePilot(frozen, values, { ...gate(frozen, 2), strata_policy: [] } as PilotRoutingGateV3, context()), /STRATA_POLICY_INVALID/);
  assert.throws(() => evaluatePilot(frozen, values, { ...gate(frozen, 2), strata_policy: [...gate(frozen, 2).strata_policy, ...gate(frozen, 2).strata_policy] } as PilotRoutingGateV3, context()), /STRATA_POLICY_INVALID/);
});

test('evaluates the frozen Stage 1 prefix without refilling an excluded candidate', () => {
  const frozen = manifest(11);
  const values = observations(frozen).filter(value => !(value.pair_or_triplet_id === 't-01' && value.pilot_arm === 'B_CHEAP_NO_EARLY_ESCALATION'));
  const report = evaluatePilot(frozen, values, gate(frozen, 1), context());
  assert.deepEqual([report.denominators.candidate_triplets, report.denominators.admitted_triplets, report.decision], [10, 9, 'CONTINUE']);
  assert.ok(report.reasons.includes('insufficient_comparable_samples'));
});

test('Stage 1 never materializes a promoted stratum record', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  assert.ok(report.strata.every(stratum => stratum.status === 'NOT_VALIDATED'));
  assert.deepEqual(report.promoted_strata, []);
  assert.deepEqual(report.not_validated_strata, report.strata.map(stratum => stratum.matching_stratum));
});

test('hard rejection never materializes a promoted stratum record', () => {
  const frozen = manifest(20);
  const values = observations(frozen, (triplet, arm) => triplet === 11 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { defects: [{ severity: 'high', material: true }] }
    : {});
  const report = evaluatePilot(frozen, values, gate(frozen, 2), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.strata.every(stratum => stratum.status === 'NOT_VALIDATED'));
});

test('is invariant across observation order and freezes resampling metadata and gate policy hash', () => {
  const frozen = manifest(20);
  const values = observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: triplet <= 10 ? 70 : 100 } : {});
  const forward = evaluatePilot(frozen, values, gate(frozen, 2), context());
  const reverse = evaluatePilot(frozen, [...values].reverse(), gate(frozen, 2), context());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.interval_metadata, { confidence_level: 0.8, interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1', resampling_iterations: 100, resampling_seed: 'bootstrap-seed-v1' });
  assert.equal(forward.gate_policy_hash, reverse.gate_policy_hash);
  assert.notEqual(forward.gate_policy_hash, evaluatePilot(frozen, values, gate(frozen, 2, { seed: 'other-seed' }), context()).gate_policy_hash);
});

test('Stage 1 continues when usable branches fail the point gate', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 95, strong: 950 } : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.deepEqual(report.efficiency_branches.map(branch => branch.status), ['FAIL_POINT', 'FAIL_POINT']);
  assert.ok(report.reasons.includes('stage_1_cannot_promote'));
});

test('Stage 1 rejects an observable material defect hard condition', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 1 && arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { defects: [{ severity: 'high', material: true }] } : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('material_post_accept_defect'));
});

test('complete observed cost with zero A and positive C is a hard economic regression', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => ({
    cost: arm === 'A_STRONG_BASELINE' ? 0 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 1 : 1,
  })), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('economic_regression_above_rejection_threshold'));
});

test('complete observed strong tokens with zero A and positive C is undefined and UNUSABLE', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => ({
    strong: arm === 'A_STRONG_BASELINE' ? 0 : arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 1 : 1,
  })), gate(frozen, 1), context());
  assert.equal(report.efficiency_branches[1].status, 'UNUSABLE');
});

test('concrete reducer invalid reasons propagate through exclusion and report evidence', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE'
    ? { valid: false }
    : {}), gate(frozen, 1), context());
  assert.ok(report.exclusions[0].reason_codes.includes('reviewer_session_not_independent'));
  assert.ok(report.reasons.includes('reviewer_session_not_independent'));
});

test('integrity hard reject outranks Stage 2 sample insufficiency', () => {
  const frozen = manifest(20);
  const values = observations(frozen).filter(value => !(value.pair_or_triplet_id === 't-20' && value.pilot_arm === 'B_CHEAP_NO_EARLY_ESCALATION'));
  values.push({ ...values[0], block_id: 'unknown-block', pair_or_triplet_id: 'unknown-triplet' } as PilotBlockObservationV3);
  const report = evaluatePilot(frozen, values, gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('integrity_failure'));
});

test('known comparative integrity mismatch outside the frozen prefix does not reject Stage 1', () => {
  const frozen = manifest(20);
  const values = observations(frozen).map(value => value.pair_or_triplet_id === 't-20'
    && value.pilot_arm === 'A_STRONG_BASELINE'
    ? { ...value, case_fingerprint: hash('9') } as PilotBlockObservationV3
    : value);
  const report = evaluatePilot(frozen, values, gate(frozen, 1), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.ok(!report.reasons.includes('manifest_identity_mismatch'));
});

test('an out-of-prefix known block cannot enter Stage 1 by claiming a selected triplet identity', () => {
  const frozen = manifest(20);
  const values = observations(frozen).map(value => value.pair_or_triplet_id === 't-20'
    && value.pilot_arm === 'A_STRONG_BASELINE'
    ? { ...value, pair_or_triplet_id: 't-01' } as PilotBlockObservationV3
    : value);
  const report = evaluatePilot(frozen, values, gate(frozen, 1), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.ok(!report.reasons.includes('manifest_identity_mismatch'));
});

test('an out-of-prefix comparative block cannot enter Stage 1 by claiming a null direct arm', () => {
  const frozen = manifest(20);
  const values = observations(frozen).map(value => value.pair_or_triplet_id === 't-20'
    && value.pilot_arm === 'A_STRONG_BASELINE'
    ? { ...value, pilot_arm: null } as PilotBlockObservationV3
    : value);
  const report = evaluatePilot(frozen, values, gate(frozen, 1), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.ok(!report.reasons.includes('manifest_identity_mismatch'));
});

test('unknown manifest observation remains a global Stage 1 integrity reject', () => {
  const frozen = manifest(10);
  const values = observations(frozen);
  const unknown = { ...values[0], block_id: 'unknown-block', pair_or_triplet_id: 'unknown-triplet' } as PilotBlockObservationV3;
  const report = evaluatePilot(frozen, [...values, unknown], gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('unknown_manifest_block'));
});

test('Stage 2 promotes only passing local strata and emits schema-valid bounded evidence', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen), gate(frozen, 2), context());
  assert.equal(report.decision, 'PROMOTE_BOUNDED');
  assert.deepEqual(report.promoted_strata, ['mechanical-low']);
  assert.deepEqual(report.efficiency_branches.map(branch => branch.status), ['PASS', 'PASS']);
  assert.deepEqual(report.strata.map(item => [item.matching_stratum, item.status]), [['mechanical-low', 'PROMOTED']]);
});

test('cost PASS emits material_cost_improvement in both branch and promoted outcome', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen), gate(frozen, 2), context());
  assert.equal(report.efficiency_branches[0].status, 'PASS');
  assert.ok(report.efficiency_branches[0].reason_codes.includes('material_cost_improvement'));
  assert.ok(report.reasons.includes('material_cost_improvement'));
});

test('strong-token PASS emits material_strong_token_improvement in both branch and promoted outcome', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen), gate(frozen, 2), context());
  assert.equal(report.efficiency_branches[1].status, 'PASS');
  assert.ok(report.efficiency_branches[1].reason_codes.includes('material_strong_token_improvement'));
  assert.ok(report.reasons.includes('material_strong_token_improvement'));
});

test('Stage 2 rejects sufficiently complete observed cost regression', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: triplet <= 10 ? 80 : 140 }
    : {}), gate(frozen, 2), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('economic_regression_above_rejection_threshold'));
});

test('Stage 2 continues when a complete economic interval remains ambiguous', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: triplet <= 10 ? 70 : 100, strong: triplet <= 10 ? 700 : 1000 } : {}), gate(frozen, 2), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.ok(report.efficiency_branches.some(branch => branch.status === 'AMBIGUOUS'));
  assert.ok(report.efficiency_branches.some(branch => branch.reason_codes.includes('decision_remains_ambiguous')));
  assert.ok(report.reasons.includes('decision_remains_ambiguous'));
});

test('incomplete cost emits observed_cost_incomplete in both branch and insufficient outcome', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: null, strong: null }
    : {}), gate(frozen, 2), context());
  assert.equal(report.efficiency_branches[0].status, 'UNUSABLE');
  assert.ok(report.efficiency_branches[0].reason_codes.includes('observed_cost_incomplete'));
  assert.ok(report.reasons.includes('observed_cost_incomplete'));
});

test('a non-promotion outcome never materializes a promoted stratum record', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: triplet <= 10 ? 70 : 100, strong: triplet <= 10 ? 700 : 1000 }
    : {}), gate(frozen, 2), context());
  assert.equal(report.decision, 'CONTINUE');
  assert.ok(report.strata.every(stratum => stratum.status === 'NOT_VALIDATED'));
});

test('Stage 2 continues when only the global paired acceptance lower bound is negative', () => {
  const frozen = manifest(20);
  const values = observations(frozen, (triplet, arm) => {
    if (triplet === 1 && arm === 'A_STRONG_BASELINE') return { accepted: false };
    if (triplet === 2 && arm === 'C_ADAPTIVE_EARLY_ESCALATION') return { accepted: false, cost: 70, strong: 700 };
    if (triplet >= 3 && arm === 'A_STRONG_BASELINE') return { defects: [{ severity: 'low', material: true }] };
    return arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 70, strong: 700 } : {};
  });
  const report = evaluatePilot(frozen, values, gate(frozen, 2), context());
  assert.ok(report.metrics.paired_comparisons.final_acceptance.confidence_interval!.lower < 0);
  assert.ok(report.metrics.paired_comparisons.final_quality.confidence_interval!.lower >= 0);
  assert.equal(report.decision, 'CONTINUE');
});

test('Stage 2 continues when only the global paired quality lower bound is negative', () => {
  const frozen = manifest(20, { maxMaterialDefects: 1 });
  const values = observations(frozen, (triplet, arm) => {
    if (triplet === 1 && arm === 'A_STRONG_BASELINE') return { defects: [{ severity: 'low', material: true }] };
    if (triplet === 2 && arm === 'C_ADAPTIVE_EARLY_ESCALATION') return { defects: [{ severity: 'low', material: true }], cost: 70, strong: 700 };
    return arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 70, strong: 700 } : {};
  });
  const report = evaluatePilot(frozen, values, gate(frozen, 2), context());
  assert.equal(report.metrics.paired_comparisons.final_acceptance.confidence_interval!.lower, 0);
  assert.ok(report.metrics.paired_comparisons.final_quality.confidence_interval!.lower < 0);
  assert.equal(report.decision, 'CONTINUE');
});

test('Stage 2 returns insufficient evidence for unusable observed branches or unsupported policy strata', () => {
  const frozen = manifest(20);
  const unusable = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: null, strong: null } : {}), gate(frozen, 2), context());
  assert.equal(unusable.decision, 'INSUFFICIENT_EVIDENCE');
  assert.ok(unusable.efficiency_branches.every(branch => branch.status === 'UNUSABLE'));
  const unsupported = evaluatePilot(frozen, observations(frozen), gate(frozen, 2, { eligible: false }), context());
  assert.equal(unsupported.decision, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(unsupported.promoted_strata, []);
});

test('observed cost regression is hard only when its frozen completeness threshold is met', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: triplet <= 5 ? null : 110, strong: null }
    : {}), gate(frozen, 2), context());
  assert.equal(report.efficiency_branches[0].completeness, 0.75);
  assert.equal(report.decision, 'INSUFFICIENT_EVIDENCE');
  assert.ok(!report.reasons.includes('economic_regression_above_rejection_threshold'));
});

test('hard defect ceilings use the frozen gate threshold rather than a zero default', () => {
  const frozen = manifest(20, { maxHighDefects: 1 });
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 11 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { defects: [{ severity: 'high', material: false }] }
    : {}), gate(frozen, 2), context());
  assert.equal(report.decision, 'PROMOTE_BOUNDED');
});

test('a critical post-accept defect independently hard rejects', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 1 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { defects: [{ severity: 'critical', material: false }] }
    : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('critical_post_accept_defect'));
  assert.ok(!report.reasons.includes('high_post_accept_defect'));
});

test('a high post-accept defect independently hard rejects', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 1 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { defects: [{ severity: 'high', material: false }] }
    : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('high_post_accept_defect'));
  assert.ok(!report.reasons.includes('critical_post_accept_defect'));
});

test('hard rework ceilings use the frozen gate threshold', () => {
  const frozen = manifest(20, { maxReworkBlockRate: 0.2 });
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' && triplet >= 11 && triplet <= 13
    ? { rework: 1 }
    : {}), gate(frozen, 2), context());
  assert.equal(report.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION.parent_rework_block_rate.value, 0.15);
  assert.equal(report.decision, 'PROMOTE_BOUNDED');
});

test('parent rework block rate independently hard rejects with the normative reason', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' && triplet <= 2
    ? { reworkFile: true }
    : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('parent_rework_block_rate_above_maximum'));
  assert.ok(!report.reasons.includes('parent_rework_line_share_above_maximum'));
});

test('parent rework production line share independently hard rejects with the normative reason', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (triplet, arm) => triplet === 1 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { rework: 20, changed: 100 }
    : {}), gate(frozen, 1), context());
  assert.equal(report.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION.parent_rework_block_rate.value, 0.1);
  assert.ok(report.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION.parent_rework_production_line_share.value! > 0.1);
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('parent_rework_line_share_above_maximum'));
  assert.ok(!report.reasons.includes('parent_rework_block_rate_above_maximum'));
});

test('hard economic regression uses the frozen rejection threshold', () => {
  const frozen = manifest(20, { economicRejection: 0.2 });
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: 115 }
    : {}), gate(frozen, 2), context());
  assert.equal(report.efficiency_branches[1].status, 'PASS');
  assert.equal(report.decision, 'PROMOTE_BOUNDED');
  assert.ok(!report.reasons.includes('economic_regression_above_rejection_threshold'));
});

test('Stage 2 cannot promote when candidate wall time is incomplete', () => {
  const frozen = manifest(20);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { wall: null } : {}), gate(frozen, 2), context());
  assert.equal(report.decision, 'INSUFFICIENT_EVIDENCE');
  assert.ok(report.reasons.includes('wall_time_incomplete'));
  assert.ok(!report.warnings.includes('WALL_TIME_INCOMPLETE_WAIVED'));
  assert.equal(report.metrics.paired_comparisons.wall_time_per_accepted_block.relative_improvement, null);
});

test('complete candidate wall time above baseline independently hard rejects', () => {
  const frozen = manifest(10);
  const report = evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { wall: 11 }
    : {}), gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.deepEqual(report.reasons, ['wall_time_above_baseline']);
});

test('Stage 1 report hashes quality and operational evidence from the full input multiset', () => {
  const frozen = manifest(20);
  const baseline = observations(frozen);
  const first = evaluatePilot(frozen, baseline, gate(frozen, 1), context());
  const changedLater = observations(frozen, (triplet, arm) => triplet === 20 && arm === 'A_STRONG_BASELINE'
    ? { cost: 200, defects: [{ severity: 'low', material: false }], late: 1 }
    : {});
  const changed = evaluatePilot(frozen, changedLater, gate(frozen, 1), context());
  assert.deepEqual([first.denominators.candidate_triplets, changed.denominators.candidate_triplets], [10, 10]);
  assert.notEqual(first.observation_set_hash, changed.observation_set_hash);
  assert.deepEqual([changed.quality_evidence_count, changed.late_quality_evidence_count], [62, 1]);
  assert.notEqual(first.operational_totals.comparative_by_arm.A_STRONG_BASELINE.cost_observed.known_sum,
    changed.operational_totals.comparative_by_arm.A_STRONG_BASELINE.cost_observed.known_sum);
});

test('bootstrap resource aggregation fails closed before losing a safe integer unit', () => {
  const frozen = manifest(20);
  const values = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE'
    ? { cost: Number.MAX_SAFE_INTEGER - 1900 }
    : {});
  assert.throws(() => evaluatePilot(frozen, values, gate(frozen, 2), context()), /SAFE_METRIC_ARITHMETIC_INVALID/);
});

test('Stage 3 independently promotes supported bounded evidence', () => {
  const frozen = manifest(30);
  assert.equal(evaluatePilot(frozen, observations(frozen), gate(frozen, 3), context()).decision, 'PROMOTE_BOUNDED');
});

test('Stage 3 independently rejects dual FAIL_POINT evidence', () => {
  const frozen = manifest(30);
  assert.equal(evaluatePilot(frozen, observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: 95, strong: 950 }
    : {}), gate(frozen, 3), context()).decision, 'REJECT');
});

test('Stage 3 independently terminates ambiguous evidence as inconclusive', () => {
  const frozen = manifest(30);
  assert.equal(evaluatePilot(frozen, observations(frozen, (triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { cost: triplet <= 15 ? 70 : 100, strong: triplet <= 15 ? 700 : 1000 }
    : {}), gate(frozen, 3), context()).decision, 'INCONCLUSIVE');
});

test('Stage 3 below 30 admitted triplets is terminal inconclusive', () => {
  const frozen = manifest(30);
  const values = observations(frozen).filter(value => !(value.pair_or_triplet_id === 't-30' && value.pilot_arm === 'B_CHEAP_NO_EARLY_ESCALATION'));
  const report = evaluatePilot(frozen, values, gate(frozen, 3), context());
  assert.equal(report.decision, 'INCONCLUSIVE');
  assert.ok(report.reasons.includes('insufficient_comparable_samples'));
});

test('version 1 starts at Stage 1', () => {
  const frozen = manifest(20);
  assert.throws(() => evaluatePilotStrict(frozen, observations(frozen), gate(frozen, 2), context()), /EVALUATION_STAGE_SEQUENCE_INVALID/);
});

test('a rejected pilot cannot advance to a new primary look', () => {
  const frozen = manifest(20);
  const rejectedValues = observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 110 } : {});
  const rejected = evaluatePilot(frozen, rejectedValues, gate(frozen, 1), context());
  assert.equal(rejected.decision, 'REJECT');
  assert.throws(() => evaluatePilot(frozen, observations(frozen), gate(frozen, 2), context(2, rejected)), /TERMINAL_DECISION_CANNOT_ADVANCE/);
});

test('a bounded promotion is terminal and cannot advance to another primary stage', () => {
  const frozen = manifest(30);
  const values = observations(frozen);
  const stage1 = evaluatePilotStrict(frozen, values, gate(frozen, 1), context());
  const stage2 = evaluatePilotStrict(frozen, values, gate(frozen, 2), context(2, stage1));
  assert.equal(stage2.decision, 'PROMOTE_BOUNDED');
  assert.throws(() => evaluatePilotStrict(frozen, values, gate(frozen, 3), context(3, stage2)), /TERMINAL_DECISION_CANNOT_ADVANCE/);
});

test('same-stage Stage 3 quality reevaluation may preserve an existing bounded promotion', () => {
  const frozen = manifest(30);
  const values = observations(frozen);
  const stage3 = evaluatePilot(frozen, values, gate(frozen, 3), context());
  assert.equal(stage3.decision, 'PROMOTE_BOUNDED');
  const qualityOnly = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE'
    ? { defects: [{ severity: 'low', material: false }], late: 1 }
    : {});
  assert.equal(evaluatePilotStrict(frozen, qualityOnly, gate(frozen, 3), context(4, stage3)).decision, 'PROMOTE_BOUNDED');
});

test('a rejected stage permits only a same-stage quality reevaluation that remains rejected', () => {
  const frozen = manifest(10);
  const rejectedValues = observations(frozen, (_triplet, arm) => arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 110 } : {});
  const first = evaluatePilot(frozen, rejectedValues, gate(frozen, 1), context());
  const withLateQuality = observations(frozen, (triplet, arm) => ({
    ...(arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 110 } : {}),
    ...(triplet === 1 && arm === 'A_STRONG_BASELINE' ? { late: 1 } : {}),
  }));
  assert.equal(evaluatePilot(frozen, withLateQuality, gate(frozen, 1), context(2, first)).decision, 'REJECT');
});

test('gate policy covers every manifest stratum including direct-only strata', () => {
  const frozen = manifest(20, { direct: true });
  const validGate = gate(frozen, 1);
  assert.equal(validGate.strata_policy.length, 2);
  assert.throws(() => evaluatePilot(frozen, observations(frozen), {
    ...validGate,
    strata_policy: validGate.strata_policy.filter(item => item.matching_stratum !== 'systemic-high'),
  } as PilotRoutingGateV3, context()), /STRATA_POLICY_INVALID/);
});

test('stratum records enumerate direct-only policy strata with zero comparative support', () => {
  const frozen = manifest(20, { direct: true });
  const report = evaluatePilot(frozen, [...observations(frozen), directObservation(frozen)], gate(frozen, 2), context());
  const direct = report.strata.find(stratum => stratum.matching_stratum === 'systemic-high');
  assert.deepEqual([direct?.candidate_triplets, direct?.admitted_triplets, direct?.status], [0, 0, 'NOT_VALIDATED']);
  assert.ok(report.not_validated_strata.includes('systemic-high'));
});

test('known direct observation identity mismatch is a global hard reject', () => {
  const frozen = manifest(20, { direct: true });
  const validGate = gate(frozen, 1);
  const mismatchedDirect = { ...directObservation(frozen), risk_class: 'restricted' } as PilotBlockObservationV3;
  const report = evaluatePilot(frozen, [...observations(frozen), mismatchedDirect], validGate, context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('integrity_failure'));
  assert.ok(report.reasons.includes('manifest_identity_mismatch'));
});

test('a direct manifest block claiming comparative arm A remains a global integrity reject', () => {
  const frozen = manifest(10, { direct: true });
  const falsified = { ...directObservation(frozen), pilot_arm: 'A_STRONG_BASELINE' } as PilotBlockObservationV3;
  const report = evaluatePilot(frozen, [...observations(frozen), falsified], gate(frozen, 1), context());
  assert.equal(report.decision, 'REJECT');
  assert.ok(report.reasons.includes('manifest_identity_mismatch'));
});

test('append-only history is canonical-idempotent hash-bound immutable and rejects collisions', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const history = appendEvaluation([] as PilotEvaluationHistoryV3, first);
  assert.equal(appendEvaluation(history, structuredClone(first)), history);
  assert.throws(() => appendEvaluation(history, { ...first, warnings: ['changed'] }), /EVALUATION_IDENTITY_COLLISION/);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history[0]));
  assert.equal(hashCanonical(history[0]), hashCanonical(first));
});

test('idempotent append clones and freezes a mutable caller-owned history snapshot', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const callerReport = structuredClone(first);
  const callerHistory = [callerReport];
  const snapshot = appendEvaluation(callerHistory, structuredClone(first));

  assert.notEqual(snapshot, callerHistory);
  assert.notEqual(snapshot[0], callerReport);
  assert.equal(Object.isFrozen(callerHistory), false);
  assert.equal(Object.isFrozen(callerReport), false);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]) && Object.isFrozen(snapshot[0].metrics));

  callerReport.reasons.push('caller_mutation');
  assert.ok(!snapshot[0].reasons.includes('caller_mutation'));
});

test('non-retry append leaves mutable caller reports untouched and returns a detached frozen snapshot', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const withQuality = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE'
    ? { late: 1 }
    : {});
  const second = evaluatePilot(frozen, withQuality, gate(frozen, 1), context(2, first));
  const callerFirst = structuredClone(first);
  const callerSecond = structuredClone(second);
  const callerHistory = [callerFirst];
  const snapshot = appendEvaluation(callerHistory, callerSecond);

  assert.equal(Object.isFrozen(callerHistory), false);
  assert.equal(Object.isFrozen(callerFirst), false);
  assert.equal(Object.isFrozen(callerSecond), false);
  assert.notEqual(snapshot[0], callerFirst);
  assert.notEqual(snapshot[1], callerSecond);
  assert.ok(Object.isFrozen(snapshot) && snapshot.every(report => Object.isFrozen(report) && Object.isFrozen(report.metrics)));

  callerFirst.reasons.push('caller_prior_mutation');
  callerSecond.warnings.push('caller_report_mutation');
  assert.ok(!snapshot[0].reasons.includes('caller_prior_mutation'));
  assert.ok(!snapshot[1].warnings.includes('caller_report_mutation'));
});

test('quality reevaluation requires monotonic owner-bound evidence and exact prior supersession', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  assert.throws(() => evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context(2, first)), /QUALITY_EVIDENCE_NOT_INCREASED/);
  const withQuality = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE' ? { defects: [{ severity: 'low', material: false }], late: 1 } : {});
  const second = evaluatePilot(frozen, withQuality, gate(frozen, 1), context(2, first));
  assert.deepEqual([second.supersedes_evaluation_id, second.supersedes_evaluation_version, second.expected_superseded_report_hash], [first.evaluation_id, first.evaluation_version, hashCanonical(first)]);
  assert.ok(second.warnings.includes('STALE_DECISION'));
  assert.throws(() => appendEvaluation(appendEvaluation([], first), { ...second, quality_evidence_count: 0 }), /QUALITY_EVIDENCE_DECREASED/);
});

test('same-stage reevaluation admits a newly closed quality window with no defects', () => {
  const frozen = manifest(10);
  const openWindow = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'C_ADAPTIVE_EARLY_ESCALATION'
    ? { window: false }
    : {});
  const first = evaluatePilot(frozen, openWindow, gate(frozen, 1), context());
  const second = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context(2, first));

  assert.equal(second.quality_evidence_count, first.quality_evidence_count + 1);
  assert.notEqual(second.quality_evidence_hash, first.quality_evidence_hash);
  assert.equal(second.decision_input_hash, first.decision_input_hash);
  assert.deepEqual([first.denominators.admitted_triplets, second.denominators.admitted_triplets], [9, 10]);
  assert.equal(second.expected_superseded_report_hash, hashCanonical(first));
});

test('late-only quality evidence enables one same-stage stale reevaluation and cannot decrease', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const lateOnly = observations(frozen, (triplet, arm) => triplet === 1 && arm === 'A_STRONG_BASELINE' ? { late: 1 } : {});
  const second = evaluatePilot(frozen, lateOnly, gate(frozen, 1), context(2, first));
  assert.deepEqual([second.quality_evidence_count, second.late_quality_evidence_count], [31, 1]);
  assert.ok(second.warnings.includes('STALE_DECISION'));

  const history = appendEvaluation(appendEvaluation([], first), second);
  assert.throws(() => appendEvaluation(history, {
    ...second,
    evaluation_id: 'evaluation-3',
    evaluation_version: 3,
    supersedes_evaluation_id: second.evaluation_id,
    supersedes_evaluation_version: second.evaluation_version,
    expected_superseded_report_hash: hashCanonical(second),
    late_quality_evidence_count: 0,
  }), /LATE_QUALITY_EVIDENCE_DECREASED/);
});

test('same-stage quality reevaluation rejects any changed economic decision input', () => {
  const frozen = manifest(10);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const changedEconomics = observations(frozen, (triplet, arm) => ({
    ...(triplet === 1 && arm === 'A_STRONG_BASELINE' ? { late: 1 } : {}),
    ...(arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 90 } : {}),
  }));
  assert.throws(() => evaluatePilot(frozen, changedEconomics, gate(frozen, 1), context(2, first)), /DECISION_INPUT_CHANGED/);
});

test('same-stage decision input hash includes out-of-prefix observations', () => {
  const frozen = manifest(20);
  const first = evaluatePilot(frozen, observations(frozen), gate(frozen, 1), context());
  const changedLater = observations(frozen, (triplet, arm) => ({
    ...(triplet === 1 && arm === 'A_STRONG_BASELINE' ? { late: 1 } : {}),
    ...(triplet === 20 && arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? { cost: 81 } : {}),
  }));
  assert.throws(() => evaluatePilotStrict(frozen, changedLater, gate(frozen, 1), context(2, first)), /DECISION_INPUT_CHANGED/);
});

test('same-stage decision input hash includes direct observations', () => {
  const frozen = manifest(10, { direct: true });
  const initial = [...observations(frozen), directObservation(frozen)];
  const first = evaluatePilot(frozen, initial, gate(frozen, 1), context());
  const changed = initial.map(value => value.pilot_arm === null ? { ...value, cost_observed: 101 } as PilotBlockObservationV3
    : value.block_id === initial[0].block_id ? { ...value, late_quality_evidence_count: 1 } as PilotBlockObservationV3 : value);
  assert.throws(() => evaluatePilotStrict(frozen, changed, gate(frozen, 1), context(2, first)), /DECISION_INPUT_CHANGED/);
});

test('same-stage decision input hash includes newly supplied unknown observations', () => {
  const frozen = manifest(10);
  const initial = observations(frozen);
  const first = evaluatePilot(frozen, initial, gate(frozen, 1), context());
  const withLate = initial.map((value, index) => index === 0 ? { ...value, late_quality_evidence_count: 1 } as PilotBlockObservationV3 : value);
  const unknown = { ...withLate[0], block_id: 'unknown-block', pair_or_triplet_id: 'unknown-triplet' } as PilotBlockObservationV3;
  assert.throws(() => evaluatePilotStrict(frozen, [...withLate, unknown], gate(frozen, 1), context(2, first)), /DECISION_INPUT_CHANGED/);
});
