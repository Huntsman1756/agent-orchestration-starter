import { z } from 'zod';

import { hashCanonical } from './canonical-json.js';
import { bindingV3Schema, pricingSnapshotV3Schema, usageRecordedV3Schema } from './contracts.js';
import { aggregateUsage, type UsageRecordedV3 } from './usage-cost.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const boundedArray = <T extends z.ZodType>(schema: T) => z.array(schema).max(128);

export const DOGFOOD_REQUIRED_METRICS_V1 = [
  'first_pass_accepted',
  'final_accepted',
  'reviewer_rejection',
  'repairs',
  'escalations',
  'attempts',
  'duration_ms',
  'observed_cost',
  'changed_files',
  'changed_lines',
  'validation_failures',
  'false_acceptance',
  'post_acceptance_defects',
  'human_intervention_rate',
  'total_cost_to_accepted_result',
  'all_scheduled_run_cost',
  'frontier_usage',
  'evidence_reconstructible',
  'cross_run_contamination',
] as const;

export const DOGFOOD_STOP_CONDITIONS_V1 = [
  'AUTHORITY_ESCAPE',
  'DURABLE_STATE_INCONSISTENCY',
  'CRITICAL_FALSE_ACCEPTANCE',
  'CROSS_RUN_CONTAMINATION',
  'UNRECONSTRUCTABLE_EVIDENCE',
] as const;

const strategy = z.enum(['orchestrated', 'frontier_execution']);
const usageRole = z.enum(['orchestrator', 'executor', 'reviewer']);
const sourceSensitivity = z.enum(['PUBLIC', 'PRIVATE', 'RESTRICTED']);
const riskClass = z.enum(['low', 'medium', 'high', 'restricted']);
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const metric = z.enum(DOGFOOD_REQUIRED_METRICS_V1);
const stopCondition = z.enum(DOGFOOD_STOP_CONDITIONS_V1);
const stopEventCondition = stopCondition;

const baselineSchema = z.object({
  runtime_commit_sha: commitSha,
  policy_hash: hash,
  host_driver_hash: hash,
  host_certification_hash: hash,
  installation_manifest_hash: hash,
  validation_surface_hash: hash,
}).strict();

const costPolicySchema = z.object({
  reporting_currency: currency,
  human_cost_micro_units_per_second: nonnegativeInteger,
  conversion_policy_hash: hash,
  observed_cost_in_reporting_currency: z.literal(true),
  usage_binding_refs: z.array(identifier).min(1).max(128),
}).strict();

const corpusPolicySchema = z.object({
  provenance: z.enum(['historical_commits', 'new_real_tasks', 'mixed']),
  selection_rule_hash: hash,
  solution_diff_available_to_workers: z.literal(false),
  oracle_available_to_workers: z.literal(false),
  oracle_storage: z.literal('EVALUATOR_ONLY'),
  worker_projection: z.literal('CONTRACT_AND_FIXTURES_ONLY'),
}).strict();

const historicalOracleSchema = z.object({
  kind: z.literal('HISTORICAL_COMMIT'),
  reference_commit_sha: commitSha,
  outcome_hash: hash,
}).strict();
const humanOracleSchema = z.object({
  kind: z.literal('HUMAN_ACCEPTANCE'),
  reference_commit_sha: z.null(),
  outcome_hash: hash,
}).strict();
const noOracleSchema = z.object({
  kind: z.literal('NONE'),
  reference_commit_sha: z.null(),
  outcome_hash: z.null(),
}).strict();

const caseSchema = z.object({
  case_id: identifier,
  task_id: identifier,
  task_class: identifier,
  pair_id: identifier,
  base_sha: commitSha,
  contract_hash: hash,
  fixtures_hash: hash,
  case_fingerprint: hash,
  validation_surface_hash: hash,
  source_sensitivity: sourceSensitivity,
  risk_class: riskClass,
  oracle: z.discriminatedUnion('kind', [historicalOracleSchema, humanOracleSchema, noOracleSchema]),
}).strict();

const routeBindingSchema = z.object({
  strategy,
  binding_ref: identifier,
  binding_hash: hash,
  qualification_hash: hash,
  profile_hash: hash,
  worker_capability_hash: hash,
  guidance_bundle_hash: hash,
  harness_parser_hash: hash,
}).strict();

const reviewerSchema = z.object({
  binding_ref: identifier,
  binding_hash: hash,
  qualification_hash: hash,
  profile_hash: hash,
  review_policy_hash: hash,
  evidence_packet_schema_hash: hash,
  fresh_session_per_run: z.literal(true),
  same_packet_shape: z.literal(true),
  sees_executor_narrative: z.literal(false),
  sees_other_route_result: z.literal(false),
  scope: z.literal('EVIDENCE_ONLY'),
}).strict();

const usageRoleBindingsSchema = z.object({
  allowed_binding_refs: z.array(identifier).min(1).max(128),
}).strict();

const providerUsagePolicySchema = z.object({
  binding_registry: z.array(bindingV3Schema).min(1).max(128),
  binding_registry_hash: hash,
  roles: z.object({
    orchestrator: usageRoleBindingsSchema,
    executor: z.object({
      orchestrated: identifier,
      frontier_execution: identifier,
    }).strict(),
    reviewer: usageRoleBindingsSchema,
  }).strict(),
  required_usage_roles: z.array(usageRole).min(1).max(3),
}).strict();

const runPolicySchema = z.object({
  same_base_sha: z.literal(true),
  same_fixtures: z.literal(true),
  same_validation_surface: z.literal(true),
  fresh_worktree_per_run: z.literal(true),
  cross_run_workspace_reuse: z.literal(false),
  execution_mode: z.literal('STRICT_SERIAL'),
  post_acceptance_window_seconds: positiveInteger,
}).strict();

const schedulingInputSchema = z.object({
  assignment_seed: identifier,
  algorithm_version: z.literal('hash-interleave-v1'),
  max_consecutive_same_strategy: z.literal(2),
}).strict();

const scheduleEntrySchema = z.object({
  ordinal: positiveInteger,
  case_id: identifier,
  strategy,
}).strict();

