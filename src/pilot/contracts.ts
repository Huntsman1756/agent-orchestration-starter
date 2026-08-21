import { z } from 'zod';

const MAX_ARRAY_ITEMS = 128;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const resamplingIterations = z.number().int().min(100).max(100000);
const nonnegativeNumber = z.number().nonnegative();
const finiteNonnegativeNumber = z.number().finite().nonnegative();
const rate = z.number().min(0).max(1);
const positiveRate = z.number().gt(0).max(1);

function boundedArray<T extends z.ZodType>(item: T) {
  return z.array(item).max(MAX_ARRAY_ITEMS);
}

const capabilityClass = z.enum(['cheap', 'strong']);
const pilotArm = z.enum(['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION']);
const complexityClass = z.enum(['mechanical', 'localized', 'cross_file_bounded', 'systemic']);
const riskClass = z.enum(['low', 'medium', 'high', 'restricted']);
const comparativeRiskClass = z.enum(['low', 'medium', 'high']);
const severity = z.enum(['low', 'medium', 'high', 'critical']);

export const bindingV3Schema = z
  .object({
    binding_ref: identifier,
    capability_class: capabilityClass,
    profile_hash: hash,
  })
  .strict();

const stageThresholdsSchema = z
  .object({
    stage_1_blocks_per_arm: z.literal(10),
    stage_2_blocks_per_arm: z.literal(20),
    stage_3_max_blocks_per_arm: z.literal(30),
    material_improvement_rate: rate,
    economic_rejection_rate: rate,
    max_parent_rework_block_rate: rate,
    max_parent_rework_production_line_share: rate,
    max_escaped_material_defects: nonnegativeInteger,
    max_escaped_high_defects: nonnegativeInteger,
    max_escaped_critical_defects: nonnegativeInteger,
    min_observed_cost_completeness: positiveRate,
    min_observed_strong_token_completeness: positiveRate,
    min_stratum_triplets_for_promotion: positiveInteger.max(30),
    confidence_level: z.number().gt(0).lt(1),
    interval_algorithm_version: identifier,
    resampling_iterations: resamplingIterations,
  })
  .strict();

const postAcceptanceWindowSchema = z
  .object({
    duration_seconds: positiveInteger,
    allowed_clock_skew_seconds: nonnegativeInteger,
    closure_rule: z.enum(['elapsed_duration', 'terminal_material_defect']),
    late_evidence_policy: z.literal('warn_next_evaluation'),
    window_policy_version: identifier,
  })
  .strict();

export const pricingSnapshotV3Schema = z
  .object({
    pricing_snapshot_id: identifier,
    pricing_snapshot_hash: hash,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/),
    unit_scale: positiveInteger,
    effective_at: timestamp,
    tariffs: boundedArray(
      z
        .object({
          binding_ref: identifier,
          input_token_micro_units_per_token: nonnegativeInteger,
          output_token_micro_units_per_token: nonnegativeInteger,
          cached_input_token_micro_units_per_token: nonnegativeInteger.nullable(),
          reasoning_token_micro_units_per_token: nonnegativeInteger.nullable(),
          authoritative_charge_supported: z.boolean(),
        })
        .strict(),
    ).min(1),
  })
  .strict();

const manifestBlockBase = z
  .object({
    block_id: identifier,
    task_id: identifier,
    matching_stratum: identifier,
    pair_or_triplet_id: identifier,
    case_fingerprint: hash,
    contract_hash: hash,
    base_revision: hash,
    clean_tree_hash: hash,
    fixtures_hash: hash,
    complexity_class: complexityClass,
    risk_class: riskClass,
    changed_line_band: identifier,
    validation_surface: boundedArray(identifier).min(1),
    cheap_eligible: z.boolean(),
    routing_selection_reason: identifier,
    selected_executor_capability_initial: capabilityClass,
    selected_executor_capability_final_expected: capabilityClass,
    exclusion_reason: identifier.nullable(),
  })
  .strict();

const manifestBlockSchema = z.discriminatedUnion('comparative_eligible', [
  manifestBlockBase.extend({
    comparative_eligible: z.literal(true),
    cheap_eligible: z.literal(true),
    risk_class: comparativeRiskClass,
    exclusion_reason: z.null(),
  }),
  manifestBlockBase.extend({ comparative_eligible: z.literal(false) }),
]);

export const pilotManifestV3Schema = z
  .object({
    pilot_id: identifier,
    pilot_schema_version: z.literal(3),
    manifest_hash: hash,
    created_at: timestamp,
    blocks: boundedArray(manifestBlockSchema).min(1),
    assignment_seed: identifier,
    assignment_algorithm_version: identifier,
    arm_assignments: boundedArray(z.object({ block_id: identifier, pilot_arm: pilotArm }).strict()).min(1),
    binding_policy_version: identifier,
    binding_registry: boundedArray(bindingV3Schema).min(1),
    routing_reviewer_binding_ref: identifier,
    routing_reviewer_capability: capabilityClass,
    review_mode: z.literal('incremental_diff'),
    routing_policy_version: identifier,
    review_policy_version: identifier,
    state_machine_version: identifier,
    reducer_version: identifier,
    isolation_policy_version: identifier,
    canonical_tree_algorithm_version: identifier,
    volatile_paths_policy_hash: hash,
    stage_thresholds: stageThresholdsSchema,
    post_acceptance_window: postAcceptanceWindowSchema,
    pricing_snapshot: pricingSnapshotV3Schema,
  })
  .strict();

const eventBase = {
  schema_version: z.literal(3),
  event_id: identifier,
  pilot_id: identifier,
  manifest_hash: hash,
  task_id: identifier,
  block_id: identifier,
  matching_stratum: identifier,
  pair_or_triplet_id: identifier,
  case_fingerprint: hash,
  pilot_arm: pilotArm.nullable(),
  sequence_number: positiveInteger,
  occurred_at: timestamp,
  recorded_at: timestamp,
  producer_id: identifier,
};

