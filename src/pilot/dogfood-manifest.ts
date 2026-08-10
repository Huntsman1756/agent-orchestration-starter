import { z } from 'zod';

import { hashCanonical } from './canonical-json.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
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
const sourceSensitivity = z.enum(['PUBLIC', 'PRIVATE', 'RESTRICTED']);
const riskClass = z.enum(['low', 'medium', 'high', 'restricted']);
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const metric = z.enum(DOGFOOD_REQUIRED_METRICS_V1);
const stopCondition = z.enum(DOGFOOD_STOP_CONDITIONS_V1);

const baselineSchema = z.object({
  runtime_commit_sha: commitSha,
  policy_hash: hash,
  profile_hash: hash,
  worker_capability_hash: hash,
  guidance_bundle_hash: hash,
  harness_parser_hash: hash,
  host_driver_hash: hash,
  host_certification_hash: hash,
  installation_manifest_hash: hash,
  validation_surface_hash: hash,
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
}).strict();

const reviewerSchema = z.object({
  binding_ref: identifier,
  binding_hash: hash,
  qualification_hash: hash,
  review_policy_hash: hash,
  evidence_packet_schema_hash: hash,
  fresh_session_per_run: z.literal(true),
  same_packet_shape: z.literal(true),
  sees_executor_narrative: z.literal(false),
  sees_other_route_result: z.literal(false),
  scope: z.literal('EVIDENCE_ONLY'),
}).strict();

const runPolicySchema = z.object({
  same_base_sha: z.literal(true),
  same_fixtures: z.literal(true),
  same_validation_surface: z.literal(true),
  fresh_worktree_per_run: z.literal(true),
  cross_run_workspace_reuse: z.literal(false),
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
  corpus_policy: corpusPolicySchema,
  cases: z.array(caseSchema).min(1).max(30),
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

export function loadDogfoodManifestV1(value: unknown): DogfoodManifestV1 {
  return dogfoodManifestV1Schema.parse(value);
}

export function loadDogfoodRunRecordV1(value: unknown): DogfoodRunRecordV1 {
  return dogfoodRunRecordV1Schema.parse(value);
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
    profile_hash: manifest.baseline.profile_hash,
    worker_capability_hash: manifest.baseline.worker_capability_hash,
    guidance_bundle_hash: manifest.baseline.guidance_bundle_hash,
    harness_parser_hash: manifest.baseline.harness_parser_hash,
    host_driver_hash: manifest.baseline.host_driver_hash,
    host_certification_hash: manifest.baseline.host_certification_hash,
    installation_manifest_hash: manifest.baseline.installation_manifest_hash,
  })) if (record[field as keyof DogfoodRunRecordV1] !== expected) errors.push(`record ${field} does not match frozen baseline`);
  if (record.publication_state !== 'MANUAL_PENDING' && record.publication_state !== 'NOT_REQUESTED') errors.push('record publication state is not manual');
  return { ok: errors.length === 0, errors };
}
