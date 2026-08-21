import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import type { PilotEventV3 } from '../src/pilot/contracts.js';
import {
  loadPilotBlockObservationV3,
  loadPilotEvaluationReportV3,
  loadPilotEventV3,
  loadPilotManifestV3,
  loadPilotRoutingGateV3,
} from '../src/pilot/load.js';
import { assertSafeEvent } from '../src/pilot/sensitive-guard.js';

type Loader = (value: unknown) => unknown;

const hash = (character: string) => character.repeat(64);
const timestamp = '2026-08-08T12:00:00.000Z';
const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;

async function loadValidator(path: string) {
  const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  return new Ajv2020({ strict: true, allErrors: true }).compile(schema);
}

test('public V3 schemas compile with an independent strict AJV instance', async () => {
  for (const path of [
    '../contracts/pilot-manifest-v3.schema.json',
    '../contracts/pilot-event-v3.schema.json',
    '../contracts/pilot-block-observation-v3.schema.json',
    '../contracts/pilot-routing-gate-v3.schema.json',
    '../contracts/pilot-evaluation-report-v3.schema.json',
  ]) {
    const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    assert.doesNotThrow(() => new Ajv2020({ strict: true, allErrors: true }).compile(schema), path);
  }
});

test('every public V3 array schema has a finite maxItems ceiling of 128', async () => {
  const paths = [
    '../contracts/pilot-manifest-v3.schema.json',
    '../contracts/pilot-event-v3.schema.json',
    '../contracts/pilot-block-observation-v3.schema.json',
    '../contracts/pilot-routing-gate-v3.schema.json',
    '../contracts/pilot-evaluation-report-v3.schema.json',
  ];
  function visit(value: unknown, path: string): void {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.type === 'array') {
      assert.equal(typeof record.maxItems, 'number', `${path} must set maxItems`);
      assert.ok((record.maxItems as number) <= 128, `${path} must not exceed maxItems=128`);
    }
    for (const [key, child] of Object.entries(record)) visit(child, `${path}/${key}`);
  }
  for (const path of paths) {
    const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    visit(schema, path);
  }
});

function manifest() {
  return {
    pilot_id: 'pilot-v3-001',
    pilot_schema_version: 3,
    manifest_hash: hash('a'),
    created_at: timestamp,
    blocks: ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'].map((pilot_arm, index) => ({
      block_id: `block-${index + 1}`,
      task_id: 'task-a',
      matching_stratum: 'mechanical-low',
      pair_or_triplet_id: 'triplet-a',
      case_fingerprint: hash('b'),
      contract_hash: hash('c'),
      base_revision: hash('d'),
      clean_tree_hash: hash('9'),
      fixtures_hash: hash('e'),
      complexity_class: 'mechanical',
      risk_class: 'low',
      changed_line_band: '1-25',
      validation_surface: ['typecheck'],
      cheap_eligible: true,
      comparative_eligible: true,
      routing_selection_reason: 'preclassified',
      selected_executor_capability_initial: pilot_arm === 'A_STRONG_BASELINE' ? 'strong' : 'cheap',
      selected_executor_capability_final_expected: pilot_arm === 'B_CHEAP_NO_EARLY_ESCALATION' ? 'cheap' : 'strong',
      exclusion_reason: null,
    })),
    assignment_seed: 'seed-v3',
    assignment_algorithm_version: 'stratified-v1',
    arm_assignments: [
      { block_id: 'block-1', pilot_arm: 'A_STRONG_BASELINE' },
      { block_id: 'block-2', pilot_arm: 'B_CHEAP_NO_EARLY_ESCALATION' },
      { block_id: 'block-3', pilot_arm: 'C_ADAPTIVE_EARLY_ESCALATION' },
    ],
    binding_policy_version: 'binding-policy-v1',
    binding_registry: [
      { binding_ref: 'binding-cheap-v1', capability_class: 'cheap', profile_hash: hash('f') },
      { binding_ref: 'binding-strong-v1', capability_class: 'strong', profile_hash: hash('0') },
    ],
    routing_reviewer_binding_ref: 'binding-strong-v1',
    routing_reviewer_capability: 'strong',
    review_mode: 'incremental_diff',
    routing_policy_version: 'routing-policy-v1',
    review_policy_version: 'review-policy-v1',
    state_machine_version: 'state-machine-v1',
    reducer_version: 'reducer-v1',
    isolation_policy_version: 'isolation-policy-v1',
    canonical_tree_algorithm_version: 'canonical-tree-v1',
    volatile_paths_policy_hash: hash('8'),
    stage_thresholds: {
      stage_1_blocks_per_arm: 10,
      stage_2_blocks_per_arm: 20,
      stage_3_max_blocks_per_arm: 30,
      material_improvement_rate: 0.15,
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
      interval_algorithm_version: 'paired-bootstrap-v1',
      resampling_iterations: 1000,
    },
    post_acceptance_window: {
      duration_seconds: 604800,
      allowed_clock_skew_seconds: 60,
      closure_rule: 'elapsed_duration',
      late_evidence_policy: 'warn_next_evaluation',
      window_policy_version: 'window-policy-v1',
    },
    pricing_snapshot: {
      pricing_snapshot_id: 'pricing-v1',
      pricing_snapshot_hash: hash('1'),
      currency: 'EUR',
      unit_scale: 1000000,
      effective_at: timestamp,
      tariffs: [
        {
          binding_ref: 'binding-cheap-v1',
          input_token_micro_units_per_token: 1,
          output_token_micro_units_per_token: 2,
          cached_input_token_micro_units_per_token: null,
          reasoning_token_micro_units_per_token: null,
          authoritative_charge_supported: false,
        },
        {
          binding_ref: 'binding-strong-v1',
          input_token_micro_units_per_token: 1,
          output_token_micro_units_per_token: 2,
          cached_input_token_micro_units_per_token: null,
          reasoning_token_micro_units_per_token: null,
          authoritative_charge_supported: true,
        },
      ],
    },
  };
}