const supersession = {
  supersedes_event_id: identifier,
  expected_superseded_event_content_hash: hash,
};

const executionPayload = z
  .object({
    attempt_id: identifier,
    attempt_number: positiveInteger,
    attempt_kind: z.enum(['IMPLEMENTATION', 'REPAIR_1', 'FINAL_EXECUTION']),
    executor_capability: capabilityClass,
    executor_binding_ref: identifier,
    executor_session_id: identifier,
    input_revision: hash,
    output_revision: hash,
    output_tree_hash: hash,
    output_diff_hash: hash,
    canonical_tree_algorithm_version: identifier,
    volatile_paths_policy_hash: hash,
    tree_reproduced: z.boolean(),
    tree_reproduction_evidence_hash: hash,
    changed_lines_production: nonnegativeInteger,
    changed_lines_tests: nonnegativeInteger,
    changed_lines_docs: nonnegativeInteger,
    outcome: z.literal('COMPLETED'),
    started_monotonic_ms: nonnegativeInteger,
    finished_monotonic_ms: nonnegativeInteger,
    duration_ms: nonnegativeInteger,
  })
  .strict();

const findingSchema = z
  .object({
    finding_id: identifier,
    severity,
    material: z.boolean(),
    category_code: identifier,
    status: z.enum(['OPEN', 'RESOLVED']),
    evidence_hashes: boundedArray(hash).min(1),
  })
  .strict();

const reviewPayload = z
  .object({
    review_id: identifier,
    review_round: positiveInteger,
    reviewer_binding_ref: identifier,
    reviewer_session_id: identifier,
    reviewed_attempt_id: identifier,
    executor_session_id_reviewed: identifier,
    review_input_diff_hash: hash,
    previous_review_boundary_hash: hash.nullable(),
    review_boundary_hash: hash,
    review_boundary_from_revision: hash,
    review_boundary_to_revision: hash,
    unresolved_finding_ids: boundedArray(identifier),
    validation_evidence_hashes: boundedArray(hash),
    bounded_context_hashes: boundedArray(hash),
    additional_context_requests: boundedArray(z.enum(['VALIDATION_EVIDENCE', 'BOUNDARY_HASH', 'USAGE_RECORD'])),
    material_findings: boundedArray(findingSchema),
    non_material_findings: boundedArray(findingSchema),
    decision: z.enum(['ACCEPT', 'REJECT']),
    started_monotonic_ms: nonnegativeInteger,
    finished_monotonic_ms: nonnegativeInteger,
    duration_ms: nonnegativeInteger,
  })
  .strict();

const usagePayloadBaseShape = {
  usage_id: identifier,
  attempt_number: positiveInteger,
  role: z.enum(['orchestrator', 'executor', 'reviewer']),
  binding_ref: identifier,
  provider_usage_id: identifier.nullable(),
  input_tokens_observed: nonnegativeInteger.nullable(),
  output_tokens_observed: nonnegativeInteger.nullable(),
  cached_input_tokens_observed: nonnegativeInteger.nullable(),
  reasoning_tokens_observed: nonnegativeInteger.nullable(),
  input_tokens_estimated: nonnegativeInteger.nullable(),
  output_tokens_estimated: nonnegativeInteger.nullable(),
  cached_input_tokens_estimated: nonnegativeInteger.nullable(),
  reasoning_tokens_estimated: nonnegativeInteger.nullable(),
  token_estimator_id: identifier.nullable(),
  token_estimator_version: identifier.nullable(),
  pricing_snapshot_id: identifier,
  cost_observed: nonnegativeInteger.nullable(),
  cost_estimated: nonnegativeInteger.nullable(),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/),
  cost_provenance: z.enum(['TARIFF_REPRODUCED', 'AUTHORITATIVE_BILL', 'ESTIMATED_TARIFF']),
  attempt_id: identifier.nullable(),
  review_id: identifier.nullable(),
  orchestrator_operation_id: identifier.nullable(),
};
const usagePayloadBaseSchema = z.object(usagePayloadBaseShape).strict();
type UsagePayloadV3 = z.infer<typeof usagePayloadBaseSchema>;