const authoritySchema = z.object({
  routing_decision: z.literal('REPORT_ONLY'),
  publication_mode: z.literal('MANUAL_ONLY'),
  runtime_may_reach: z.literal('READY_FOR_PUBLICATION'),
  auto_route_promotion: z.literal(false),
  auto_push: z.literal(false),
  auto_merge: z.literal(false),
  auto_deploy: z.literal(false),
  mutation_after_start: z.literal('NEW_EXPERIMENT_REQUIRED'),
}).strict();

const dogfoodManifestShape = {
  schema_version: z.literal(1),
  experiment_id: identifier,
  manifest_hash: hash,
  created_at: timestamp,
  repository: z.object({ repository_id: identifier, base_branch: identifier }).strict(),
  baseline: baselineSchema,
  cost_policy: costPolicySchema,
  provider_usage_policy: providerUsagePolicySchema,
  analysis_policy_hash: hash,
  corpus_policy: corpusPolicySchema,
  cases: z.array(caseSchema).min(20).max(30),
  route_bindings: z.array(routeBindingSchema).length(2),
  reviewer: reviewerSchema,
  run_policy: runPolicySchema,
  scheduling: schedulingInputSchema,
  schedule_hash: hash,
  schedule: z.array(scheduleEntrySchema).max(60),
  authority: authoritySchema,
  required_metrics: z.array(metric).length(DOGFOOD_REQUIRED_METRICS_V1.length),
  stop_conditions: z.array(stopCondition).length(DOGFOOD_STOP_CONDITIONS_V1.length),
};

export const dogfoodManifestV1Schema = z.object(dogfoodManifestShape).strict();
export type DogfoodManifestV1 = z.infer<typeof dogfoodManifestV1Schema>;
export type DogfoodManifestInputV1 = Omit<DogfoodManifestV1, 'schema_version' | 'manifest_hash' | 'schedule_hash' | 'schedule'>;

const defectSchema = z.object({ defect_hash: hash, severity }).strict();
const usageEventBindingSchema = z.object({
  usage_id: identifier,
  run_id: identifier,
  event_id: identifier,
  event_hash: hash,
}).strict();
const dogfoodRunRecordShape = {
  schema_version: z.literal(1),
  record_hash: hash,
  experiment_id: identifier,
  manifest_hash: hash,
  run_id: identifier,
  schedule_ordinal: positiveInteger,
  case_id: identifier,
  task_id: identifier,
  pair_id: identifier,
  strategy,
  binding_ref: identifier,
  binding_hash: hash,
  qualification_hash: hash,
  cost_policy_hash: hash,
  provider_cost_evidence: z.object({
    evidence_schema_version: z.literal(3),
    pricing_snapshot: pricingSnapshotV3Schema,
    binding_registry: z.array(bindingV3Schema).min(1).max(128),
    usage: z.array(usageRecordedV3Schema).min(1).max(128),
    usage_event_bindings: z.array(usageEventBindingSchema).min(1).max(128),
    usage_ledger_hash: hash,
    binding_registry_hash: hash,
  }).strict(),
  base_sha: commitSha,
  contract_hash: hash,
  fixtures_hash: hash,
  case_fingerprint: hash,
  policy_hash: hash,
  profile_hash: hash,
  worker_capability_hash: hash,
  guidance_bundle_hash: hash,
  harness_parser_hash: hash,
  host_driver_hash: hash,
  host_certification_hash: hash,
  installation_manifest_hash: hash,
  validation_surface_hash: hash,
  started_at: timestamp,
  completed_at: timestamp,
  outcome: z.enum(['ACCEPTED', 'REJECTED', 'FAILED', 'BLOCKED', 'ABORTED']),
  first_pass_accepted: z.boolean(),
  final_accepted: z.boolean(),
  reviewer_rejected: z.boolean(),
  repairs: nonnegativeInteger,
  escalations: nonnegativeInteger,
  attempts: positiveInteger,
  duration_ms: nonnegativeInteger,
  currency: z.string().regex(/^[A-Z]{3}$/),
  observed_cost_micro_units: nonnegativeInteger,
  human_interventions: nonnegativeInteger,
  human_intervention_seconds: nonnegativeInteger,
  human_intervention_cost_micro_units: nonnegativeInteger,
  total_cost_to_accepted_result_micro_units: nonnegativeInteger,
  frontier_usage_calls: nonnegativeInteger,
  changed_files: nonnegativeInteger,
  changed_lines: nonnegativeInteger,
  validation_failures: nonnegativeInteger,
  false_acceptance: z.boolean(),
  post_acceptance_window_closed: z.literal(true),
  post_acceptance_defects: boundedArray(defectSchema),
  evidence_reconstructible: z.boolean(),
  evidence_hashes: boundedArray(hash).min(1),
  cross_run_contamination: z.boolean(),
  publication_state: z.enum(['MANUAL_PENDING', 'NOT_REQUESTED']),
  recorded_at: timestamp,
};

export const dogfoodRunRecordV1Schema = z.object(dogfoodRunRecordShape).strict();
export type DogfoodRunRecordV1 = z.infer<typeof dogfoodRunRecordV1Schema>;
export type DogfoodRunRecordInputV1 = Omit<DogfoodRunRecordV1, 'schema_version' | 'record_hash'>;

const dogfoodStopEventShape = {
  schema_version: z.literal(1),
  stop_event_hash: hash,
  experiment_id: identifier,
  manifest_hash: hash,
  stop_condition: stopEventCondition,
  last_completed_schedule_ordinal: nonnegativeInteger,
  triggering_run_id: identifier.nullable(),
  observed_at: timestamp,
  evidence_hashes: boundedArray(hash).min(1),
};