function event() {
  return {
    schema_version: 3,
    event_id: 'event-1',
    event_type: 'EXECUTION_COMPLETED',
    pilot_id: 'pilot-v3-001',
    manifest_hash: hash('a'),
    task_id: 'task-a',
    block_id: 'block-a',
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: 'triplet-a',
    case_fingerprint: hash('b'),
    pilot_arm: 'C_ADAPTIVE_EARLY_ESCALATION',
    sequence_number: 5,
    occurred_at: timestamp,
    recorded_at: timestamp,
    producer_id: 'reducer-fixture',
    payload: {
      attempt_id: 'attempt-1',
      attempt_number: 1,
      attempt_kind: 'IMPLEMENTATION',
      executor_capability: 'cheap',
      executor_binding_ref: 'binding-cheap-v1',
      executor_session_id: 'executor-session-1',
      input_revision: hash('d'),
      output_revision: hash('2'),
      output_tree_hash: hash('3'),
      canonical_tree_algorithm_version: 'canonical-tree-v1',
      volatile_paths_policy_hash: hash('8'),
      tree_reproduced: true,
      tree_reproduction_evidence_hash: hash('7'),
      output_diff_hash: hash('4'),
      changed_lines_production: 1,
      changed_lines_tests: 1,
      changed_lines_docs: 0,
      outcome: 'COMPLETED',
      started_monotonic_ms: 100,
      finished_monotonic_ms: 200,
      duration_ms: 100,
    },
  };
}

function observation() {
  const completeMeasure = { value: 100, complete: 1, total: 1, completeness_ratio: 1 };
  const incompleteMeasure = { value: null, complete: 0, total: 1, completeness_ratio: 0 };
  return {
    schema_version: 3,
    pilot_id: 'pilot-v3-001',
    manifest_hash: hash('a'),
    task_id: 'task-a',
    block_id: 'block-a',
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: 'triplet-a',
    case_fingerprint: hash('b'),
    pilot_arm: 'C_ADAPTIVE_EARLY_ESCALATION',
    complexity_class: 'mechanical',
    risk_class: 'low',
    changed_line_band: '1-25',
    cheap_eligible: true,
    comparative_eligible: true,
    state: 'ACCEPTED',
    valid_history: true,
    invalid_reason_codes: [],
    executor_binding_initial: 'binding-cheap-v1',
    executor_binding_final: 'binding-strong-v1',
    reviewer_binding_refs: ['binding-strong-v1'],
    execution_attempts: 3,
    repair_rounds: 1,
    escalated: true,
    escalation_reason: 'second_review_rejected',
    first_pass_accept: false,
    accept_after_one_repair: false,
    final_accepted: true,
    tests_initially_failing: 1,
    tests_finally_passing: 1,
    review_findings_material: 1,
    review_findings_non_material: 0,
    parent_rework_files: { production: 0, tests: 0, docs: 0 },
    parent_rework_lines_production: 0,
    parent_rework_lines_tests: 0,
    parent_rework_lines_docs: 0,
    changed_lines_production: 1,
    changed_lines_tests: 1,
    changed_lines_docs: 0,
    orchestrator_usage: { operations: 0, observed_tokens: null, estimated_tokens: null },
    executor_usage: { operations: 3, observed_tokens: 100, estimated_tokens: null },
    reviewer_usage: { operations: 3, observed_tokens: 100, estimated_tokens: null },
    total_usage: { operations: 6, observed_tokens: 200, estimated_tokens: null },
    cost_observed: null,
    cost_estimated: 10,
    cost_observed_completeness: 0,
    cost_estimated_completeness: 1,
    strong_tokens_observed: {
      input: completeMeasure,
      output: completeMeasure,
      cached_input: incompleteMeasure,
      reasoning: incompleteMeasure,
      total: incompleteMeasure,
    },
    strong_tokens_estimated: {
      input: incompleteMeasure,
      output: incompleteMeasure,
      cached_input: incompleteMeasure,
      reasoning: incompleteMeasure,
      total: incompleteMeasure,
    },
    wall_time_seconds: 10.125,
    executor_time_seconds: 5.125,
    review_time_seconds: 5,
    blocked_cause: null,
    blocked_reason_code: null,
    post_acceptance_window_closed: true,
    accepted_at: timestamp,
    window_opens_at: timestamp,
    window_closes_at: '2026-08-15T12:00:00.000Z',
    post_accept_defects: [],
    post_accept_defects_count: 0,
    post_accept_max_severity: null,
    late_quality_evidence_count: 0,
    quality_warnings: [],
    final_outcome: 'ACCEPTED',
  };
}

function gate() {
  return {
    schema_version: 3,
    gate_policy_id: 'gate-v1',
    pilot_id: 'pilot-v3-001',
    manifest_hash: hash('a'),
    stage: 2,
    evaluated_at: timestamp,
    resampling_seed: 'seed-v3',
    strata_policy: [
      {
        matching_stratum: 'mechanical-low',
        complexity_class: 'mechanical',
        risk_class: 'low',
        promotion_eligible: true,
        exclusion_reason: null,
      },
    ],
    thresholds: {
      minimum_blocks_per_arm: 20,
      material_improvement_rate: 0.15,
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
      interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1',
      resampling_iterations: 1000,
    },
  };
}