const usageOwnerShapes = [
  { attempt_id: identifier, review_id: z.null(), orchestrator_operation_id: z.null() },
  { attempt_id: z.null(), review_id: identifier, orchestrator_operation_id: z.null() },
  { attempt_id: z.null(), review_id: z.null(), orchestrator_operation_id: identifier },
];
const usageObservedCostShapes = [
  { cost_provenance: z.literal('TARIFF_REPRODUCED'), cost_observed: z.null(), cost_estimated: z.null() },
  {
    cost_provenance: z.literal('TARIFF_REPRODUCED'),
    cost_observed: nonnegativeInteger,
    cost_estimated: z.null(),
    input_tokens_observed: nonnegativeInteger,
    output_tokens_observed: nonnegativeInteger,
  },
  {
    cost_provenance: z.literal('AUTHORITATIVE_BILL'),
    provider_usage_id: identifier,
    cost_observed: nonnegativeInteger,
    cost_estimated: z.null(),
  },
];
const usageEstimatorShapes = [
  {
    input_tokens_estimated: z.null(),
    output_tokens_estimated: z.null(),
    cached_input_tokens_estimated: z.null(),
    reasoning_tokens_estimated: z.null(),
    token_estimator_id: z.null(),
    token_estimator_version: z.null(),
  },
  { input_tokens_estimated: nonnegativeInteger, token_estimator_id: identifier, token_estimator_version: identifier },
  {
    input_tokens_estimated: z.null(),
    output_tokens_estimated: nonnegativeInteger,
    token_estimator_id: identifier,
    token_estimator_version: identifier,
  },
  {
    input_tokens_estimated: z.null(),
    output_tokens_estimated: z.null(),
    cached_input_tokens_estimated: nonnegativeInteger,
    token_estimator_id: identifier,
    token_estimator_version: identifier,
  },
  {
    input_tokens_estimated: z.null(),
    output_tokens_estimated: z.null(),
    cached_input_tokens_estimated: z.null(),
    reasoning_tokens_estimated: nonnegativeInteger,
    token_estimator_id: identifier,
    token_estimator_version: identifier,
  },
];
const estimatedTariffShape = {
  cost_provenance: z.literal('ESTIMATED_TARIFF'),
  input_tokens_estimated: nonnegativeInteger,
  output_tokens_estimated: nonnegativeInteger,
  token_estimator_id: identifier,
  token_estimator_version: identifier,
  cost_observed: z.null(),
  cost_estimated: nonnegativeInteger,
};
const usagePayloadVariants = usageOwnerShapes.flatMap((owner) => [
  ...usageObservedCostShapes.flatMap((cost) =>
    usageEstimatorShapes.map((estimator) => z.object({ ...usagePayloadBaseShape, ...owner, ...cost, ...estimator }).strict()),
  ),
  z.object({ ...usagePayloadBaseShape, ...owner, ...estimatedTariffShape }).strict(),
]);
export const usageRecordedV3Schema = z.union(
  usagePayloadVariants as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
) as z.ZodType<UsagePayloadV3>;

type PilotArmV3 = 'A_STRONG_BASELINE' | 'B_CHEAP_NO_EARLY_ESCALATION' | 'C_ADAPTIVE_EARLY_ESCALATION';
type PilotEventBaseV3 = {
  schema_version: 3;
  event_id: string;
  pilot_id: string;
  manifest_hash: string;
  task_id: string;
  block_id: string;
  matching_stratum: string;
  pair_or_triplet_id: string;
  case_fingerprint: string;
  pilot_arm: PilotArmV3 | null;
  sequence_number: number;
  occurred_at: string;
  recorded_at: string;
  producer_id: string;
};
type PilotEventPayloadMapV3 = {
  BLOCK_PLANNED: { planned_block_hash: string };
  ARM_ASSIGNED: { assigned_arm: PilotArmV3; assignment_algorithm_version: string };
  ISOLATION_ATTESTED: {
    workspace_instance_id: string;
    base_revision: string;
    clean_tree_hash: string;
    isolation_status: 'CLEAN' | 'CONTAMINATED';
    observed_tree_hash: string;
    isolation_policy_version: string;
    attestor_id: string;
    evidence_hash: string;
  };
  EXECUTION_STARTED: {
    attempt_id: string;
    attempt_number: number;
    attempt_kind: 'IMPLEMENTATION' | 'REPAIR_1' | 'FINAL_EXECUTION';
    executor_capability: 'cheap' | 'strong';
    executor_binding_ref: string;
    executor_session_id: string;
    input_revision: string;
    started_monotonic_ms: number;
  };
  EXECUTION_COMPLETED: z.infer<typeof executionPayload>;
  REVIEW_STARTED: {
    review_id: string;
    review_round: number;
    reviewer_binding_ref: string;
    reviewer_session_id: string;
    reviewed_attempt_id: string;
    executor_session_id_reviewed: string;
    started_monotonic_ms: number;
  };
  REVIEW_COMPLETED: z.infer<typeof reviewPayload>;
  VALIDATION_RECORDED: {
    validation_id: string;
    attempt_id: string;
    validation_surface: string[];
    passed: boolean;
    tests_failing: number;
    tests_passing: number;
    evidence_hashes: string[];
  };
  ORCHESTRATOR_OPERATION_RECORDED: {
    orchestrator_operation_id: string;
    attempt_number: number;
    binding_ref: string;
    evidence_hash: string;
  };
  USAGE_RECORDED: UsagePayloadV3;
  PARENT_REWORK_RECORDED: {
    review_id: string;
    attempt_id: string;
    files_production: string[];
    files_tests: string[];
    files_docs: string[];
    lines_production: number;
    lines_tests: number;
    lines_docs: number;
    diff_hash: string;
    actor_role: 'orchestrator' | 'reviewer' | 'human';
    reason_code: string;
  };
  BLOCK_ACCEPTED: { accepted_revision: string; accepted_tree_hash: string; accepted_at: string };
  BLOCK_FAILED: { reason_code: string; evidence_hash: string };
  BLOCK_BLOCKED: { cause: 'EXTERNAL' | 'ENVIRONMENTAL'; reason_code: string; evidence_hash: string };
  ESCALATION_DECIDED: {
    rejected_review_event_id: string;
    escalation_reason: string;
    target_binding_ref: string;
    target_capability: 'strong';
    decision_policy_version: string;
  };
  POST_ACCEPT_DEFECT_RECORDED: {
    defect_id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    material: boolean;
    discovered_at: string;
    evidence_id: string;
    affected_revision: string;
    accepted_review_id: string;
    category_code: string;
  };
  EVENT_INVALIDATED: { invalidated_event_id: string; expected_event_content_hash: string; reason_code: string };
};
type NoSupersessionV3 = { supersedes_event_id?: never; expected_superseded_event_content_hash?: never };
type SupersessionV3 = { supersedes_event_id: string; expected_superseded_event_content_hash: string };
type EventFor<K extends keyof PilotEventPayloadMapV3> = PilotEventBaseV3 & {
  event_type: K;
  payload: PilotEventPayloadMapV3[K];
} & (K extends 'EVENT_INVALIDATED' | 'ORCHESTRATOR_OPERATION_RECORDED' ? NoSupersessionV3 : NoSupersessionV3 | SupersessionV3);
export type PilotEventV3 = { [K in keyof PilotEventPayloadMapV3]: EventFor<K> }[keyof PilotEventPayloadMapV3];