export const dogfoodStopEventV1Schema = z.object(dogfoodStopEventShape).strict().superRefine((event, context) => {
  if (event.last_completed_schedule_ordinal === 0 && event.triggering_run_id !== null) {
    context.addIssue({ code: 'custom', path: ['triggering_run_id'], message: 'ordinal-zero stop events cannot have a triggering run' });
  }
  if (event.last_completed_schedule_ordinal === 0 && (event.stop_condition === 'CRITICAL_FALSE_ACCEPTANCE' || event.stop_condition === 'CROSS_RUN_CONTAMINATION')) {
    context.addIssue({ code: 'custom', path: ['stop_condition'], message: `${event.stop_condition} requires a completed triggering run` });
  }
  if (event.last_completed_schedule_ordinal > 0 && event.triggering_run_id === null) {
    context.addIssue({ code: 'custom', path: ['triggering_run_id'], message: 'non-zero stop events require a triggering run' });
  }
});
export type DogfoodStopEventV1 = z.infer<typeof dogfoodStopEventV1Schema>;
export type DogfoodStopEventInputV1 = Omit<DogfoodStopEventV1, 'schema_version' | 'stop_event_hash'>;

export interface DogfoodManifestVerificationV1 {
  ok: boolean;
  errors: string[];
  case_count: number;
  schedule_entries: number;
}

export interface DogfoodRunRecordVerificationV1 {
  ok: boolean;
  errors: string[];
}

export interface DogfoodRunSetVerificationV1 {
  ok: boolean;
  errors: string[];
  status: 'COMPLETE' | 'STOPPED_OPERATIONAL_FAILURE';
  expected_records: number;
  actual_records: number;
}

function omitHash<T extends Record<string, unknown>>(value: T, key: string): Omit<T, typeof key> {
  const { [key]: _omitted, ...remaining } = value;
  return remaining;
}

function scheduleFor(input: Pick<DogfoodManifestInputV1, 'cases' | 'scheduling'>): DogfoodManifestV1['schedule'] {
  const rankedCases = [...input.cases].sort((left, right) => hashCanonical({
    algorithm_version: input.scheduling.algorithm_version,
    assignment_seed: input.scheduling.assignment_seed,
    case_id: left.case_id,
  }).localeCompare(hashCanonical({
    algorithm_version: input.scheduling.algorithm_version,
    assignment_seed: input.scheduling.assignment_seed,
    case_id: right.case_id,
  })));
  const schedule: DogfoodManifestV1['schedule'] = [];
  for (const [index, currentCase] of rankedCases.entries()) {
    const rank = (currentStrategy: 'orchestrated' | 'frontier_execution') => hashCanonical({
      algorithm_version: input.scheduling.algorithm_version,
      assignment_seed: input.scheduling.assignment_seed,
      case_id: currentCase.case_id,
      slot: index,
      strategy: currentStrategy,
    });
    const routeOrder = rank('orchestrated').localeCompare(rank('frontier_execution')) < 0
      ? ['orchestrated', 'frontier_execution'] as const
      : ['frontier_execution', 'orchestrated'] as const;
    schedule.push(
      { ordinal: schedule.length + 1, case_id: currentCase.case_id, strategy: routeOrder[0] },
      { ordinal: schedule.length + 2, case_id: currentCase.case_id, strategy: routeOrder[1] },
    );
  }
  return schedule;
}

function exactSet<T extends string>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && new Set(actual).size === expected.length && expected.every(value => actual.includes(value));
}

function scheduleErrors(manifest: DogfoodManifestV1): string[] {
  const errors: string[] = [];
  const expected = new Set(manifest.cases.flatMap(currentCase => [
    `${currentCase.case_id}:orchestrated`,
    `${currentCase.case_id}:frontier_execution`,
  ]));
  const actual = new Set(manifest.schedule.map(entry => `${entry.case_id}:${entry.strategy}`));
  if (manifest.schedule.length !== expected.size) errors.push('schedule must contain exactly two entries per case');
  if (actual.size !== manifest.schedule.length || [...expected].some(value => !actual.has(value))) errors.push('schedule must contain each case and strategy exactly once');
  for (const [index, entry] of manifest.schedule.entries()) {
    if (entry.ordinal !== index + 1) errors.push('schedule ordinals must be contiguous and one-based');
    if (!manifest.cases.some(currentCase => currentCase.case_id === entry.case_id)) errors.push(`schedule references unknown case: ${entry.case_id}`);
  }
  let previous: string | null = null;
  let consecutive = 0;
  for (const entry of manifest.schedule) {
    if (entry.strategy === previous) consecutive += 1;
    else { previous = entry.strategy; consecutive = 1; }
    if (consecutive > manifest.scheduling.max_consecutive_same_strategy) errors.push('schedule is not interleaved within the configured bound');
  }
  if (manifest.schedule_hash !== hashCanonical(manifest.schedule)) errors.push('schedule hash does not match canonical schedule content');
  return errors;
}