function report() {
  const metric = (numerator: number, denominator: number, value: number | null = denominator === 0 ? null : numerator / denominator) => ({
    numerator,
    denominator,
    value,
    confidence_interval: value === null ? null : { lower: value, upper: value },
  });
  const byArm = Object.fromEntries(
    arms.map((arm) => [
      arm,
      {
        final_acceptance_rate: metric(20, 20, 1),
        escaped_material_defect_rate: metric(0, 20, 0),
        escaped_high_defects: metric(0, 20, 0),
        escaped_critical_defects: metric(0, 20, 0),
        wall_time_per_accepted_block: metric(2000, 20, 100),
        observed_cost_per_accepted_block: metric(2000, 20, 100),
        estimated_cost_per_accepted_block: metric(2200, 20, 110),
        strong_tokens_observed_per_accepted_block: metric(20000, 20, 1000),
        strong_tokens_estimated_per_accepted_block: metric(22000, 20, 1100),
        all_role_tokens_observed_per_accepted_block: metric(40000, 20, 2000),
        all_role_tokens_estimated_per_accepted_block: metric(42000, 20, 2100),
        first_pass_accept_rate: metric(18, 20, 0.9),
        accept_after_one_repair_rate: metric(20, 20, 1),
        escalation_rate: metric(arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 2 : 0, 20, arm === 'C_ADAPTIVE_EARLY_ESCALATION' ? 0.1 : 0),
        parent_rework_block_rate: metric(1, 20, 0.05),
        parent_rework_production_line_share: metric(5, 200, 0.025),
      },
    ]),
  );
  const pairedQuality = {
    baseline_successes: 20,
    candidate_successes: 20,
    both_success: 20,
    baseline_only_success: 0,
    candidate_only_success: 0,
    neither_success: 0,
    denominator: 20,
    difference: 0,
    confidence_interval: { lower: 0, upper: 0 },
  };
  const pairedMetric = {
    baseline_value: 100,
    candidate_value: 80,
    relative_improvement: 0.2,
    confidence_interval: { lower: 0.16, upper: 0.24 },
  };
  const perArm = Object.fromEntries(arms.map((arm) => [arm, 1]));
  const dimensionalCompleteness = {
    input_by_arm: perArm,
    output_by_arm: perArm,
    cached_input_by_arm: perArm,
    reasoning_by_arm: perArm,
    total_by_arm: perArm,
  };
  return {
    schema_version: 3,
    evaluation_id: 'evaluation-1',
    evaluation_version: 1,
    pilot_id: 'pilot-v3-001',
    manifest_hash: hash('a'),
    evaluated_at: timestamp,
    supersedes_evaluation_id: null,
    stage: 2,
    decision: 'PROMOTE_BOUNDED',
    promoted_strata: ['mechanical-low'],
    not_validated_strata: [],
    reasons: ['material_cost_improvement'],
    metrics: {
      by_arm: byArm,
      paired_comparisons: {
        final_acceptance: pairedQuality,
        final_quality: pairedQuality,
        parent_rework_block_rate: pairedMetric,
        parent_rework_production_line_share: pairedMetric,
        wall_time_per_accepted_block: pairedMetric,
        observed_cost_per_accepted_block: pairedMetric,
        estimated_cost_per_accepted_block: pairedMetric,
        strong_tokens_observed_per_accepted_block: pairedMetric,
        strong_tokens_estimated_per_accepted_block: pairedMetric,
        all_role_tokens_observed_per_accepted_block: pairedMetric,
        all_role_tokens_estimated_per_accepted_block: pairedMetric,
      },
    },
    efficiency_branches: [
      {
        branch: 'observed_cost',
        status: 'PASS',
        eligible_triplets: 20,
        completeness: 1,
        point_improvement: 0.2,
        confidence_interval: { lower: 0.16, upper: 0.24 },
        reason_codes: ['material_cost_improvement'],
      },
      {
        branch: 'observed_strong_tokens',
        status: 'FAIL_POINT',
        eligible_triplets: 20,
        completeness: 1,
        point_improvement: 0.1,
        confidence_interval: { lower: 0.05, upper: 0.14 },
        reason_codes: ['strong_token_improvement_below_threshold'],
      },
    ],
    strata: [
      {
        matching_stratum: 'mechanical-low',
        candidate_triplets: 21,
        admitted_triplets: 20,
        status: 'PROMOTED',
        reason_codes: ['sufficient_stratum_support'],
        paired_final_acceptance: pairedQuality,
        paired_final_quality: pairedQuality,
        efficiency_branches: [
          {
            branch: 'observed_cost',
            status: 'PASS',
            eligible_triplets: 20,
            completeness: 1,
            point_improvement: 0.2,
            confidence_interval: { lower: 0.16, upper: 0.24 },
            reason_codes: ['material_cost_improvement'],
          },
          {
            branch: 'observed_strong_tokens',
            status: 'FAIL_POINT',
            eligible_triplets: 20,
            completeness: 1,
            point_improvement: 0.1,
            confidence_interval: { lower: 0.05, upper: 0.14 },
            reason_codes: ['strong_token_improvement_below_threshold'],
          },
        ],
      },
    ],
    exclusions: [
      {
        pair_or_triplet_id: 'triplet-excluded',
        reason_codes: ['quality_window_open'],
        members_by_arm: {
          A_STRONG_BASELINE: { block_ids: ['excluded-a'], resources: resourceTotals(10.125, 10, 12, 100, 120, 200, 220) },
          B_CHEAP_NO_EARLY_ESCALATION: { block_ids: ['excluded-b'], resources: resourceTotals(10, 10, 12, 100, 120, 200, 220) },
          C_ADAPTIVE_EARLY_ESCALATION: { block_ids: ['excluded-c'], resources: resourceTotals(null, 10, 12, 100, 120, 200, 220) },
        },
        operational_resources: resourceTotals(null, 30, 36, 300, 360, 600, 660, 2, 3),
      },
    ],
    operational_totals: {
      comparative_by_arm: Object.fromEntries(
        arms.map((arm) => [arm, resourceTotals(2000, 2000, 2200, 20000, 22000, 40000, 42000, 20, 20)]),
      ),
      direct_to_strong: resourceTotals(null, null, null, null, null, null, null, 0, 0),
    },
    denominators: {
      manifest_blocks: 63,
      comparative_blocks: 63,
      candidate_triplets: 21,
      admitted_triplets: 20,
      excluded_triplets: 1,
      comparable_blocks_by_arm: Object.fromEntries(arms.map((arm) => [arm, 20])),
      accepted_blocks_by_arm: Object.fromEntries(arms.map((arm) => [arm, 20])),
      quality_complete_blocks_by_arm: Object.fromEntries(arms.map((arm) => [arm, 20])),
    },
    completeness: {
      observed_cost_by_arm: perArm,
      estimated_cost_by_arm: perArm,
      strong_tokens_observed: dimensionalCompleteness,
      strong_tokens_estimated: dimensionalCompleteness,
      wall_time_by_arm: perArm,
    },
    interval_metadata: {
      confidence_level: 0.95,
      interval_algorithm_version: 'paired-bootstrap-sha256-counter-v1',
      resampling_iterations: 1000,
      resampling_seed: 'seed-v3',
    },
    supersedes_evaluation_version: null,
    expected_superseded_report_hash: null,
    observation_set_hash: hash('7'),
    decision_input_hash: hash('8'),
    quality_evidence_hash: hash('5'),
    quality_evidence_count: 0,
    gate_policy_hash: hash('6'),
    late_quality_evidence_count: 0,
    warnings: [],
  };
}