function event<T extends z.ZodType>(event_type: string, payload: T, allowsSupersession = true): readonly z.ZodType[] {
  const withoutSupersession = z.object({ ...eventBase, event_type: z.literal(event_type), payload }).strict();
  if (!allowsSupersession) return [withoutSupersession] as const;
  return [withoutSupersession, z.object({ ...eventBase, ...supersession, event_type: z.literal(event_type), payload }).strict()] as const;
}

const pilotEventVariants = [
  ...event('BLOCK_PLANNED', z.object({ planned_block_hash: hash }).strict()),
  ...event('ARM_ASSIGNED', z.object({ assigned_arm: pilotArm, assignment_algorithm_version: identifier }).strict()),
  ...event(
    'ISOLATION_ATTESTED',
    z
      .object({
        workspace_instance_id: identifier,
        base_revision: hash,
        clean_tree_hash: hash,
        isolation_status: z.enum(['CLEAN', 'CONTAMINATED']),
        observed_tree_hash: hash,
        isolation_policy_version: identifier,
        attestor_id: identifier,
        evidence_hash: hash,
      })
      .strict(),
  ),
  ...event(
    'EXECUTION_STARTED',
    z
      .object({
        attempt_id: identifier,
        attempt_number: positiveInteger,
        attempt_kind: z.enum(['IMPLEMENTATION', 'REPAIR_1', 'FINAL_EXECUTION']),
        executor_capability: capabilityClass,
        executor_binding_ref: identifier,
        executor_session_id: identifier,
        input_revision: hash,
        started_monotonic_ms: nonnegativeInteger,
      })
      .strict(),
  ),
  ...event('EXECUTION_COMPLETED', executionPayload),
  ...event(
    'REVIEW_STARTED',
    z
      .object({
        review_id: identifier,
        review_round: positiveInteger,
        reviewer_binding_ref: identifier,
        reviewer_session_id: identifier,
        reviewed_attempt_id: identifier,
        executor_session_id_reviewed: identifier,
        started_monotonic_ms: nonnegativeInteger,
      })
      .strict(),
  ),
  ...event('REVIEW_COMPLETED', reviewPayload),
  ...event(
    'VALIDATION_RECORDED',
    z
      .object({
        validation_id: identifier,
        attempt_id: identifier,
        validation_surface: boundedArray(identifier).min(1),
        passed: z.boolean(),
        tests_failing: nonnegativeInteger,
        tests_passing: nonnegativeInteger,
        evidence_hashes: boundedArray(hash).min(1),
      })
      .strict(),
  ),
  ...event(
    'ORCHESTRATOR_OPERATION_RECORDED',
    z
      .object({ orchestrator_operation_id: identifier, attempt_number: positiveInteger, binding_ref: identifier, evidence_hash: hash })
      .strict(),
    false,
  ),
  ...event('USAGE_RECORDED', usageRecordedV3Schema),
  ...event(
    'PARENT_REWORK_RECORDED',
    z
      .object({
        review_id: identifier,
        attempt_id: identifier,
        files_production: boundedArray(identifier),
        files_tests: boundedArray(identifier),
        files_docs: boundedArray(identifier),
        lines_production: nonnegativeInteger,
        lines_tests: nonnegativeInteger,
        lines_docs: nonnegativeInteger,
        diff_hash: hash,
        actor_role: z.enum(['orchestrator', 'reviewer', 'human']),
        reason_code: identifier,
      })
      .strict(),
  ),
  ...event('BLOCK_ACCEPTED', z.object({ accepted_revision: hash, accepted_tree_hash: hash, accepted_at: timestamp }).strict()),
  ...event('BLOCK_FAILED', z.object({ reason_code: identifier, evidence_hash: hash }).strict()),
  ...event(
    'BLOCK_BLOCKED',
    z.object({ cause: z.enum(['EXTERNAL', 'ENVIRONMENTAL']), reason_code: identifier, evidence_hash: hash }).strict(),
  ),
  ...event(
    'ESCALATION_DECIDED',
    z
      .object({
        rejected_review_event_id: identifier,
        escalation_reason: identifier,
        target_binding_ref: identifier,
        target_capability: z.literal('strong'),
        decision_policy_version: identifier,
      })
      .strict(),
  ),
  ...event(
    'POST_ACCEPT_DEFECT_RECORDED',
    z
      .object({
        defect_id: identifier,
        severity,
        material: z.boolean(),
        discovered_at: timestamp,
        evidence_id: identifier,
        affected_revision: hash,
        accepted_review_id: identifier,
        category_code: identifier,
      })
      .strict(),
  ),
  ...event(
    'EVENT_INVALIDATED',
    z.object({ invalidated_event_id: identifier, expected_event_content_hash: hash, reason_code: identifier }).strict(),
    false,
  ),
] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]];

export const pilotEventV3Schema: z.ZodType<PilotEventV3> = z.union(pilotEventVariants) as z.ZodType<PilotEventV3>;

const usageSummarySchema = z
  .object({
    operations: nonnegativeInteger,
    observed_tokens: nonnegativeInteger.nullable(),
    estimated_tokens: nonnegativeInteger.nullable(),
  })
  .strict();
const aggregateMeasureSchema = z
  .object({
    value: nonnegativeInteger.nullable(),
    complete: nonnegativeInteger,
    total: nonnegativeInteger,
    completeness_ratio: rate,
  })
  .strict();