function manifestErrors(manifest: DogfoodManifestV1): string[] {
  const errors: string[] = [];
  if (manifest.cases.length < 20 || manifest.cases.length > 30) errors.push('case count must be between 20 and 30');
  if (!exactSet(manifest.required_metrics, DOGFOOD_REQUIRED_METRICS_V1)) errors.push('required metrics must be the frozen dogfood metric set');
  if (!exactSet(manifest.stop_conditions, DOGFOOD_STOP_CONDITIONS_V1)) errors.push('stop conditions must be the frozen fail-stop set');
  if (new Set(manifest.route_bindings.map(binding => binding.strategy)).size !== 2
    || !manifest.route_bindings.some(binding => binding.strategy === 'orchestrated')
    || !manifest.route_bindings.some(binding => binding.strategy === 'frontier_execution')) {
    errors.push('route bindings must contain exactly orchestrated and frontier_execution');
  }
  if (new Set(manifest.route_bindings.map(binding => binding.binding_ref)).size !== manifest.route_bindings.length) {
    errors.push('route binding references must be unique');
  }
  const topology = manifest.provider_usage_policy;
  const topologyRegistry = canonicalBindingRegistry(topology.binding_registry);
  const topologyRefs = new Set(topologyRegistry.map(binding => binding.binding_ref));
  if (topology.binding_registry_hash !== hashCanonical(topologyRegistry)) errors.push('provider usage policy registry hash does not match canonical registry content');
  if (topologyRefs.size !== topologyRegistry.length) errors.push('provider usage policy binding references must be unique');
  const requiredUsageRefs = [...manifest.route_bindings.map(binding => binding.binding_ref), manifest.reviewer.binding_ref];
  for (const bindingRef of requiredUsageRefs) if (!topologyRefs.has(bindingRef)) errors.push(`provider usage policy omits required binding: ${bindingRef}`);
  const usageRefs = new Set(manifest.cost_policy.usage_binding_refs);
  if (usageRefs.size !== manifest.cost_policy.usage_binding_refs.length) errors.push('cost policy usage binding references must be unique');
  if (usageRefs.size !== topologyRefs.size || [...topologyRefs].some(bindingRef => !usageRefs.has(bindingRef))) errors.push('cost policy usage binding references must match the frozen provider usage registry');
  const orchestratorRefs = new Set(topology.roles.orchestrator.allowed_binding_refs);
  const reviewerRefs = new Set(topology.roles.reviewer.allowed_binding_refs);
  const executorRefs = new Set([topology.roles.executor.orchestrated, topology.roles.executor.frontier_execution]);
  for (const [role, refs] of [['orchestrator', orchestratorRefs], ['reviewer', reviewerRefs], ['executor', executorRefs]] as const) {
    for (const bindingRef of refs) if (!topologyRefs.has(bindingRef)) errors.push(`${role} usage policy references unknown binding: ${bindingRef}`);
  }
  const allRoleRefs = new Set([...orchestratorRefs, ...reviewerRefs, ...executorRefs]);
  for (const bindingRef of topologyRefs) if (!allRoleRefs.has(bindingRef)) errors.push(`provider usage registry contains an unassigned binding: ${bindingRef}`);
  for (const requiredRole of ['executor', 'reviewer'] as const) if (!topology.required_usage_roles.includes(requiredRole)) errors.push(`provider usage policy must require the ${requiredRole} usage role`);
  if (new Set(topology.required_usage_roles).size !== topology.required_usage_roles.length) errors.push('provider usage policy required roles must be unique');
  const routeBindingByStrategy = new Map(manifest.route_bindings.map(binding => [binding.strategy, binding]));
  for (const currentStrategy of ['orchestrated', 'frontier_execution'] as const) {
    const routeBinding = routeBindingByStrategy.get(currentStrategy);
    if (routeBinding && topology.roles.executor[currentStrategy] !== routeBinding.binding_ref) errors.push(`executor usage policy does not match the ${currentStrategy} route binding`);
    const registryBinding = routeBinding ? topologyRegistry.find(binding => binding.binding_ref === routeBinding.binding_ref) : undefined;
    if (routeBinding && registryBinding && registryBinding.profile_hash !== routeBinding.profile_hash) errors.push(`${currentStrategy} provider profile hash does not match its route binding`);
  }
  if (!reviewerRefs.has(manifest.reviewer.binding_ref)) errors.push('reviewer usage policy must allow the frozen reviewer binding');
  const reviewerRegistryBinding = topologyRegistry.find(binding => binding.binding_ref === manifest.reviewer.binding_ref);
  if (reviewerRegistryBinding && reviewerRegistryBinding.profile_hash !== manifest.reviewer.profile_hash) errors.push('reviewer provider profile hash does not match its reviewer binding');
  const caseIds = new Set<string>();
  const taskIds = new Set<string>();
  const pairIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const currentCase of manifest.cases) {
    if (caseIds.has(currentCase.case_id)) errors.push(`duplicate case_id: ${currentCase.case_id}`);
    if (taskIds.has(currentCase.task_id)) errors.push(`duplicate task_id: ${currentCase.task_id}`);
    if (pairIds.has(currentCase.pair_id)) errors.push(`duplicate pair_id: ${currentCase.pair_id}`);
    if (fingerprints.has(currentCase.case_fingerprint)) errors.push(`duplicate case_fingerprint: ${currentCase.case_fingerprint}`);
    caseIds.add(currentCase.case_id);
    taskIds.add(currentCase.task_id);
    pairIds.add(currentCase.pair_id);
    fingerprints.add(currentCase.case_fingerprint);
    if (currentCase.validation_surface_hash !== manifest.baseline.validation_surface_hash) errors.push(`case validation surface differs from baseline: ${currentCase.case_id}`);
    if (currentCase.oracle.kind === 'NONE' && manifest.corpus_policy.provenance === 'historical_commits') errors.push(`historical corpus case lacks an oracle: ${currentCase.case_id}`);
  }
  errors.push(...scheduleErrors(manifest));
  if (manifest.corpus_policy.solution_diff_available_to_workers || manifest.corpus_policy.oracle_available_to_workers) errors.push('worker corpus projection must not expose solution or oracle data');
  if (manifest.reviewer.sees_executor_narrative || manifest.reviewer.sees_other_route_result) errors.push('reviewer must not receive executor narrative or the other route result');
  if (manifest.authority.routing_decision !== 'REPORT_ONLY' || manifest.authority.publication_mode !== 'MANUAL_ONLY'
    || manifest.authority.auto_route_promotion || manifest.authority.auto_push || manifest.authority.auto_merge || manifest.authority.auto_deploy) {
    errors.push('dogfood authority must remain report-only with manual publication');
  }
  if (manifest.manifest_hash !== hashCanonical(omitHash(manifest, 'manifest_hash'))) errors.push('manifest hash does not match canonical manifest content');
  return errors;
}

function parseTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  const expected = value.includes('.') ? value : value.replace('Z', '.000Z');
  return canonical === expected ? milliseconds : null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalUsageLedger(usage: readonly UsageRecordedV3[]): readonly UsageRecordedV3[] {
  return [...usage].sort((left, right) => compareCodeUnits(left.usage_id, right.usage_id));
}

function canonicalBindingRegistry(bindings: DogfoodRunRecordV1['provider_cost_evidence']['binding_registry']): readonly DogfoodRunRecordV1['provider_cost_evidence']['binding_registry'][number][] {
  return [...bindings].sort((left, right) => compareCodeUnits(left.binding_ref, right.binding_ref));
}

function canonicalUsageEventBindings(bindings: DogfoodRunRecordV1['provider_cost_evidence']['usage_event_bindings']): readonly DogfoodRunRecordV1['provider_cost_evidence']['usage_event_bindings'][number][] {
  return [...bindings].sort((left, right) => compareCodeUnits(left.usage_id, right.usage_id));
}