function resourceMeasure(value: number | null, complete = value === null ? 0 : 1, total = 1) {
  return {
    known_sum: value ?? 0,
    complete,
    total,
    completeness_ratio: total === 0 ? null : complete / total,
    complete_value: complete === total ? (value ?? 0) : null,
  };
}

function resourceTotals(
  wallTime: number | null,
  observedCost: number | null,
  estimatedCost: number | null,
  observedStrong: number | null,
  estimatedStrong: number | null,
  observedAllRole: number | null,
  estimatedAllRole: number | null,
  complete = 1,
  total = 1,
) {
  return {
    wall_time_seconds: resourceMeasure(wallTime, wallTime === null ? 0 : complete, total),
    cost_observed: resourceMeasure(observedCost, observedCost === null ? 0 : complete, total),
    cost_estimated: resourceMeasure(estimatedCost, estimatedCost === null ? 0 : complete, total),
    strong_tokens_observed: resourceMeasure(observedStrong, observedStrong === null ? 0 : complete, total),
    strong_tokens_estimated: resourceMeasure(estimatedStrong, estimatedStrong === null ? 0 : complete, total),
    all_role_tokens_observed: resourceMeasure(observedAllRole, observedAllRole === null ? 0 : complete, total),
    all_role_tokens_estimated: resourceMeasure(estimatedAllRole, estimatedAllRole === null ? 0 : complete, total),
  };
}

const documents: Array<{
  name: string;
  schema: string;
  loader: Loader;
  valid: () => unknown;
  invalid: Array<[string, (value: any) => unknown]>;
}> = [
  {
    name: 'manifest',
    schema: '../contracts/pilot-manifest-v3.schema.json',
    loader: loadPilotManifestV3,
    valid: manifest,
    invalid: [
      ['unknown property', (value) => ({ ...value, provider: 'forbidden' })],
      ['malformed manifest hash', (value) => ({ ...value, manifest_hash: 'not-a-hash' })],
      ['concrete model field', (value) => ({ ...value, binding_registry: [{ ...value.binding_registry[0], model: 'forbidden' }] })],
      ['invalid stage threshold', (value) => ({ ...value, stage_thresholds: { ...value.stage_thresholds, stage_2_blocks_per_arm: 9 } })],
      [
        'comparative block that is not cheap eligible',
        (value) => ({ ...value, blocks: [{ ...value.blocks[0], cheap_eligible: false }, ...value.blocks.slice(1)] }),
      ],
      [
        'comparative restricted block',
        (value) => ({ ...value, blocks: [{ ...value.blocks[0], risk_class: 'restricted' }, ...value.blocks.slice(1)] }),
      ],
      [
        'comparative block with an exclusion reason',
        (value) => ({ ...value, blocks: [{ ...value.blocks[0], exclusion_reason: 'predeclared-exclusion' }, ...value.blocks.slice(1)] }),
      ],
    ],
  },
  {
    name: 'event',
    schema: '../contracts/pilot-event-v3.schema.json',
    loader: loadPilotEventV3,
    valid: event,
    invalid: [
      ['unknown property', (value) => ({ ...value, unexpected: true })],
      ['malformed event id', (value) => ({ ...value, event_id: '' })],
      ['open payload', (value) => ({ ...value, payload: { ...value.payload, prompt: 'raw content is forbidden' } })],
      ['concrete provider field', (value) => ({ ...value, payload: { ...value.payload, provider: 'forbidden' } })],
      ['negative duration', (value) => ({ ...value, payload: { ...value.payload, duration_ms: -1 } })],
      [
        'missing timestamp',
        (value) => {
          const { occurred_at, ...withoutTimestamp } = value;
          return withoutTimestamp;
        },
      ],
    ],
  },
  {
    name: 'observation',
    schema: '../contracts/pilot-block-observation-v3.schema.json',
    loader: loadPilotBlockObservationV3,
    valid: observation,
    invalid: [
      ['unknown property', (value) => ({ ...value, raw_diff: 'forbidden' })],
      ['malformed id', (value) => ({ ...value, block_id: '' })],
      ['illegal accepted outcome', (value) => ({ ...value, final_outcome: 'ACCEPTED', final_accepted: false })],
      ['illegal escalation combination', (value) => ({ ...value, escalated: false, escalation_reason: 'second_review_rejected' })],
      ['missing timestamp for closed accepted window', (value) => ({ ...value, accepted_at: null })],
      ['more than one repair round', (value) => ({ ...value, repair_rounds: 2 })],
    ],
  },
  {
    name: 'routing gate',
    schema: '../contracts/pilot-routing-gate-v3.schema.json',
    loader: loadPilotRoutingGateV3,
    valid: gate,
    invalid: [
      ['unknown property', (value) => ({ ...value, model: 'forbidden' })],
      ['malformed id', (value) => ({ ...value, gate_policy_id: '' })],
      ['invalid threshold', (value) => ({ ...value, thresholds: { ...value.thresholds, min_observed_cost_completeness: 0 } })],
    ],
  },
  {
    name: 'evaluation report',
    schema: '../contracts/pilot-evaluation-report-v3.schema.json',
    loader: loadPilotEvaluationReportV3,
    valid: report,
    invalid: [
      ['unknown property', (value) => ({ ...value, provider: 'forbidden' })],
      ['malformed id', (value) => ({ ...value, evaluation_id: '' })],
      ['illegal terminal decision at stage one', (value) => ({ ...value, stage: 1, decision: 'PROMOTE_BOUNDED' })],
      ['illegal terminal decision at stage three', (value) => ({ ...value, stage: 3, decision: 'CONTINUE' })],
      [
        'incomplete paired comparison matrix',
        (value) => {
          const { final_quality, ...paired_comparisons } = value.metrics.paired_comparisons;
          return { ...value, metrics: { ...value.metrics, paired_comparisons } };
        },
      ],
      ['unbounded reason collection', (value) => ({ ...value, reasons: Array.from({ length: 129 }, (_, index) => `reason-${index}`) })],
    ],
  },
];