const strongTokenAggregateSchema = z
  .object({
    input: aggregateMeasureSchema,
    output: aggregateMeasureSchema,
    cached_input: aggregateMeasureSchema,
    reasoning: aggregateMeasureSchema,
    total: aggregateMeasureSchema,
  })
  .strict();
const postAcceptDefectSchema = z
  .object({
    defect_id: identifier,
    severity,
    material: z.boolean(),
    discovered_at: timestamp,
    evidence_id: identifier,
    affected_revision: hash,
    category_code: identifier,
  })
  .strict();

const observationBaseShape = {
  schema_version: z.literal(3),
  pilot_id: identifier,
  manifest_hash: hash,
  task_id: identifier,
  block_id: identifier,
  matching_stratum: identifier,
  pair_or_triplet_id: identifier,
  case_fingerprint: hash,
  pilot_arm: pilotArm.nullable(),
  complexity_class: complexityClass,
  risk_class: riskClass,
  changed_line_band: identifier,
  cheap_eligible: z.boolean(),
  comparative_eligible: z.boolean(),
  state: z.enum([
    'PLANNED',
    'ASSIGNED',
    'READY_1',
    'EXECUTING_1',
    'READY_REVIEW_1',
    'REVIEWING_1',
    'READY_2',
    'EXECUTING_2',
    'READY_REVIEW_2',
    'REVIEWING_2',
    'ESCALATION_REQUIRED',
    'READY_3',
    'EXECUTING_3',
    'READY_FINAL_REVIEW',
    'FINAL_REVIEWING',
    'READY_ACCEPT',
    'READY_FAIL',
    'ACCEPTED',
    'FAILED',
    'BLOCKED',
    'INVALID',
  ]),
  valid_history: z.boolean(),
  invalid_reason_codes: boundedArray(identifier),
  executor_binding_initial: identifier.nullable(),
  executor_binding_final: identifier.nullable(),
  reviewer_binding_refs: boundedArray(identifier),
  execution_attempts: nonnegativeInteger.max(3),
  repair_rounds: nonnegativeInteger.max(1),
  escalated: z.boolean(),
  escalation_reason: identifier.nullable(),
  first_pass_accept: z.boolean(),
  accept_after_one_repair: z.boolean(),
  final_accepted: z.boolean(),
  tests_initially_failing: nonnegativeInteger,
  tests_finally_passing: nonnegativeInteger,
  review_findings_material: nonnegativeInteger,
  review_findings_non_material: nonnegativeInteger,
  parent_rework_files: z.object({ production: nonnegativeInteger, tests: nonnegativeInteger, docs: nonnegativeInteger }).strict(),
  parent_rework_lines_production: nonnegativeInteger,
  parent_rework_lines_tests: nonnegativeInteger,
  parent_rework_lines_docs: nonnegativeInteger,
  changed_lines_production: nonnegativeInteger,
  changed_lines_tests: nonnegativeInteger,
  changed_lines_docs: nonnegativeInteger,
  orchestrator_usage: usageSummarySchema,
  executor_usage: usageSummarySchema,
  reviewer_usage: usageSummarySchema,
  total_usage: usageSummarySchema,
  cost_observed: nonnegativeInteger.nullable(),
  cost_estimated: nonnegativeInteger.nullable(),
  cost_observed_completeness: rate,
  cost_estimated_completeness: rate,
  strong_tokens_observed: strongTokenAggregateSchema,
  strong_tokens_estimated: strongTokenAggregateSchema,
  wall_time_seconds: finiteNonnegativeNumber.nullable(),
  executor_time_seconds: finiteNonnegativeNumber.nullable(),
  review_time_seconds: finiteNonnegativeNumber.nullable(),
  blocked_cause: z.enum(['EXTERNAL', 'ENVIRONMENTAL']).nullable(),
  blocked_reason_code: identifier.nullable(),
  post_acceptance_window_closed: z.boolean(),
  accepted_at: timestamp.nullable(),
  window_opens_at: timestamp.nullable(),
  window_closes_at: timestamp.nullable(),
  post_accept_defects: boundedArray(postAcceptDefectSchema),
  post_accept_defects_count: nonnegativeInteger,
  post_accept_max_severity: severity.nullable(),
  late_quality_evidence_count: nonnegativeInteger,
  quality_warnings: boundedArray(identifier),
  final_outcome: z.enum(['ACCEPTED', 'FAILED', 'BLOCKED', 'INVALID']),
};
const observationBaseSchema = z.object(observationBaseShape).strict();
type PilotBlockObservationShapeV3 = z.infer<typeof observationBaseSchema>;