function timingErrors(manifest: DogfoodManifestV1, record: DogfoodRunRecordV1): string[] {
  const errors: string[] = [];
  const started = parseTimestamp(record.started_at);
  const completed = parseTimestamp(record.completed_at);
  const recorded = parseTimestamp(record.recorded_at);
  if (started === null) errors.push('started_at is not a valid UTC timestamp');
  if (completed === null) errors.push('completed_at is not a valid UTC timestamp');
  if (recorded === null) errors.push('recorded_at is not a valid UTC timestamp');
  if (started === null || completed === null || recorded === null) return errors;
  if (started > completed) errors.push('started_at must be at or before completed_at');
  if (completed > recorded) errors.push('completed_at must be at or before recorded_at');
  if (record.duration_ms !== completed - started) errors.push('duration_ms must equal completed_at minus started_at');
  const windowMilliseconds = manifest.run_policy.post_acceptance_window_seconds * 1_000;
  if (!Number.isSafeInteger(windowMilliseconds)) errors.push('post-acceptance window is outside the safe integer range');
  else if (recorded - completed < windowMilliseconds) errors.push('post-acceptance window is not closed');
  return errors;
}

function costErrors(manifest: DogfoodManifestV1, record: DogfoodRunRecordV1): string[] {
  const errors: string[] = [];
  const policy = manifest.cost_policy;
  const topology = manifest.provider_usage_policy;
  const expectedPolicyHash = hashCanonical(policy);
  if (record.cost_policy_hash !== expectedPolicyHash) errors.push('cost_policy_hash does not match the frozen cost policy');
  if (record.currency !== policy.reporting_currency) errors.push('currency does not match the frozen reporting currency');

  const providerEvidence = record.provider_cost_evidence;
  const snapshot = providerEvidence.pricing_snapshot;
  const snapshotContent = omitHash(snapshot, 'pricing_snapshot_hash');
  if (snapshot.pricing_snapshot_hash !== hashCanonical(snapshotContent)) errors.push('provider pricing snapshot hash does not match its content');
  if (snapshot.pricing_snapshot_hash !== policy.conversion_policy_hash) errors.push('provider pricing snapshot does not match the frozen conversion policy');
  if (snapshot.currency !== policy.reporting_currency) errors.push('provider pricing snapshot currency does not match the frozen reporting currency');
  const canonicalUsage = canonicalUsageLedger(providerEvidence.usage as readonly UsageRecordedV3[]);
  const canonicalUsageEventRefs = canonicalUsageEventBindings(providerEvidence.usage_event_bindings);
  if (providerEvidence.usage_ledger_hash !== hashCanonical({ usage: canonicalUsage, usage_event_bindings: canonicalUsageEventRefs })) errors.push('provider usage ledger hash does not match canonical usage and event references');
  if (providerEvidence.binding_registry_hash !== hashCanonical(canonicalBindingRegistry(providerEvidence.binding_registry))) errors.push('provider binding registry hash does not match canonical registry content');
  if (providerEvidence.binding_registry_hash !== topology.binding_registry_hash) errors.push('provider binding registry does not match the frozen provider usage topology');

  const allowedBindingRefs = new Set(topology.binding_registry.map(binding => binding.binding_ref));
  const registryBindingRefs = new Set(providerEvidence.binding_registry.map(binding => binding.binding_ref));
  if (registryBindingRefs.size !== providerEvidence.binding_registry.length) errors.push('provider binding registry references must be unique');
  if (registryBindingRefs.size !== allowedBindingRefs.size || [...allowedBindingRefs].some(bindingRef => !registryBindingRefs.has(bindingRef))) errors.push('provider binding registry does not match the frozen provider usage registry');
  const tariffBindingRefs = new Set(snapshot.tariffs.map(tariff => tariff.binding_ref));
  if (tariffBindingRefs.size !== registryBindingRefs.size || [...registryBindingRefs].some(bindingRef => !tariffBindingRefs.has(bindingRef))) errors.push('provider pricing tariffs do not match the provider binding registry');
  const usageIds = new Set(providerEvidence.usage.map(usage => usage.usage_id));
  if (usageIds.size !== providerEvidence.usage.length) errors.push('provider usage ids must be unique');
  const eventRefsByUsageId = new Map<string, typeof canonicalUsageEventRefs[number]>();
  for (const eventRef of providerEvidence.usage_event_bindings) {
    if (eventRefsByUsageId.has(eventRef.usage_id)) errors.push(`provider usage event references must be unique: ${eventRef.usage_id}`);
    eventRefsByUsageId.set(eventRef.usage_id, eventRef);
    if (eventRef.run_id !== record.run_id) errors.push(`provider usage event ${eventRef.event_id} is bound to a different run`);
    if (!record.evidence_hashes.includes(eventRef.event_hash)) errors.push(`provider usage event ${eventRef.event_id} is not included in the run evidence hashes`);
  }
  if (eventRefsByUsageId.size !== usageIds.size || [...usageIds].some(usageId => !eventRefsByUsageId.has(usageId))) errors.push('provider usage event references must cover every usage entry exactly once');
  const allowedUsageRefs = (role: UsageRecordedV3['role']): readonly string[] => role === 'executor'
    ? [topology.roles.executor[record.strategy]]
    : topology.roles[role].allowed_binding_refs;
  const usageRoles = new Set<UsageRecordedV3['role']>();
  for (const usage of providerEvidence.usage) {
    usageRoles.add(usage.role);
    if (!allowedBindingRefs.has(usage.binding_ref)) errors.push(`provider usage references an unapproved binding: ${usage.binding_ref}`);
    if (!allowedUsageRefs(usage.role).includes(usage.binding_ref)) errors.push(`provider ${usage.role} usage does not match the frozen role binding: ${usage.binding_ref}`);
  }
  for (const requiredRole of topology.required_usage_roles) if (!usageRoles.has(requiredRole)) errors.push(`provider usage evidence is missing required role: ${requiredRole}`);

  let aggregate: ReturnType<typeof aggregateUsage> | null = null;
  try {
    aggregate = aggregateUsage(providerEvidence.usage as readonly UsageRecordedV3[], providerEvidence.binding_registry, snapshot);
  } catch (error) {
    errors.push(`provider cost evidence cannot be reproduced: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (aggregate) {
    if (aggregate.unknown_binding_usage_ids.length > 0) errors.push('provider cost evidence contains unknown bindings');
    if (aggregate.cost_observed.complete !== aggregate.cost_observed.total) errors.push('provider observed cost evidence is incomplete');
    for (const priced of aggregate.priced_usage) {
      if (!priced.observed_pricing_complete || priced.observed_cost_provenance === null || priced.pricing_errors.length > 0) {
        errors.push(`provider observed pricing is invalid for usage ${priced.usage_id}`);
      }
    }
    if (aggregate.cost_observed.value !== record.observed_cost_micro_units) errors.push('observed_cost_micro_units does not match reproduced provider cost');
    const frontierUsageCalls = aggregate.priced_usage.filter(usage => usage.role === 'executor' && providerEvidence.binding_registry.find(binding => binding.binding_ref === usage.binding_ref)?.capability_class === 'strong').length;
    if (record.frontier_usage_calls !== frontierUsageCalls) errors.push('frontier_usage_calls does not match reproduced provider usage');
  }

  const expectedHumanCost = record.human_intervention_seconds * policy.human_cost_micro_units_per_second;
  if (!Number.isSafeInteger(expectedHumanCost)) errors.push('human intervention cost is outside the safe integer range');
  else if (record.human_intervention_cost_micro_units !== expectedHumanCost) errors.push('human_intervention_cost_micro_units does not match the frozen human rate');
  const expectedTotal = record.observed_cost_micro_units + record.human_intervention_cost_micro_units;
  if (!Number.isSafeInteger(expectedTotal)) errors.push('total cost is outside the safe integer range');
  else if (record.total_cost_to_accepted_result_micro_units !== expectedTotal) errors.push('total_cost_to_accepted_result_micro_units does not match observed and human cost');
  return errors;
}

function semanticErrors(record: DogfoodRunRecordV1): string[] {
  const errors: string[] = [];
  if ((record.outcome === 'ACCEPTED') !== record.final_accepted) errors.push('outcome ACCEPTED must be equivalent to final_accepted');
  if (record.false_acceptance && !record.final_accepted) errors.push('false_acceptance requires final_accepted');
  if (record.first_pass_accepted && !record.final_accepted) errors.push('first_pass_accepted requires final_accepted');
  if (record.first_pass_accepted && record.attempts !== 1) errors.push('first_pass_accepted requires exactly one attempt');
  if (record.first_pass_accepted && record.repairs !== 0) errors.push('first_pass_accepted requires zero repairs');
  if (record.first_pass_accepted && record.escalations !== 0) errors.push('first_pass_accepted requires zero escalations');
  if (record.first_pass_accepted && record.reviewer_rejected) errors.push('first_pass_accepted cannot include a reviewer rejection');
  if (record.human_intervention_seconds > 0 && record.human_interventions === 0) errors.push('positive human intervention time requires at least one human intervention');
  if (record.reviewer_rejected && record.final_accepted && record.attempts === 1 && record.repairs === 0 && record.escalations === 0) {
    errors.push('accepted runs with a reviewer rejection require a repair or escalation');
  }
  if (record.post_acceptance_defects.length > 0 && !record.final_accepted) errors.push('post_acceptance_defects require final_accepted');
  if (record.post_acceptance_defects.some(defect => defect.severity === 'critical') && !record.false_acceptance) errors.push('critical post-acceptance defects require critical false acceptance');
  return errors;
}

type DerivedDogfoodStopCondition = Extract<DogfoodStopEventV1['stop_condition'], 'CRITICAL_FALSE_ACCEPTANCE' | 'CROSS_RUN_CONTAMINATION' | 'UNRECONSTRUCTABLE_EVIDENCE'>;

function derivedStopCondition(record: DogfoodRunRecordV1): DerivedDogfoodStopCondition | null {
  // Precedence is frozen to the stop-condition order: a critical false
  // acceptance is more specific than contamination, which is more specific
  // than an unreconstructable evidence condition observed in the same run.
  if (record.false_acceptance && record.post_acceptance_defects.some(defect => defect.severity === 'critical')) return 'CRITICAL_FALSE_ACCEPTANCE';
  if (record.cross_run_contamination) return 'CROSS_RUN_CONTAMINATION';
  if (!record.evidence_reconstructible) return 'UNRECONSTRUCTABLE_EVIDENCE';
  return null;
}

export function loadDogfoodManifestV1(value: unknown): DogfoodManifestV1 {
  return dogfoodManifestV1Schema.parse(value);
}

export function loadDogfoodRunRecordV1(value: unknown): DogfoodRunRecordV1 {
  return dogfoodRunRecordV1Schema.parse(value);
}

export function loadDogfoodStopEventV1(value: unknown): DogfoodStopEventV1 {
  return dogfoodStopEventV1Schema.parse(value);
}

export function freezeDogfoodManifestV1(input: DogfoodManifestInputV1): DogfoodManifestV1 {
  const parsedInput = dogfoodManifestV1Schema.omit({ schema_version: true, manifest_hash: true, schedule_hash: true, schedule: true }).parse(input);
  const schedule = scheduleFor(parsedInput);
  const draft = {
    schema_version: 1 as const,
    ...parsedInput,
    schedule_hash: hashCanonical(schedule),
    schedule,
    manifest_hash: '',
  };
  const manifest = loadDogfoodManifestV1({ ...draft, manifest_hash: hashCanonical(omitHash(draft, 'manifest_hash')) });
  const verification = verifyDogfoodManifestV1(manifest);
  if (!verification.ok) throw new Error(`Cannot freeze dogfood manifest: ${verification.errors.join('; ')}`);
  return manifest;
}

export function verifyDogfoodManifestV1(manifest: DogfoodManifestV1): DogfoodManifestVerificationV1 {
  const errors: string[] = [];
  try { loadDogfoodManifestV1(manifest); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (errors.length === 0) errors.push(...manifestErrors(manifest));
  return { ok: errors.length === 0, errors, case_count: manifest.cases.length, schedule_entries: manifest.schedule.length };
}

export function freezeDogfoodRunRecordV1(input: DogfoodRunRecordInputV1): DogfoodRunRecordV1 {
  const draft = { schema_version: 1 as const, ...input, record_hash: '' };
  return loadDogfoodRunRecordV1({ ...draft, record_hash: hashCanonical(omitHash(draft, 'record_hash')) });
}

export function freezeDogfoodStopEventV1(input: DogfoodStopEventInputV1): DogfoodStopEventV1 {
  const draft = { schema_version: 1 as const, ...input, stop_event_hash: '' };
  return loadDogfoodStopEventV1({ ...draft, stop_event_hash: hashCanonical(omitHash(draft, 'stop_event_hash')) });
}

export function verifyDogfoodStopEventV1(manifest: DogfoodManifestV1, event: DogfoodStopEventV1, triggeringRun: DogfoodRunRecordV1 | null = null): DogfoodRunRecordVerificationV1 {
  const errors: string[] = [];
  try { loadDogfoodStopEventV1(event); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (errors.length > 0) return { ok: false, errors };
  if (event.stop_event_hash !== hashCanonical(omitHash(event, 'stop_event_hash'))) errors.push('stop event hash does not match canonical event content');
  if (event.experiment_id !== manifest.experiment_id || event.manifest_hash !== manifest.manifest_hash) errors.push('stop event is bound to a different experiment manifest');
  if (event.last_completed_schedule_ordinal > manifest.schedule.length) errors.push('stop event ordinal exceeds the frozen schedule');
  if (event.last_completed_schedule_ordinal === 0) {
    if (event.stop_condition === 'CRITICAL_FALSE_ACCEPTANCE' || event.stop_condition === 'CROSS_RUN_CONTAMINATION') {
      errors.push(`${event.stop_condition} requires a completed triggering run`);
    }
    if (event.triggering_run_id !== null) errors.push('ordinal-zero stop events cannot identify a triggering run');
    return { ok: errors.length === 0, errors };
  }
  if (triggeringRun === null) {
    errors.push('non-zero stop events require the verified triggering run evidence');
    return { ok: false, errors };
  }
  const triggeringVerification = verifyDogfoodRunRecordV1(manifest, triggeringRun);
  if (!triggeringVerification.ok) errors.push(...triggeringVerification.errors.map(error => `triggering run: ${error}`));
  if (triggeringRun.run_id !== event.triggering_run_id) errors.push('stop event triggering run id does not match the verified run');
  if (triggeringRun.schedule_ordinal !== event.last_completed_schedule_ordinal) errors.push('stop event triggering run does not match the last completed ordinal');
  if (!event.evidence_hashes.includes(triggeringRun.record_hash)) errors.push('stop event evidence must include the triggering run record hash');
  const observedAt = parseTimestamp(event.observed_at);
  const completedAt = parseTimestamp(triggeringRun.completed_at);
  if (observedAt !== null && completedAt !== null && observedAt < completedAt) errors.push('stop event must be observed after the triggering run completed');
  if (event.stop_condition === 'CRITICAL_FALSE_ACCEPTANCE') {
    if (!triggeringRun.false_acceptance) errors.push('critical false acceptance stop requires false_acceptance=true on the triggering run');
    if (!triggeringRun.post_acceptance_defects.some(defect => defect.severity === 'critical')) errors.push('critical false acceptance stop requires a critical post-acceptance defect on the triggering run');
  }
  if (event.stop_condition === 'CROSS_RUN_CONTAMINATION' && !triggeringRun.cross_run_contamination) errors.push('cross-run contamination stop requires cross_run_contamination=true on the triggering run');
  if (event.stop_condition === 'UNRECONSTRUCTABLE_EVIDENCE' && triggeringRun.evidence_reconstructible) errors.push('unreconstructable evidence stop requires evidence_reconstructible=false on the triggering run');
  return { ok: errors.length === 0, errors };
}

export function verifyDogfoodRunRecordV1(manifest: DogfoodManifestV1, record: DogfoodRunRecordV1): DogfoodRunRecordVerificationV1 {
  const errors: string[] = [];
  try { loadDogfoodRunRecordV1(record); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (errors.length > 0) return { ok: false, errors };
  if (record.record_hash !== hashCanonical(omitHash(record, 'record_hash'))) errors.push('record hash does not match canonical record content');
  if (record.experiment_id !== manifest.experiment_id || record.manifest_hash !== manifest.manifest_hash) errors.push('record is bound to a different experiment manifest');
  const currentCase = manifest.cases.find(value => value.case_id === record.case_id);
  const scheduled = manifest.schedule.find(value => value.ordinal === record.schedule_ordinal);
  if (!currentCase) errors.push(`record references unknown case: ${record.case_id}`);
  if (!scheduled) errors.push(`record references unknown schedule ordinal: ${record.schedule_ordinal}`);
  if (currentCase) {
    for (const [field, expected] of Object.entries({
      task_id: currentCase.task_id,
      pair_id: currentCase.pair_id,
      base_sha: currentCase.base_sha,
      contract_hash: currentCase.contract_hash,
      fixtures_hash: currentCase.fixtures_hash,
      case_fingerprint: currentCase.case_fingerprint,
      validation_surface_hash: currentCase.validation_surface_hash,
    })) if (record[field as keyof DogfoodRunRecordV1] !== expected) errors.push(`record ${field} does not match frozen case`);
  }
  if (scheduled && (scheduled.case_id !== record.case_id || scheduled.strategy !== record.strategy)) errors.push('record does not match its frozen schedule entry');
  const routeBinding = manifest.route_bindings.find(value => value.strategy === record.strategy);
  if (!routeBinding || record.binding_ref !== routeBinding.binding_ref || record.binding_hash !== routeBinding.binding_hash || record.qualification_hash !== routeBinding.qualification_hash) errors.push('record binding does not match the frozen route binding');
  for (const [field, expected] of Object.entries({
    policy_hash: manifest.baseline.policy_hash,
    host_driver_hash: manifest.baseline.host_driver_hash,
    host_certification_hash: manifest.baseline.host_certification_hash,
    installation_manifest_hash: manifest.baseline.installation_manifest_hash,
  })) if (record[field as keyof DogfoodRunRecordV1] !== expected) errors.push(`record ${field} does not match frozen baseline`);
  if (routeBinding) {
    for (const [field, expected] of Object.entries({
      profile_hash: routeBinding.profile_hash,
      worker_capability_hash: routeBinding.worker_capability_hash,
      guidance_bundle_hash: routeBinding.guidance_bundle_hash,
      harness_parser_hash: routeBinding.harness_parser_hash,
    })) if (record[field as keyof DogfoodRunRecordV1] !== expected) errors.push(`record ${field} does not match frozen route binding`);
  }
  errors.push(...timingErrors(manifest, record));
  errors.push(...costErrors(manifest, record));
  errors.push(...semanticErrors(record));
  if (record.publication_state !== 'MANUAL_PENDING' && record.publication_state !== 'NOT_REQUESTED') errors.push('record publication state is not manual');
  return { ok: errors.length === 0, errors };
}

export function verifyDogfoodRunSetV1(manifest: DogfoodManifestV1, records: readonly unknown[], stopEvent: DogfoodStopEventV1 | null = null): DogfoodRunSetVerificationV1 {
  const errors: string[] = [];
  const manifestVerification = verifyDogfoodManifestV1(manifest);
  if (!manifestVerification.ok) errors.push(...manifestVerification.errors.map(error => `manifest: ${error}`));
  const expectedLastOrdinal = stopEvent ? Math.min(stopEvent.last_completed_schedule_ordinal, manifest.schedule.length) : manifest.schedule.length;
  const expectedOrdinals = new Set(Array.from({ length: expectedLastOrdinal }, (_, index) => index + 1));
  if (records.length !== expectedOrdinals.size) errors.push(`run record set must contain exactly ${expectedOrdinals.size} records`);
  const seenOrdinals = new Set<number>();
  const seenRunIds = new Set<string>();
  const parsedRecords: DogfoodRunRecordV1[] = [];
  for (const [index, candidate] of records.entries()) {
    const parsed = dogfoodRunRecordV1Schema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(`record ${index + 1} is invalid: ${parsed.error.message}`);
      continue;
    }
    const record = parsed.data;
    parsedRecords.push(record);
    const verification = verifyDogfoodRunRecordV1(manifest, record);
    errors.push(...verification.errors.map(error => `record ${record.run_id}: ${error}`));
    if (seenOrdinals.has(record.schedule_ordinal)) errors.push(`duplicate schedule ordinal: ${record.schedule_ordinal}`);
    seenOrdinals.add(record.schedule_ordinal);
    if (seenRunIds.has(record.run_id)) errors.push(`duplicate run_id: ${record.run_id}`);
    seenRunIds.add(record.run_id);
  }
  for (const ordinal of expectedOrdinals) if (!seenOrdinals.has(ordinal)) errors.push(`missing schedule ordinal: ${ordinal}`);
  for (const record of parsedRecords) if (!expectedOrdinals.has(record.schedule_ordinal)) errors.push(`record occurs after the frozen stop ordinal: ${record.schedule_ordinal}`);
  const orderedRecords = [...parsedRecords].sort((left, right) => left.schedule_ordinal - right.schedule_ordinal);
  const firstDerivedStop = orderedRecords
    .map(record => ({ record, stopCondition: derivedStopCondition(record) }))
    .find(value => value.stopCondition !== null) ?? null;
  if (firstDerivedStop) {
    if (stopEvent === null) {
      errors.push(`derived hard stop ${firstDerivedStop.stopCondition} at ordinal ${firstDerivedStop.record.schedule_ordinal} requires a hash-bound stop event; run set cannot be COMPLETE`);
    } else {
      if (stopEvent.last_completed_schedule_ordinal !== firstDerivedStop.record.schedule_ordinal) errors.push('stop event must target the first observable derived hard-stop ordinal');
      if (stopEvent.stop_condition !== firstDerivedStop.stopCondition) errors.push('stop event must use the first observable derived hard-stop condition');
      if (stopEvent.triggering_run_id !== firstDerivedStop.record.run_id) errors.push('stop event must identify the first observable derived hard-stop run');
    }
  }
  if (manifest.run_policy.execution_mode === 'STRICT_SERIAL') {
    for (let index = 1; index < orderedRecords.length; index += 1) {
      const prior = parseTimestamp(orderedRecords[index - 1]!.completed_at);
      const current = parseTimestamp(orderedRecords[index]!.started_at);
      if (prior !== null && current !== null && current < prior) errors.push(`strict serial execution order violated between ordinals ${orderedRecords[index - 1]!.schedule_ordinal} and ${orderedRecords[index]!.schedule_ordinal}`);
    }
  }
  const expectedPairs = new Set(manifest.schedule.slice(0, expectedLastOrdinal).map(entry => `${entry.case_id}:${entry.strategy}`));
  const actualPairs = new Set(parsedRecords.map(record => `${record.case_id}:${record.strategy}`));
  if (actualPairs.size !== parsedRecords.length) errors.push('run record set must not contain duplicate case and route pairs');
  if (!stopEvent && [...expectedPairs].some(pair => !actualPairs.has(pair))) errors.push('run record set must contain each case and route exactly once');
  if (stopEvent) {
    const triggeringRun = parsedRecords.find(record => record.run_id === stopEvent.triggering_run_id);
    if (stopEvent.last_completed_schedule_ordinal > 0 && !triggeringRun) errors.push('stop event triggering run is missing from the stopped prefix');
    const stopVerification = verifyDogfoodStopEventV1(manifest, stopEvent, triggeringRun ?? null);
    if (!stopVerification.ok) errors.push(...stopVerification.errors.map(error => `stop event: ${error}`));
  }
  const status = stopEvent || firstDerivedStop ? 'STOPPED_OPERATIONAL_FAILURE' : 'COMPLETE';
  return { ok: errors.length === 0, errors, status, expected_records: expectedOrdinals.size, actual_records: records.length };
}