for (const document of documents) {
  test(`${document.name} accepts the minimal valid V3 document in AJV and Zod`, async () => {
    const validate = await loadValidator(document.schema);
    const value = document.valid();
    assert.equal(validate(value), true);
    assert.deepEqual(document.loader(value), value);
  });

  for (const [name, createInvalid] of document.invalid) {
    test(`${document.name} rejects ${name} consistently in AJV and Zod`, async () => {
      const validate = await loadValidator(document.schema);
      const value = createInvalid(document.valid());
      const ajvAccepts = validate(value);
      let zodAccepts = true;
      try {
        document.loader(value);
      } catch {
        zodAccepts = false;
      }
      assert.equal(ajvAccepts, false, `AJV accepted ${document.name}: ${name}`);
      assert.equal(zodAccepts, false, `Zod accepted ${document.name}: ${name}`);
      assert.equal(ajvAccepts, zodAccepts, `validators diverged for ${document.name}: ${name}`);
    });
  }
}

test('Task 6 direct-to-strong observations accept a null pilot arm in AJV and Zod', async () => {
  const validate = await loadValidator('../contracts/pilot-block-observation-v3.schema.json');
  const value = { ...observation(), pilot_arm: null, cheap_eligible: false, comparative_eligible: false };
  assert.equal(validate(value), true);
  assert.deepEqual(loadPilotBlockObservationV3(value), value);
});

test('Task 6 observation guards nullable arms and blocked-cause parity in AJV and Zod', async () => {
  const validate = await loadValidator('../contracts/pilot-block-observation-v3.schema.json');
  const blocked = {
    ...observation(),
    final_outcome: 'BLOCKED',
    final_accepted: false,
    first_pass_accept: false,
    accept_after_one_repair: false,
    valid_history: true,
    state: 'BLOCKED',
    blocked_cause: 'EXTERNAL',
    blocked_reason_code: 'dependency',
  };
  for (const value of [
    { ...observation(), pilot_arm: null, comparative_eligible: true },
    { ...blocked, blocked_cause: null },
  ]) {
    const ajv = validate(value);
    let zod = true;
    try {
      loadPilotBlockObservationV3(value);
    } catch {
      zod = false;
    }
    assert.deepEqual({ ajv, zod }, { ajv: false, zod: false });
  }
  assert.equal(validate(blocked), true);
  assert.deepEqual(loadPilotBlockObservationV3(blocked), blocked);
});

function eventOf(event_type: string, payload: any): any {
  return { ...event(), event_id: `event-${event_type}`, event_type, payload };
}

function reviewCompleted(): any {
  return eventOf('REVIEW_COMPLETED', {
    review_id: 'review-1',
    review_round: 1,
    reviewer_binding_ref: 'binding-strong-v1',
    reviewer_session_id: 'reviewer-session-1',
    reviewed_attempt_id: 'attempt-1',
    executor_session_id_reviewed: 'executor-session-1',
    review_input_diff_hash: hash('4'),
    previous_review_boundary_hash: null,
    review_boundary_hash: hash('5'),
    review_boundary_from_revision: hash('d'),
    review_boundary_to_revision: hash('2'),
    unresolved_finding_ids: [],
    validation_evidence_hashes: [],
    bounded_context_hashes: [],
    additional_context_requests: [],
    material_findings: [],
    non_material_findings: [],
    decision: 'ACCEPT',
    started_monotonic_ms: 300,
    finished_monotonic_ms: 450,
    duration_ms: 150,
  });
}

function usageRecorded(): any {
  return eventOf('USAGE_RECORDED', {
    usage_id: 'usage-1',
    attempt_number: 1,
    role: 'executor',
    binding_ref: 'binding-cheap-v1',
    provider_usage_id: null,
    input_tokens_observed: null,
    output_tokens_observed: null,
    cached_input_tokens_observed: null,
    reasoning_tokens_observed: null,
    input_tokens_estimated: 10,
    output_tokens_estimated: 5,
    cached_input_tokens_estimated: null,
    reasoning_tokens_estimated: null,
    token_estimator_id: 'estimator-v1',
    token_estimator_version: 'v1',
    pricing_snapshot_id: 'pricing-v1',
    cost_observed: null,
    cost_estimated: 20,
    currency: 'EUR',
    cost_provenance: 'ESTIMATED_TARIFF',
    attempt_id: 'attempt-1',
    review_id: null,
    orchestrator_operation_id: null,
  });
}