const observationEscalationShapes = [
  { escalated: z.literal(true), escalation_reason: identifier },
  { escalated: z.literal(false), escalation_reason: z.null() },
];
const acceptedObservationOutcome = {
  final_outcome: z.literal('ACCEPTED'),
  final_accepted: z.literal(true),
  valid_history: z.literal(true),
  state: z.literal('ACCEPTED'),
  blocked_cause: z.null(),
  blocked_reason_code: z.null(),
};
const acceptedObservationCumulativeShapes = [
  { first_pass_accept: z.literal(true), accept_after_one_repair: z.literal(true) },
  { first_pass_accept: z.literal(false), accept_after_one_repair: z.literal(true) },
  { first_pass_accept: z.literal(false), accept_after_one_repair: z.literal(false) },
];
const acceptedObservationWindowShapes = [
  { post_acceptance_window_closed: z.literal(true), accepted_at: timestamp, window_opens_at: timestamp, window_closes_at: timestamp },
  { post_acceptance_window_closed: z.literal(false) },
];
const nonAcceptedObservationOutcome = {
  final_outcome: z.enum(['FAILED', 'INVALID']),
  final_accepted: z.literal(false),
  first_pass_accept: z.literal(false),
  accept_after_one_repair: z.literal(false),
  blocked_cause: z.null(),
  blocked_reason_code: z.null(),
};
const blockedObservationOutcome = {
  final_outcome: z.literal('BLOCKED'),
  final_accepted: z.literal(false),
  first_pass_accept: z.literal(false),
  accept_after_one_repair: z.literal(false),
  blocked_cause: z.enum(['EXTERNAL', 'ENVIRONMENTAL']),
  blocked_reason_code: identifier,
};
const nonAcceptedObservationWindowShapes = [
  { post_acceptance_window_closed: z.literal(true) },
  { post_acceptance_window_closed: z.literal(false) },
];
const observationVariants = [
  ...observationEscalationShapes.flatMap((escalation) =>
    acceptedObservationCumulativeShapes.flatMap((cumulative) =>
      acceptedObservationWindowShapes.map((window) =>
        z.object({ ...observationBaseShape, ...acceptedObservationOutcome, ...escalation, ...cumulative, ...window }).strict(),
      ),
    ),
  ),
  ...observationEscalationShapes.flatMap((escalation) =>
    nonAcceptedObservationWindowShapes.map((window) =>
      z.object({ ...observationBaseShape, ...nonAcceptedObservationOutcome, ...escalation, ...window }).strict(),
    ),
  ),
  ...observationEscalationShapes.flatMap((escalation) =>
    nonAcceptedObservationWindowShapes.map((window) =>
      z.object({ ...observationBaseShape, ...blockedObservationOutcome, ...escalation, ...window }).strict(),
    ),
  ),
];