async function assertBothAccept(schema: string, loader: Loader, value: unknown) {
  const validate = await loadValidator(schema);
  assert.equal(validate(value), true, `AJV rejected valid fixture: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(loader(value), value);
}

async function assertBothReject(schema: string, loader: Loader, value: unknown) {
  const validate = await loadValidator(schema);
  assert.equal(validate(value), false, `AJV accepted invalid fixture: ${JSON.stringify(value)}`);
  assert.throws(() => loader(value), 'Zod accepted invalid fixture');
}

test('all seventeen V3 event discriminants have a valid closed payload in AJV and Zod', async () => {
  const base = { id: 'id-1', hash: hash('6') };
  const events: Array<[string, any]> = [
    ['BLOCK_PLANNED', { planned_block_hash: base.hash }],
    ['ARM_ASSIGNED', { assigned_arm: 'C_ADAPTIVE_EARLY_ESCALATION', assignment_algorithm_version: 'v1' }],
    [
      'ISOLATION_ATTESTED',
      {
        workspace_instance_id: base.id,
        base_revision: base.hash,
        clean_tree_hash: base.hash,
        isolation_status: 'CLEAN',
        observed_tree_hash: base.hash,
        isolation_policy_version: 'v1',
        attestor_id: base.id,
        evidence_hash: base.hash,
      },
    ],
    [
      'EXECUTION_STARTED',
      {
        attempt_id: base.id,
        attempt_number: 1,
        attempt_kind: 'IMPLEMENTATION',
        executor_capability: 'cheap',
        executor_binding_ref: base.id,
        executor_session_id: 'session-1',
        input_revision: base.hash,
        started_monotonic_ms: 0,
      },
    ],
    ['EXECUTION_COMPLETED', event().payload],
    [
      'REVIEW_STARTED',
      {
        review_id: base.id,
        review_round: 1,
        reviewer_binding_ref: base.id,
        reviewer_session_id: 'review-1',
        reviewed_attempt_id: base.id,
        executor_session_id_reviewed: 'session-1',
        started_monotonic_ms: 0,
      },
    ],
    ['REVIEW_COMPLETED', reviewCompleted().payload],
    [
      'VALIDATION_RECORDED',
      {
        validation_id: base.id,
        attempt_id: base.id,
        validation_surface: ['typecheck'],
        passed: true,
        tests_failing: 0,
        tests_passing: 1,
        evidence_hashes: [base.hash],
      },
    ],
    [
      'ORCHESTRATOR_OPERATION_RECORDED',
      { orchestrator_operation_id: 'operation-1', attempt_number: 1, binding_ref: 'binding-strong-v1', evidence_hash: base.hash },
    ],
    ['USAGE_RECORDED', usageRecorded().payload],
    [
      'PARENT_REWORK_RECORDED',
      {
        review_id: base.id,
        attempt_id: base.id,
        files_production: [],
        files_tests: [],
        files_docs: [],
        lines_production: 0,
        lines_tests: 0,
        lines_docs: 0,
        diff_hash: base.hash,
        actor_role: 'human',
        reason_code: base.id,
      },
    ],
    ['BLOCK_ACCEPTED', { accepted_revision: base.hash, accepted_tree_hash: base.hash, accepted_at: timestamp }],
    ['BLOCK_FAILED', { reason_code: base.id, evidence_hash: base.hash }],
    ['BLOCK_BLOCKED', { cause: 'EXTERNAL', reason_code: base.id, evidence_hash: base.hash }],
    [
      'ESCALATION_DECIDED',
      {
        rejected_review_event_id: base.id,
        escalation_reason: base.id,
        target_binding_ref: base.id,
        target_capability: 'strong',
        decision_policy_version: 'v1',
      },
    ],
    [
      'POST_ACCEPT_DEFECT_RECORDED',
      {
        defect_id: base.id,
        severity: 'low',
        material: false,
        discovered_at: timestamp,
        evidence_id: base.id,
        affected_revision: base.hash,
        accepted_review_id: base.id,
        category_code: base.id,
      },
    ],
    ['EVENT_INVALIDATED', { invalidated_event_id: base.id, expected_event_content_hash: base.hash, reason_code: base.id }],
  ];
  const validate = await loadValidator('../contracts/pilot-event-v3.schema.json');
  for (const [event_type, payload] of events) {
    const value = eventOf(event_type, payload);
    assert.equal(validate(value), true, event_type);
    assert.deepEqual(loadPilotEventV3(value), value, event_type);
  }
});

test('orchestrator operation evidence is closed, required, and accepted by the sensitive-content guard', async () => {
  const operation = eventOf('ORCHESTRATOR_OPERATION_RECORDED', {
    orchestrator_operation_id: 'operation-1',
    attempt_number: 1,
    binding_ref: 'binding-strong-v1',
    evidence_hash: hash('7'),
  });
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, operation);
  assert.doesNotThrow(() => assertSafeEvent(operation));

  for (const field of ['orchestrator_operation_id', 'attempt_number', 'binding_ref', 'evidence_hash']) {
    const invalid = structuredClone(operation);
    delete invalid.payload[field];
    await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, invalid);
  }
  const open = structuredClone(operation);
  open.payload.prompt = 'forbidden raw content';
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, open);
  assert.throws(() => assertSafeEvent(open), /prompt|payload|event/i);

  const typedOperation = loadPilotEventV3(operation) as Extract<PilotEventV3, { event_type: 'ORCHESTRATOR_OPERATION_RECORDED' }>;
  // @ts-expect-error ORCHESTRATOR_OPERATION_RECORDED is explicitly non-supersedable.
  const forbiddenTypedSupersession: PilotEventV3 = {
    ...typedOperation,
    supersedes_event_id: 'event-prior',
    expected_superseded_event_content_hash: hash('8'),
  };
  const superseded = {
    ...operation,
    supersedes_event_id: 'event-prior',
    expected_superseded_event_content_hash: hash('8'),
  };
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, superseded);
  void forbiddenTypedSupersession;
});

test('approved Task 4 prerequisite fields remain closed and required in AJV and Zod', async () => {
  const clean = eventOf('ISOLATION_ATTESTED', {
    workspace_instance_id: 'workspace-1',
    base_revision: hash('1'),
    clean_tree_hash: hash('2'),
    isolation_status: 'CLEAN',
    observed_tree_hash: hash('2'),
    isolation_policy_version: 'v1',
    attestor_id: 'attestor-1',
    evidence_hash: hash('3'),
  });
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, {
    ...clean,
    payload: { ...clean.payload, isolation_status: 'UNKNOWN' },
  });
  const execution = event();
  const { tree_reproduction_evidence_hash: _proof, ...withoutProof } = execution.payload;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, { ...execution, payload: withoutProof });
  const defect = eventOf('POST_ACCEPT_DEFECT_RECORDED', {
    defect_id: 'defect-1',
    severity: 'high',
    material: true,
    discovered_at: timestamp,
    evidence_id: 'evidence-1',
    affected_revision: hash('4'),
    accepted_review_id: 'review-1',
    category_code: 'correctness',
  });
  const { accepted_review_id: _review, ...withoutReview } = defect.payload;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, { ...defect, payload: withoutReview });
  const frozen = manifest();
  const { canonical_tree_algorithm_version: _algorithm, ...withoutAlgorithm } = frozen;
  await assertBothReject('../contracts/pilot-manifest-v3.schema.json', loadPilotManifestV3, withoutAlgorithm);
});

test('event envelopes accept only paired supersession references and exclude EVENT_INVALIDATED', async () => {
  const correctingEvent = {
    ...eventOf('BLOCK_PLANNED', { planned_block_hash: hash('7') }),
    supersedes_event_id: 'event-prior',
    expected_superseded_event_content_hash: hash('8'),
  };
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, correctingEvent);

  const missingExpectedHash = { ...correctingEvent };
  delete missingExpectedHash.expected_superseded_event_content_hash;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, missingExpectedHash);

  const missingSupersededId = { ...correctingEvent };
  delete missingSupersededId.supersedes_event_id;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, missingSupersededId);

  const undefinedEnvelope = {
    ...eventOf('BLOCK_PLANNED', { planned_block_hash: hash('7') }),
    supersedes_event_id: undefined,
    expected_superseded_event_content_hash: undefined,
  };
  // `undefined` has no JSON representation, so AJV correctly sees these fields as absent.
  // The TypeScript boundary must still reject own undefined properties before hashing.
  assert.throws(() => loadPilotEventV3(undefinedEnvelope));

  const invalidationWithSupersession = {
    ...eventOf('EVENT_INVALIDATED', {
      invalidated_event_id: 'event-prior',
      expected_event_content_hash: hash('8'),
      reason_code: 'correction',
    }),
    supersedes_event_id: 'event-prior',
    expected_superseded_event_content_hash: hash('8'),
  };
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, invalidationWithSupersession);
});

test('manifest schema enforces only the Task 1 comparative implication and defers triplet/capability checks', async () => {
  const value: any = manifest();
  value.blocks = [
    {
      ...value.blocks[0],
      block_id: 'single-comparative-block',
      pair_or_triplet_id: 'incomplete-triplet',
      selected_executor_capability_initial: 'cheap',
      selected_executor_capability_final_expected: 'cheap',
    },
  ];
  value.arm_assignments = [{ block_id: 'single-comparative-block', pilot_arm: 'A_STRONG_BASELINE' }];
  value.stage_thresholds.min_stratum_triplets_for_promotion = 30;
  await assertBothAccept('../contracts/pilot-manifest-v3.schema.json', loadPilotManifestV3, value);
});

test('routing gate defers comparative threshold arithmetic while preserving the stage sample shape', async () => {
  const value: any = gate();
  value.thresholds.min_stratum_triplets_for_promotion = 30;
  await assertBothAccept('../contracts/pilot-routing-gate-v3.schema.json', loadPilotRoutingGateV3, value);
});

test('Task 7 report and gate amendments accept the complete frozen evaluation envelope in AJV and Zod', async () => {
  const value: any = report();
  value.metrics.by_arm.A_STRONG_BASELINE.wall_time_per_accepted_block.numerator = 10.125;
  value.metrics.paired_comparisons.final_quality = {
    baseline_successes: 0,
    candidate_successes: 0,
    both_success: 0,
    baseline_only_success: 0,
    candidate_only_success: 0,
    neither_success: 0,
    denominator: 0,
    difference: null,
    confidence_interval: null,
  };
  await assertBothAccept('../contracts/pilot-routing-gate-v3.schema.json', loadPilotRoutingGateV3, gate());
  await assertBothAccept('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, value);
});

test('Task 7 contracts reject unpaired supersession and result-dependent branch ordering in AJV and Zod', async () => {
  const missingHash: any = report();
  missingHash.supersedes_evaluation_id = 'evaluation-0';
  missingHash.supersedes_evaluation_version = 1;
  await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, missingHash);

  const reversed: any = report();
  reversed.efficiency_branches = [...reversed.efficiency_branches].reverse();
  await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, reversed);

  const unsafePolicy: any = gate();
  unsafePolicy.strata_policy = [
    {
      matching_stratum: 'systemic-high',
      complexity_class: 'systemic',
      risk_class: 'high',
      promotion_eligible: true,
      exclusion_reason: null,
    },
  ];
  await assertBothReject('../contracts/pilot-routing-gate-v3.schema.json', loadPilotRoutingGateV3, unsafePolicy);
});

test('Task 7 frozen gate policy fields and iteration bounds have AJV and Zod parity', async () => {
  await assertBothAccept('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, report());
  for (const iterations of [99, 100001]) {
    const invalidManifest: any = manifest();
    invalidManifest.stage_thresholds.resampling_iterations = iterations;
    await assertBothReject('../contracts/pilot-manifest-v3.schema.json', loadPilotManifestV3, invalidManifest);
    const invalidGate: any = gate();
    invalidGate.thresholds.resampling_iterations = iterations;
    await assertBothReject('../contracts/pilot-routing-gate-v3.schema.json', loadPilotRoutingGateV3, invalidGate);
  }
  const excessiveManifest: any = manifest();
  excessiveManifest.stage_thresholds.min_stratum_triplets_for_promotion = 31;
  await assertBothReject('../contracts/pilot-manifest-v3.schema.json', loadPilotManifestV3, excessiveManifest);
  const excessiveGate: any = gate();
  excessiveGate.thresholds.min_stratum_triplets_for_promotion = 31;
  await assertBothReject('../contracts/pilot-routing-gate-v3.schema.json', loadPilotRoutingGateV3, excessiveGate);
});

test('Task 7 metric sample kinds quality bounds and report iteration range have AJV and Zod parity', async () => {
  const fractionalRate: any = report();
  fractionalRate.metrics.by_arm.A_STRONG_BASELINE.final_acceptance_rate.numerator = 1.5;
  await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, fractionalRate);

  const qualityOutsideRate: any = report();
  qualityOutsideRate.metrics.paired_comparisons.final_quality.difference = 1.1;
  qualityOutsideRate.metrics.paired_comparisons.final_quality.confidence_interval = { lower: -1.1, upper: 1 };
  await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, qualityOutsideRate);

  const invalidIterations: any = report();
  invalidIterations.interval_metadata.resampling_iterations = 99;
  await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, invalidIterations);

  const fractionalResource: any = report();
  fractionalResource.metrics.by_arm.A_STRONG_BASELINE.wall_time_per_accepted_block.numerator = 10.125;
  await assertBothAccept('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, fractionalResource);
});

test('usage accepts estimated tariff provenance with exactly one owner in AJV and Zod', async () => {
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, usageRecorded());
});

test('usage rejects zero or multiple owners in AJV and Zod', async () => {
  const noOwner = usageRecorded();
  noOwner.payload.attempt_id = null;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, noOwner);

  const multipleOwners = usageRecorded();
  multipleOwners.payload.review_id = 'review-1';
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, multipleOwners);

  const openUsagePayload = usageRecorded();
  openUsagePayload.payload.raw_response = 'forbidden';
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, openUsagePayload);
});

test('usage rejects observed and estimated cost provenance mismatches in AJV and Zod', async () => {
  const estimatedAsObserved = usageRecorded();
  estimatedAsObserved.payload.cost_provenance = 'TARIFF_REPRODUCED';
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, estimatedAsObserved);

  const observedAsEstimated = usageRecorded();
  observedAsEstimated.payload.cost_observed = 20;
  observedAsEstimated.payload.cost_estimated = null;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, observedAsEstimated);

  const unnamedEstimate = usageRecorded();
  unnamedEstimate.payload.cost_provenance = 'TARIFF_REPRODUCED';
  unnamedEstimate.payload.cost_estimated = null;
  unnamedEstimate.payload.token_estimator_id = null;
  unnamedEstimate.payload.token_estimator_version = null;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, unnamedEstimate);

  const unreproducibleObservedCost = usageRecorded();
  unreproducibleObservedCost.payload.cost_provenance = 'TARIFF_REPRODUCED';
  unreproducibleObservedCost.payload.cost_estimated = null;
  unreproducibleObservedCost.payload.cost_observed = 20;
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, unreproducibleObservedCost);
});

test('execution and review durations accept arbitrary nonnegative values for Task 4 arithmetic validation', async () => {
  const execution = event();
  execution.payload.started_monotonic_ms = 100;
  execution.payload.finished_monotonic_ms = 200;
  execution.payload.duration_ms = 99;
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, execution);

  const review = reviewCompleted();
  review.payload.started_monotonic_ms = 7;
  review.payload.finished_monotonic_ms = 9;
  review.payload.duration_ms = 500;
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, review);
});

test('Task 6 observation economics and fractional duration fields have AJV/Zod parity', async () => {
  const value: any = observation();
  await assertBothAccept('../contracts/pilot-block-observation-v3.schema.json', loadPilotBlockObservationV3, value);

  const legacy = structuredClone(value);
  delete legacy.cost_observed_completeness;
  legacy.cost_completeness = 0;
  await assertBothReject('../contracts/pilot-block-observation-v3.schema.json', loadPilotBlockObservationV3, legacy);

  for (const field of ['strong_tokens_observed', 'strong_tokens_estimated', 'cost_estimated_completeness']) {
    const missing = structuredClone(value);
    delete missing[field];
    await assertBothReject('../contracts/pilot-block-observation-v3.schema.json', loadPilotBlockObservationV3, missing);
  }

  for (const invalidSeconds of [-0.001, Number.POSITIVE_INFINITY, Number.NaN]) {
    const invalid = { ...value, executor_time_seconds: invalidSeconds };
    await assertBothReject('../contracts/pilot-block-observation-v3.schema.json', loadPilotBlockObservationV3, invalid);
  }
});

test('Task 6 validation test-count evidence is closed and required in AJV and Zod', async () => {
  const validation = eventOf('VALIDATION_RECORDED', {
    validation_id: 'validation-1',
    attempt_id: 'attempt-1',
    validation_surface: ['typecheck'],
    passed: false,
    tests_failing: 2,
    tests_passing: 7,
    evidence_hashes: [hash('6')],
  });
  await assertBothAccept('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, validation);

  for (const field of ['tests_failing', 'tests_passing']) {
    const missing = structuredClone(validation);
    delete missing.payload[field];
    await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, missing);
  }
  await assertBothReject('../contracts/pilot-event-v3.schema.json', loadPilotEventV3, {
    ...validation,
    payload: { ...validation.payload, tests_failing: -1 },
  });
});

test('every normative READY observation state is accepted in AJV and Zod', async () => {
  for (const state of [
    'READY_1',
    'READY_REVIEW_1',
    'READY_2',
    'READY_REVIEW_2',
    'READY_3',
    'READY_FINAL_REVIEW',
    'READY_ACCEPT',
    'READY_FAIL',
  ]) {
    const value: any = observation();
    value.state = state;
    value.final_outcome = 'FAILED';
    value.final_accepted = false;
    value.first_pass_accept = false;
    value.accept_after_one_repair = false;
    value.post_acceptance_window_closed = false;
    value.accepted_at = null;
    value.window_opens_at = null;
    value.window_closes_at = null;
    await assertBothAccept('../contracts/pilot-block-observation-v3.schema.json', loadPilotBlockObservationV3, value);
  }
});

test('evaluation report accepts the complete stage/decision matrix and rejects every illegal pair', async () => {
  const allowed = new Map<number, string[]>([
    [1, ['CONTINUE', 'REJECT']],
    [2, ['CONTINUE', 'PROMOTE_BOUNDED', 'REJECT', 'INSUFFICIENT_EVIDENCE']],
    [3, ['PROMOTE_BOUNDED', 'REJECT', 'INCONCLUSIVE']],
  ]);
  const decisions = ['CONTINUE', 'PROMOTE_BOUNDED', 'REJECT', 'INCONCLUSIVE', 'INSUFFICIENT_EVIDENCE'];
  for (const stage of [1, 2, 3]) {
    for (const decision of decisions) {
      const value: any = report();
      value.stage = stage;
      value.decision = decision;
      value.promoted_strata = decision === 'PROMOTE_BOUNDED' ? ['mechanical-low'] : [];
      if (allowed.get(stage)?.includes(decision)) {
        await assertBothAccept('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, value);
      } else {
        await assertBothReject('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, value);
      }
    }
  }
});

test('evaluation exclusions preserve unknown member wall time as incomplete resource evidence', async () => {
  const value: any = report();
  await assertBothAccept('../contracts/pilot-evaluation-report-v3.schema.json', loadPilotEvaluationReportV3, value);
  assert.deepEqual(value.exclusions[0].members_by_arm.C_ADAPTIVE_EARLY_ESCALATION.resources.wall_time_seconds, {
    known_sum: 0,
    complete: 0,
    total: 1,
    completeness_ratio: 0,
    complete_value: null,
  });
});