export const pilotBlockObservationV3Schema = z
  .union(observationVariants as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  .superRefine((value, context) => {
    const observation = value as PilotBlockObservationShapeV3;
    if (observation.pilot_arm === null && observation.comparative_eligible)
      context.addIssue({ code: 'custom', message: 'null pilot arm requires non-comparative observation' });
  }) as z.ZodType<PilotBlockObservationShapeV3>;

function gateThresholdsSchema(minimumBlocksPerArm: 10 | 20 | 30) {
  return z
    .object({
      minimum_blocks_per_arm: z.literal(minimumBlocksPerArm),
      material_improvement_rate: rate,
      economic_rejection_rate: rate,
      max_parent_rework_block_rate: rate,
      max_parent_rework_production_line_share: rate,
      max_escaped_material_defects: nonnegativeInteger,
      max_escaped_high_defects: nonnegativeInteger,
      max_escaped_critical_defects: nonnegativeInteger,
      min_observed_cost_completeness: positiveRate,
      min_observed_strong_token_completeness: positiveRate,
      min_stratum_triplets_for_promotion: positiveInteger.max(30),
      confidence_level: z.number().gt(0).lt(1),
      interval_algorithm_version: z.literal('paired-bootstrap-sha256-counter-v1'),
      resampling_iterations: resamplingIterations,
    })
    .strict();
}

const strataPolicyBase = {
  matching_stratum: identifier,
  complexity_class: complexityClass,
  risk_class: riskClass,
};
const strataPolicySchema = z.union([
  z
    .object({
      ...strataPolicyBase,
      complexity_class: z.enum(['mechanical', 'localized', 'cross_file_bounded']),
      risk_class: z.enum(['low', 'medium']),
      promotion_eligible: z.literal(true),
      exclusion_reason: z.null(),
    })
    .strict(),
  z
    .object({
      ...strataPolicyBase,
      promotion_eligible: z.literal(false),
      exclusion_reason: identifier,
    })
    .strict(),
]);

const routingGateBase = {
  schema_version: z.literal(3),
  gate_policy_id: identifier,
  pilot_id: identifier,
  manifest_hash: hash,
  evaluated_at: timestamp,
  resampling_seed: identifier,
  strata_policy: boundedArray(strataPolicySchema).min(1),
};

export const pilotRoutingGateV3Schema = z.discriminatedUnion('stage', [
  z.object({ ...routingGateBase, stage: z.literal(1), thresholds: gateThresholdsSchema(10) }).strict(),
  z.object({ ...routingGateBase, stage: z.literal(2), thresholds: gateThresholdsSchema(20) }).strict(),
  z.object({ ...routingGateBase, stage: z.literal(3), thresholds: gateThresholdsSchema(30) }).strict(),
]);

const signedIntervalSchema = z.object({ lower: z.number(), upper: z.number() }).strict();
const signedRateIntervalSchema = z.object({ lower: z.number().min(-1).max(1), upper: z.number().min(-1).max(1) }).strict();
const nonnegativeIntervalSchema = z.object({ lower: nonnegativeNumber, upper: nonnegativeNumber }).strict();
const rateIntervalSchema = z.object({ lower: rate, upper: rate }).strict();
const resourceMetricSampleSchema = z
  .object({
    numerator: finiteNonnegativeNumber,
    denominator: nonnegativeInteger,
    value: nonnegativeNumber.nullable(),
    confidence_interval: nonnegativeIntervalSchema.nullable(),
  })
  .strict();
const rateMetricSampleSchema = z
  .object({
    numerator: nonnegativeInteger,
    denominator: nonnegativeInteger,
    value: rate.nullable(),
    confidence_interval: rateIntervalSchema.nullable(),
  })
  .strict();
const countMetricSampleSchema = z
  .object({
    numerator: nonnegativeInteger,
    denominator: nonnegativeInteger,
    value: nonnegativeNumber.nullable(),
    confidence_interval: nonnegativeIntervalSchema.nullable(),
  })
  .strict();
const armMetricSchema = z
  .object({
    final_acceptance_rate: rateMetricSampleSchema,
    escaped_material_defect_rate: rateMetricSampleSchema,
    escaped_high_defects: countMetricSampleSchema,
    escaped_critical_defects: countMetricSampleSchema,
    wall_time_per_accepted_block: resourceMetricSampleSchema,
    observed_cost_per_accepted_block: resourceMetricSampleSchema,
    estimated_cost_per_accepted_block: resourceMetricSampleSchema,
    strong_tokens_observed_per_accepted_block: resourceMetricSampleSchema,
    strong_tokens_estimated_per_accepted_block: resourceMetricSampleSchema,
    all_role_tokens_observed_per_accepted_block: resourceMetricSampleSchema,
    all_role_tokens_estimated_per_accepted_block: resourceMetricSampleSchema,
    first_pass_accept_rate: rateMetricSampleSchema,
    accept_after_one_repair_rate: rateMetricSampleSchema,
    escalation_rate: rateMetricSampleSchema,
    parent_rework_block_rate: rateMetricSampleSchema,
    parent_rework_production_line_share: rateMetricSampleSchema,
  })
  .strict();
const armMetricsSchema = z
  .object({
    A_STRONG_BASELINE: armMetricSchema,
    B_CHEAP_NO_EARLY_ESCALATION: armMetricSchema,
    C_ADAPTIVE_EARLY_ESCALATION: armMetricSchema,
  })
  .strict();
const armCountsSchema = z
  .object({
    A_STRONG_BASELINE: nonnegativeInteger,
    B_CHEAP_NO_EARLY_ESCALATION: nonnegativeInteger,
    C_ADAPTIVE_EARLY_ESCALATION: nonnegativeInteger,
  })
  .strict();
const armCompletenessSchema = z
  .object({
    A_STRONG_BASELINE: rate.nullable(),
    B_CHEAP_NO_EARLY_ESCALATION: rate.nullable(),
    C_ADAPTIVE_EARLY_ESCALATION: rate.nullable(),
  })
  .strict();
const pairedQualityCounts = {
  baseline_successes: nonnegativeInteger,
  candidate_successes: nonnegativeInteger,
  both_success: nonnegativeInteger,
  baseline_only_success: nonnegativeInteger,
  candidate_only_success: nonnegativeInteger,
  neither_success: nonnegativeInteger,
};
const pairedQualitySchema = z.union([
  z.object({ ...pairedQualityCounts, denominator: z.literal(0), difference: z.null(), confidence_interval: z.null() }).strict(),
  z
    .object({
      ...pairedQualityCounts,
      denominator: positiveInteger,
      difference: z.number().min(-1).max(1),
      confidence_interval: signedRateIntervalSchema,
    })
    .strict(),
]);
const pairedMetricSchema = z
  .object({
    baseline_value: nonnegativeNumber.nullable(),
    candidate_value: nonnegativeNumber.nullable(),
    relative_improvement: z.number().nullable(),
    confidence_interval: signedIntervalSchema.nullable(),
  })
  .strict();
const evaluationMetricsSchema = z
  .object({
    by_arm: armMetricsSchema,
    paired_comparisons: z
      .object({
        final_acceptance: pairedQualitySchema,
        final_quality: pairedQualitySchema,
        parent_rework_block_rate: pairedMetricSchema,
        parent_rework_production_line_share: pairedMetricSchema,
        wall_time_per_accepted_block: pairedMetricSchema,
        observed_cost_per_accepted_block: pairedMetricSchema,
        estimated_cost_per_accepted_block: pairedMetricSchema,
        strong_tokens_observed_per_accepted_block: pairedMetricSchema,
        strong_tokens_estimated_per_accepted_block: pairedMetricSchema,
        all_role_tokens_observed_per_accepted_block: pairedMetricSchema,
        all_role_tokens_estimated_per_accepted_block: pairedMetricSchema,
      })
      .strict(),
  })
  .strict();
const resourceMeasureSchema = z
  .object({
    known_sum: finiteNonnegativeNumber,
    complete: nonnegativeInteger,
    total: nonnegativeInteger,
    completeness_ratio: rate.nullable(),
    complete_value: finiteNonnegativeNumber.nullable(),
  })
  .strict();
const resourceTotalsSchema = z
  .object({
    wall_time_seconds: resourceMeasureSchema,
    cost_observed: resourceMeasureSchema,
    cost_estimated: resourceMeasureSchema,
    strong_tokens_observed: resourceMeasureSchema,
    strong_tokens_estimated: resourceMeasureSchema,
    all_role_tokens_observed: resourceMeasureSchema,
    all_role_tokens_estimated: resourceMeasureSchema,
  })
  .strict();
const exclusionMemberSchema = z
  .object({
    block_ids: boundedArray(identifier),
    resources: resourceTotalsSchema,
  })
  .strict();
const evaluationExclusionSchema = z
  .object({
    pair_or_triplet_id: identifier,
    reason_codes: boundedArray(identifier).min(1),
    members_by_arm: z
      .object({
        A_STRONG_BASELINE: exclusionMemberSchema,
        B_CHEAP_NO_EARLY_ESCALATION: exclusionMemberSchema,
        C_ADAPTIVE_EARLY_ESCALATION: exclusionMemberSchema,
      })
      .strict(),
    operational_resources: resourceTotalsSchema,
  })
  .strict();
const evaluationDenominatorsSchema = z
  .object({
    manifest_blocks: nonnegativeInteger,
    comparative_blocks: nonnegativeInteger,
    candidate_triplets: nonnegativeInteger,
    admitted_triplets: nonnegativeInteger,
    excluded_triplets: nonnegativeInteger,
    comparable_blocks_by_arm: armCountsSchema,
    accepted_blocks_by_arm: armCountsSchema,
    quality_complete_blocks_by_arm: armCountsSchema,
  })
  .strict();
const strongTokenCompletenessSchema = z
  .object({
    input_by_arm: armCompletenessSchema,
    output_by_arm: armCompletenessSchema,
    cached_input_by_arm: armCompletenessSchema,
    reasoning_by_arm: armCompletenessSchema,
    total_by_arm: armCompletenessSchema,
  })
  .strict();
const evaluationCompletenessSchema = z
  .object({
    observed_cost_by_arm: armCompletenessSchema,
    estimated_cost_by_arm: armCompletenessSchema,
    strong_tokens_observed: strongTokenCompletenessSchema,
    strong_tokens_estimated: strongTokenCompletenessSchema,
    wall_time_by_arm: armCompletenessSchema,
  })
  .strict();
const intervalMetadataSchema = z
  .object({
    confidence_level: z.number().gt(0).lt(1),
    interval_algorithm_version: z.literal('paired-bootstrap-sha256-counter-v1'),
    resampling_iterations: resamplingIterations,
    resampling_seed: identifier,
  })
  .strict();

function efficiencyBranchRecord(branch: 'observed_cost' | 'observed_strong_tokens') {
  return z
    .object({
      branch: z.literal(branch),
      status: z.enum(['UNUSABLE', 'FAIL_POINT', 'AMBIGUOUS', 'PASS']),
      eligible_triplets: nonnegativeInteger,
      completeness: rate.nullable(),
      point_improvement: z.number().nullable(),
      confidence_interval: signedIntervalSchema.nullable(),
      reason_codes: boundedArray(identifier).min(1),
    })
    .strict();
}
const efficiencyBranchesSchema = z.tuple([efficiencyBranchRecord('observed_cost'), efficiencyBranchRecord('observed_strong_tokens')]);
const stratumEvaluationSchema = z
  .object({
    matching_stratum: identifier,
    candidate_triplets: nonnegativeInteger,
    admitted_triplets: nonnegativeInteger,
    status: z.enum(['PROMOTED', 'NOT_VALIDATED']),
    reason_codes: boundedArray(identifier).min(1),
    paired_final_acceptance: pairedQualitySchema,
    paired_final_quality: pairedQualitySchema,
    efficiency_branches: efficiencyBranchesSchema,
  })
  .strict();
const operationalTotalsSchema = z
  .object({
    comparative_by_arm: z
      .object({
        A_STRONG_BASELINE: resourceTotalsSchema,
        B_CHEAP_NO_EARLY_ESCALATION: resourceTotalsSchema,
        C_ADAPTIVE_EARLY_ESCALATION: resourceTotalsSchema,
      })
      .strict(),
    direct_to_strong: resourceTotalsSchema,
  })
  .strict();

const evaluationReportBase = {
  schema_version: z.literal(3),
  evaluation_id: identifier,
  evaluation_version: positiveInteger,
  pilot_id: identifier,
  manifest_hash: hash,
  evaluated_at: timestamp,
  observation_set_hash: hash,
  decision_input_hash: hash,
  quality_evidence_hash: hash,
  quality_evidence_count: nonnegativeInteger,
  gate_policy_hash: hash,
  late_quality_evidence_count: nonnegativeInteger,
  not_validated_strata: boundedArray(identifier),
  reasons: boundedArray(identifier).min(1),
  metrics: evaluationMetricsSchema,
  exclusions: boundedArray(evaluationExclusionSchema),
  efficiency_branches: efficiencyBranchesSchema,
  strata: boundedArray(stratumEvaluationSchema),
  operational_totals: operationalTotalsSchema,
  denominators: evaluationDenominatorsSchema,
  completeness: evaluationCompletenessSchema,
  interval_metadata: intervalMetadataSchema,
  warnings: boundedArray(identifier),
};
const emptyPromotedStrata = boundedArray(identifier).max(0);
const promotedStrata = boundedArray(identifier).min(1);
const reportDecisionShapes = [
  { stage: z.literal(1), decision: z.enum(['CONTINUE', 'REJECT']), promoted_strata: emptyPromotedStrata },
  { stage: z.literal(2), decision: z.enum(['CONTINUE', 'REJECT', 'INSUFFICIENT_EVIDENCE']), promoted_strata: emptyPromotedStrata },
  { stage: z.literal(2), decision: z.literal('PROMOTE_BOUNDED'), promoted_strata: promotedStrata },
  { stage: z.literal(3), decision: z.enum(['REJECT', 'INCONCLUSIVE']), promoted_strata: emptyPromotedStrata },
  { stage: z.literal(3), decision: z.literal('PROMOTE_BOUNDED'), promoted_strata: promotedStrata },
];
const reportSupersessionShapes = [
  { supersedes_evaluation_id: z.null(), supersedes_evaluation_version: z.null(), expected_superseded_report_hash: z.null() },
  { supersedes_evaluation_id: identifier, supersedes_evaluation_version: positiveInteger, expected_superseded_report_hash: hash },
];
const reportVariants = reportDecisionShapes.flatMap((decision) =>
  reportSupersessionShapes.map((supersession) => z.object({ ...evaluationReportBase, ...decision, ...supersession }).strict()),
);

export type PilotEvaluationReportV3 = z.infer<(typeof reportVariants)[number]>;
export const pilotEvaluationReportV3Schema: z.ZodType<PilotEvaluationReportV3> = z.union(
  reportVariants as unknown as [
    z.ZodType<PilotEvaluationReportV3>,
    z.ZodType<PilotEvaluationReportV3>,
    ...z.ZodType<PilotEvaluationReportV3>[],
  ],
);

export type PilotManifestV3 = z.infer<typeof pilotManifestV3Schema>;
export type PilotBlockObservationV3 = z.infer<typeof pilotBlockObservationV3Schema>;
export type PilotRoutingGateV3 = z.infer<typeof pilotRoutingGateV3Schema>;
