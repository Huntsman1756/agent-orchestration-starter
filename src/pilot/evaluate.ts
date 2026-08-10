import { createHash } from 'node:crypto';

import { canonicalize, hashCanonical } from './canonical-json.js';
import {
  pilotEvaluationReportV3Schema,
  type PilotBlockObservationV3,
  type PilotEvaluationReportV3,
  type PilotManifestV3,
  type PilotRoutingGateV3,
} from './contracts.js';
import {
  computePilotMetrics,
  computePilotMetricsForTripletIds,
  type PilotMetricTripletV3,
  type PilotMetricsV3,
} from './metrics.js';

export interface PilotEvaluationContextV3 {
  readonly evaluation_id: string;
  readonly evaluation_version: number;
  readonly prior_report: PilotEvaluationReportV3 | null;
}

export type PilotEvaluationHistoryV3 = readonly PilotEvaluationReportV3[];

export interface DeterministicBootstrapIndicesInputV3 {
  readonly seed: string;
  readonly manifest_hash: string;
  readonly stage: 1 | 2 | 3;
  readonly population_size: number;
  readonly iterations: number;
}

type Interval = { lower: number; upper: number };
type Branch = PilotEvaluationReportV3['efficiency_branches'][number];
type Arm = 'A_STRONG_BASELINE' | 'B_CHEAP_NO_EARLY_ESCALATION' | 'C_ADAPTIVE_EARLY_ESCALATION';
type ResourceBranch = 'observed_cost' | 'observed_strong_tokens';

const arms: readonly Arm[] = [
  'A_STRONG_BASELINE',
  'B_CHEAP_NO_EARLY_ESCALATION',
  'C_ADAPTIVE_EARLY_ESCALATION',
];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).every(child => isDeepFrozen(child, seen));
}

function immutableHistorySnapshot(history: PilotEvaluationHistoryV3): PilotEvaluationHistoryV3 {
  if (isDeepFrozen(history)) return history;
  return deepFreeze(structuredClone(history));
}

export function deterministicBootstrapIndices(
  input: DeterministicBootstrapIndicesInputV3,
): readonly (readonly number[])[] {
  if (!Number.isSafeInteger(input.population_size) || input.population_size <= 0) {
    throw new RangeError('BOOTSTRAP_POPULATION_INVALID');
  }
  if (!Number.isSafeInteger(input.iterations) || input.iterations < 1) {
    throw new RangeError('BOOTSTRAP_ITERATIONS_INVALID');
  }
  const modulus = BigInt(input.population_size);
  const two64 = 1n << 64n;
  const rejectionLimit = (two64 / modulus) * modulus;
  const replicates: number[][] = [];
  for (let replicate = 0; replicate < input.iterations; replicate += 1) {
    const sample: number[] = [];
    for (let draw = 0; draw < input.population_size; draw += 1) {
      for (let nonce = 0; ; nonce += 1) {
        const digest = createHash('sha256').update(canonicalize({
          seed: input.seed,
          manifest_hash: input.manifest_hash,
          stage: input.stage,
          replicate,
          draw,
          nonce,
        }), 'utf8').digest();
        const value = digest.readBigUInt64BE(0);
        if (value < rejectionLimit) {
          sample.push(Number(value % modulus));
          break;
        }
      }
    }
    replicates.push(sample);
  }
  return deepFreeze(replicates);
}

function percentileInterval(
  statistics: readonly (number | null)[],
  confidenceLevel: number,
): Interval | null {
  if (statistics.length === 0 || statistics.some(value => value === null || !Number.isFinite(value))) return null;
  const ordered = (statistics as number[]).slice().sort((left, right) => left - right);
  const alpha = (1 - confidenceLevel) / 2;
  return {
    lower: ordered[Math.floor(alpha * (ordered.length - 1))],
    upper: ordered[Math.ceil((1 - alpha) * (ordered.length - 1))],
  };
}

function bootstrapInterval(
  manifest: PilotManifestV3,
  gate: PilotRoutingGateV3,
  triplets: readonly PilotMetricTripletV3[],
  statistic: (sample: readonly PilotMetricTripletV3[]) => number | null,
): Interval | null {
  if (triplets.length === 0) return null;
  const ordered = [...triplets].sort((left, right) => compareCodeUnits(left.pair_or_triplet_id, right.pair_or_triplet_id));
  const indices = deterministicBootstrapIndices({
    seed: gate.resampling_seed,
    manifest_hash: manifest.manifest_hash,
    stage: gate.stage,
    population_size: ordered.length,
    iterations: gate.thresholds.resampling_iterations,
  });
  return percentileInterval(indices.map(sample => statistic(sample.map(index => ordered[index]))), gate.thresholds.confidence_level);
}

function qualitySuccess(observation: PilotBlockObservationV3): boolean {
  return observation.final_accepted && !observation.post_accept_defects.some(defect => defect.material);
}

function pairedDifference(
  sample: readonly PilotMetricTripletV3[],
  predicate: (observation: PilotBlockObservationV3) => boolean,
): number | null {
  if (sample.length === 0) return null;
  const difference = sample.reduce((sum, triplet) => sum
    + Number(predicate(triplet.members.C_ADAPTIVE_EARLY_ESCALATION))
    - Number(predicate(triplet.members.A_STRONG_BASELINE)), 0);
  return difference / sample.length;
}

function resourceValue(observation: PilotBlockObservationV3, branch: ResourceBranch): number | null {
  return branch === 'observed_cost'
    ? observation.cost_observed
    : observation.strong_tokens_observed.total.value;
}

function relativeImprovement(baseline: number, candidate: number): number | null {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (baseline - candidate) / baseline;
}

function resourceAverages(sample: readonly PilotMetricTripletV3[], branch: ResourceBranch): { baseline: number; candidate: number } | null {
  let baselineNumerator = 0n;
  let candidateNumerator = 0n;
  let baselineDenominator = 0;
  let candidateDenominator = 0;
  for (const triplet of sample) {
    const baseline = triplet.members.A_STRONG_BASELINE;
    const candidate = triplet.members.C_ADAPTIVE_EARLY_ESCALATION;
    const baselineValue = resourceValue(baseline, branch);
    const candidateValue = resourceValue(candidate, branch);
    if (baselineValue === null || candidateValue === null) return null;
    if (!Number.isSafeInteger(baselineValue) || !Number.isSafeInteger(candidateValue)) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
    baselineNumerator += BigInt(baselineValue);
    candidateNumerator += BigInt(candidateValue);
    if (baselineNumerator > BigInt(Number.MAX_SAFE_INTEGER) || candidateNumerator > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
    }
    baselineDenominator += Number(baseline.final_accepted);
    candidateDenominator += Number(candidate.final_accepted);
  }
  if (baselineDenominator === 0 || candidateDenominator === 0) return null;
  return {
    baseline: Number(baselineNumerator) / baselineDenominator,
    candidate: Number(candidateNumerator) / candidateDenominator,
  };
}

function resourceImprovement(sample: readonly PilotMetricTripletV3[], branch: ResourceBranch): number | null {
  const averages = resourceAverages(sample, branch);
  return averages === null ? null : relativeImprovement(averages.baseline, averages.candidate);
}

function eligibleTriplets(metrics: PilotMetricsV3, branch: ResourceBranch): PilotMetricTripletV3[] {
  const ids = new Set(branch === 'observed_cost'
    ? metrics.populations.observed_cost_triplet_ids
    : metrics.populations.observed_strong_token_triplet_ids);
  return metrics.populations.core_triplets.filter(triplet => ids.has(triplet.pair_or_triplet_id));
}

function branchRecord(
  manifest: PilotManifestV3,
  gate: PilotRoutingGateV3,
  metrics: PilotMetricsV3,
  branch: ResourceBranch,
): Branch {
  const population = eligibleTriplets(metrics, branch);
  const core = metrics.populations.core_triplets.length;
  const completeness = core === 0 ? null : population.length / core;
  const point = resourceImprovement(population, branch);
  const averages = resourceAverages(population, branch);
  const zeroBaselineRegression = averages !== null && averages.baseline === 0 && averages.candidate > 0;
  const interval = point === null ? null : bootstrapInterval(manifest, gate, population, sample => resourceImprovement(sample, branch));
  const minimumCompleteness = branch === 'observed_cost'
    ? gate.thresholds.min_observed_cost_completeness
    : gate.thresholds.min_observed_strong_token_completeness;
  let status: Branch['status'];
  let reason: string;
  if (completeness !== null && completeness >= minimumCompleteness && zeroBaselineRegression) {
    status = 'UNUSABLE'; reason = 'zero_baseline_regression';
  } else if (core === 0 || completeness === null || completeness < minimumCompleteness || point === null) {
    status = 'UNUSABLE'; reason = branch === 'observed_cost' ? 'observed_cost_incomplete' : 'incomplete_observed_evidence';
  } else if (point >= gate.thresholds.material_improvement_rate
      && interval !== null && interval.lower >= gate.thresholds.material_improvement_rate) {
    status = 'PASS'; reason = branch === 'observed_cost'
      ? 'material_cost_improvement'
      : 'material_strong_token_improvement';
  } else if (interval !== null && interval.upper < gate.thresholds.material_improvement_rate) {
    status = 'FAIL_POINT'; reason = 'material_improvement_ruled_out';
  } else {
    status = 'AMBIGUOUS'; reason = 'decision_remains_ambiguous';
  }
  return {
    branch,
    status,
    eligible_triplets: population.length,
    completeness,
    point_improvement: point,
    confidence_interval: interval,
    reason_codes: [reason],
  } as Branch;
}

function candidateTripletIds(manifest: PilotManifestV3): string[] {
  return sortedUnique(manifest.blocks.filter(block => block.comparative_eligible).map(block => block.pair_or_triplet_id));
}

function stageLimit(stage: 1 | 2 | 3): number {
  return stage === 1 ? 10 : stage === 2 ? 20 : 30;
}

function validateGate(manifest: PilotManifestV3, gate: PilotRoutingGateV3): void {
  if (gate.pilot_id !== manifest.pilot_id || gate.manifest_hash !== manifest.manifest_hash) throw new Error('GATE_IDENTITY_MISMATCH');
  const expected = manifest.stage_thresholds;
  const expectedThresholds = {
    minimum_blocks_per_arm: stageLimit(gate.stage),
    material_improvement_rate: expected.material_improvement_rate,
    economic_rejection_rate: expected.economic_rejection_rate,
    max_parent_rework_block_rate: expected.max_parent_rework_block_rate,
    max_parent_rework_production_line_share: expected.max_parent_rework_production_line_share,
    max_escaped_material_defects: expected.max_escaped_material_defects,
    max_escaped_high_defects: expected.max_escaped_high_defects,
    max_escaped_critical_defects: expected.max_escaped_critical_defects,
    min_observed_cost_completeness: expected.min_observed_cost_completeness,
    min_observed_strong_token_completeness: expected.min_observed_strong_token_completeness,
    min_stratum_triplets_for_promotion: expected.min_stratum_triplets_for_promotion,
    confidence_level: expected.confidence_level,
    interval_algorithm_version: expected.interval_algorithm_version,
    resampling_iterations: expected.resampling_iterations,
  };
  if (canonicalize(gate.thresholds) !== canonicalize(expectedThresholds)) throw new Error('GATE_THRESHOLD_MISMATCH');

  const manifestStrata = new Map<string, { complexity_class: string; risk_class: string }>();
  for (const block of manifest.blocks) {
    const existing = manifestStrata.get(block.matching_stratum);
    if (existing && (existing.complexity_class !== block.complexity_class || existing.risk_class !== block.risk_class)) {
      throw new Error('STRATA_POLICY_INVALID');
    }
    manifestStrata.set(block.matching_stratum, { complexity_class: block.complexity_class, risk_class: block.risk_class });
  }
  if (gate.strata_policy.length !== manifestStrata.size) throw new Error('STRATA_POLICY_INVALID');
  const seen = new Set<string>();
  for (const item of gate.strata_policy) {
    const expectedStratum = manifestStrata.get(item.matching_stratum);
    const complexity: string = item.complexity_class;
    const risk: string = item.risk_class;
    if (!expectedStratum || seen.has(item.matching_stratum)
      || item.complexity_class !== expectedStratum.complexity_class || item.risk_class !== expectedStratum.risk_class
      || (item.promotion_eligible && (complexity === 'systemic' || risk === 'high' || risk === 'restricted'))
      || item.promotion_eligible === (item.exclusion_reason !== null)) throw new Error('STRATA_POLICY_INVALID');
    seen.add(item.matching_stratum);
  }
}

function gatePolicyHash(gate: PilotRoutingGateV3): string {
  const { minimum_blocks_per_arm: _minimum, ...thresholds } = gate.thresholds;
  return hashCanonical({
    schema_version: gate.schema_version,
    gate_policy_id: gate.gate_policy_id,
    pilot_id: gate.pilot_id,
    manifest_hash: gate.manifest_hash,
    resampling_seed: gate.resampling_seed,
    strata_policy: [...gate.strata_policy].sort((left, right) => compareCodeUnits(left.matching_stratum, right.matching_stratum)),
    thresholds,
  });
}

function stageObservations(
  manifest: PilotManifestV3,
  observations: readonly PilotBlockObservationV3[],
  selectedIds: ReadonlySet<string>,
): PilotBlockObservationV3[] {
  const blocks = new Map(manifest.blocks.map(block => [block.block_id, block]));
  return observations.filter(observation => {
    const block = blocks.get(observation.block_id);
    if (!block) return true;
    if (!block.comparative_eligible) return true;
    return selectedIds.has(block.pair_or_triplet_id);
  });
}

function decisionInputHash(
  _manifest: PilotManifestV3,
  observations: readonly PilotBlockObservationV3[],
  _selectedIds: ReadonlySet<string>,
): string {
  const normalized = observations.map(observation => ({
      ...structuredClone(observation),
      post_accept_defects: [],
      post_accept_defects_count: 0,
      post_accept_max_severity: null,
      post_acceptance_window_closed: false,
      late_quality_evidence_count: 0,
      quality_warnings: [],
    })).map(observation => ({ observation, hash: hashCanonical(observation) }))
    .sort((left, right) => {
      const leftTuple = [left.observation.block_id, left.observation.pilot_arm ?? '', left.observation.task_id,
        left.observation.pair_or_triplet_id, left.hash];
      const rightTuple = [right.observation.block_id, right.observation.pilot_arm ?? '', right.observation.task_id,
        right.observation.pair_or_triplet_id, right.hash];
      for (let index = 0; index < leftTuple.length; index += 1) {
        const comparison = compareCodeUnits(leftTuple[index], rightTuple[index]);
        if (comparison !== 0) return comparison;
      }
      return 0;
    }).map(item => item.observation);
  return hashCanonical(normalized);
}

function withIntervals(
  manifest: PilotManifestV3,
  gate: PilotRoutingGateV3,
  metrics: PilotMetricsV3,
  branches: readonly [Branch, Branch],
): PilotEvaluationReportV3['metrics'] {
  const result = structuredClone(metrics.metrics) as PilotEvaluationReportV3['metrics'];
  const core = metrics.populations.core_triplets;
  result.paired_comparisons.final_acceptance.confidence_interval = bootstrapInterval(
    manifest, gate, core, sample => pairedDifference(sample, observation => observation.final_accepted),
  )!;
  result.paired_comparisons.final_quality.confidence_interval = bootstrapInterval(
    manifest, gate, core, sample => pairedDifference(sample, qualitySuccess),
  )!;
  result.paired_comparisons.observed_cost_per_accepted_block.confidence_interval = branches[0].confidence_interval;
  result.paired_comparisons.strong_tokens_observed_per_accepted_block.confidence_interval = branches[1].confidence_interval;
  return result;
}

function hardRejectReasons(
  metrics: PilotMetricsV3,
  branches: readonly [Branch, Branch],
  gate: PilotRoutingGateV3,
  globalIntegrityReasons: readonly string[],
): string[] {
  const reasons: string[] = [];
  const hardExclusionReasons = new Set([
    'duplicate_observation', 'manifest_identity_mismatch', 'invalid_event_history',
    'reviewer_session_not_independent', 'isolation_violation',
  ]);
  if (globalIntegrityReasons.length > 0
    || metrics.exclusions.some(exclusion => exclusion.reason_codes.some(reason => hardExclusionReasons.has(reason)))) {
    reasons.push('integrity_failure', ...globalIntegrityReasons);
  }
  const candidate = metrics.metrics.by_arm.C_ADAPTIVE_EARLY_ESCALATION;
  const paired = metrics.metrics.paired_comparisons;
  if ((paired.final_acceptance.difference ?? 0) < 0) reasons.push('final_acceptance_below_baseline');
  if ((paired.final_quality.difference ?? 0) < 0) reasons.push('final_quality_below_baseline');
  if (candidate.escaped_material_defect_rate.numerator > gate.thresholds.max_escaped_material_defects) reasons.push('material_post_accept_defect');
  if (candidate.escaped_high_defects.numerator > gate.thresholds.max_escaped_high_defects) reasons.push('high_post_accept_defect');
  if (candidate.escaped_critical_defects.numerator > gate.thresholds.max_escaped_critical_defects) reasons.push('critical_post_accept_defect');
  if ((candidate.parent_rework_block_rate.value ?? 0) > gate.thresholds.max_parent_rework_block_rate) reasons.push('parent_rework_block_rate_above_maximum');
  if ((candidate.parent_rework_production_line_share.value ?? 0) > gate.thresholds.max_parent_rework_production_line_share) reasons.push('parent_rework_line_share_above_maximum');
  const wall = paired.wall_time_per_accepted_block;
  if (wall.baseline_value !== null && wall.candidate_value !== null && wall.candidate_value > wall.baseline_value) reasons.push('wall_time_above_baseline');
  if (branches[0].completeness !== null
    && branches[0].completeness >= gate.thresholds.min_observed_cost_completeness
    && ((branches[0].point_improvement !== null
      && branches[0].point_improvement <= -gate.thresholds.economic_rejection_rate)
      || branches[0].reason_codes.includes('zero_baseline_regression'))) {
    reasons.push('economic_regression_above_rejection_threshold');
  }
  return sortedUnique(reasons);
}

function stratumReports(
  manifest: PilotManifestV3,
  gate: PilotRoutingGateV3,
  observations: readonly PilotBlockObservationV3[],
  selectedIds: ReadonlySet<string>,
): PilotEvaluationReportV3['strata'] {
  const policy = new Map(gate.strata_policy.map(value => [value.matching_stratum, value]));
  const stratumNames = [...policy.keys()].sort(compareCodeUnits);
  return stratumNames.map(matchingStratum => {
    const ids = new Set(manifest.blocks.filter(block => selectedIds.has(block.pair_or_triplet_id)
      && block.matching_stratum === matchingStratum).map(block => block.pair_or_triplet_id));
    const metrics = computePilotMetricsForTripletIds(manifest, observations, ids);
    const branches = [
      branchRecord(manifest, gate, metrics, 'observed_cost'),
      branchRecord(manifest, gate, metrics, 'observed_strong_tokens'),
    ] as const;
    const acceptance = structuredClone(metrics.metrics.paired_comparisons.final_acceptance) as PilotEvaluationReportV3['strata'][number]['paired_final_acceptance'];
    const quality = structuredClone(metrics.metrics.paired_comparisons.final_quality) as PilotEvaluationReportV3['strata'][number]['paired_final_quality'];
    acceptance.confidence_interval = bootstrapInterval(manifest, gate, metrics.populations.core_triplets, sample => pairedDifference(sample, value => value.final_accepted))!;
    quality.confidence_interval = bootstrapInterval(manifest, gate, metrics.populations.core_triplets, sample => pairedDifference(sample, qualitySuccess))!;
    const support = metrics.strata_support.find(value => value.matching_stratum === matchingStratum)
      ?? { matching_stratum: matchingStratum, candidate_triplets: 0, admitted_triplets: 0 };
    const reasons: string[] = [];
    if (!policy.get(matchingStratum)?.promotion_eligible) reasons.push('stratum_policy_ineligible');
    if (support.admitted_triplets < gate.thresholds.min_stratum_triplets_for_promotion) reasons.push('insufficient_stratum_support');
    if (acceptance.confidence_interval === null || acceptance.confidence_interval.lower < 0) reasons.push('stratum_acceptance_not_supported');
    if (quality.confidence_interval === null || quality.confidence_interval.lower < 0) reasons.push('stratum_quality_not_supported');
    if (!branches.some(branch => branch.status === 'PASS')) reasons.push('stratum_efficiency_not_supported');
    const promoted = reasons.length === 0;
    return {
      matching_stratum: matchingStratum,
      candidate_triplets: support.candidate_triplets,
      admitted_triplets: support.admitted_triplets,
      status: promoted ? 'PROMOTED' : 'NOT_VALIDATED',
      reason_codes: promoted ? ['stratum_promotion_supported'] : sortedUnique(reasons),
      paired_final_acceptance: acceptance,
      paired_final_quality: quality,
      efficiency_branches: branches,
    } as PilotEvaluationReportV3['strata'][number];
  });
}

function validateContext(
  manifest: PilotManifestV3,
  gate: PilotRoutingGateV3,
  context: PilotEvaluationContextV3,
  metrics: PilotMetricsV3,
  policyHash: string,
  inputHash: string,
): void {
  const prior = context.prior_report;
  if (context.evaluation_version === 1) {
    if (prior !== null) throw new Error('EVALUATION_SUPERSESSION_INVALID');
    if (gate.stage !== 1) throw new Error('EVALUATION_STAGE_SEQUENCE_INVALID');
    return;
  }
  if (!prior || context.evaluation_version !== prior.evaluation_version + 1
    || prior.pilot_id !== manifest.pilot_id || prior.manifest_hash !== manifest.manifest_hash) {
    throw new Error('EVALUATION_SUPERSESSION_INVALID');
  }
  if (gate.stage < prior.stage || gate.stage > prior.stage + 1) throw new Error('EVALUATION_STAGE_SEQUENCE_INVALID');
  if ((prior.decision === 'REJECT' || prior.decision === 'PROMOTE_BOUNDED') && gate.stage > prior.stage) throw new Error('TERMINAL_DECISION_CANNOT_ADVANCE');
  if (policyHash !== prior.gate_policy_hash) throw new Error('GATE_POLICY_CHANGED');
  if (metrics.late_quality_evidence_count < prior.late_quality_evidence_count) throw new Error('LATE_QUALITY_EVIDENCE_DECREASED');
  if (metrics.quality_evidence_count < prior.quality_evidence_count) throw new Error('QUALITY_EVIDENCE_DECREASED');
  if (gate.stage === prior.stage && metrics.quality_evidence_count <= prior.quality_evidence_count) {
    throw new Error('QUALITY_EVIDENCE_NOT_INCREASED');
  }
  if (gate.stage === prior.stage && inputHash !== prior.decision_input_hash) throw new Error('DECISION_INPUT_CHANGED');
}

export function evaluatePilot(
  manifest: PilotManifestV3,
  observations: readonly PilotBlockObservationV3[],
  gate: PilotRoutingGateV3,
  context: PilotEvaluationContextV3,
): PilotEvaluationReportV3 {
  validateGate(manifest, gate);
  const prefixIds = candidateTripletIds(manifest).slice(0, stageLimit(gate.stage));
  const selectedIds = new Set(prefixIds);
  const scopedObservations = stageObservations(manifest, observations, selectedIds);
  const computed = computePilotMetricsForTripletIds(manifest, scopedObservations, selectedIds);
  const fullEvidence = computePilotMetrics(manifest, observations);
  const policyHash = gatePolicyHash(gate);
  const inputHash = decisionInputHash(manifest, observations, selectedIds);
  validateContext(manifest, gate, context, fullEvidence, policyHash, inputHash);
  const branches = [
    branchRecord(manifest, gate, computed, 'observed_cost'),
    branchRecord(manifest, gate, computed, 'observed_strong_tokens'),
  ] as const;
  const hardReasons = hardRejectReasons(computed, branches, gate, computed.integrity_reasons);
  const candidateStrata = stratumReports(manifest, gate, scopedObservations, selectedIds);
  const independentlyPromoted = candidateStrata.filter(stratum => stratum.status === 'PROMOTED').map(stratum => stratum.matching_stratum);
  const reportMetrics = withIntervals(manifest, gate, computed, branches);
  const globallyAmbiguousQuality = [
    reportMetrics.paired_comparisons.final_acceptance.confidence_interval,
    reportMetrics.paired_comparisons.final_quality.confidence_interval,
  ].some(interval => interval !== null && interval.lower < 0);
  const warnings: string[] = [];
  const wallCompleteness = computed.completeness.wall_time_by_arm;
  const wallTimeComplete = wallCompleteness.A_STRONG_BASELINE === 1
    && wallCompleteness.C_ADAPTIVE_EARLY_ESCALATION === 1;
  if (fullEvidence.late_quality_evidence_count > 0 && context.evaluation_version === 1) warnings.push('LATE_QUALITY_EVIDENCE');
  if (context.prior_report && fullEvidence.late_quality_evidence_count > context.prior_report.late_quality_evidence_count) warnings.push('STALE_DECISION');

  const reasons: string[] = [];
  let decision: PilotEvaluationReportV3['decision'];
  let promotedStrata: string[] = [];
  if (hardReasons.length > 0) {
    decision = 'REJECT'; reasons.push(...hardReasons);
  } else if (computed.denominators.admitted_triplets < gate.thresholds.minimum_blocks_per_arm) {
    decision = gate.stage === 1 ? 'CONTINUE' : gate.stage === 2 ? 'INSUFFICIENT_EVIDENCE' : 'INCONCLUSIVE';
    reasons.push('insufficient_comparable_samples');
  } else if (gate.stage === 1) {
    decision = 'CONTINUE'; reasons.push('stage_1_cannot_promote');
  } else if (globallyAmbiguousQuality) {
    decision = gate.stage === 2 ? 'CONTINUE' : 'INCONCLUSIVE'; reasons.push('decision_remains_ambiguous');
  } else if (branches.some(branch => branch.status === 'PASS') && !wallTimeComplete) {
    decision = gate.stage === 2 ? 'INSUFFICIENT_EVIDENCE' : 'INCONCLUSIVE'; reasons.push('wall_time_incomplete');
  } else if (branches.some(branch => branch.status === 'PASS') && independentlyPromoted.length > 0) {
    decision = 'PROMOTE_BOUNDED'; promotedStrata = independentlyPromoted;
    reasons.push('bounded_promotion_supported', ...branches.filter(branch => branch.status === 'PASS').flatMap(branch => branch.reason_codes));
  } else if (branches.some(branch => branch.status === 'PASS')) {
    decision = gate.stage === 2 ? 'INSUFFICIENT_EVIDENCE' : 'INCONCLUSIVE'; reasons.push('no_independently_validated_strata');
  } else if (branches.some(branch => branch.status === 'AMBIGUOUS')) {
    decision = gate.stage === 2 ? 'CONTINUE' : 'INCONCLUSIVE'; reasons.push('decision_remains_ambiguous');
  } else if (branches.every(branch => branch.status === 'FAIL_POINT')) {
    decision = 'REJECT'; reasons.push('material_improvement_ruled_out');
  } else {
    decision = gate.stage === 2 ? 'INSUFFICIENT_EVIDENCE' : 'INCONCLUSIVE';
    reasons.push('insufficient_observed_economic_evidence', ...branches.filter(branch => branch.status === 'UNUSABLE').flatMap(branch => branch.reason_codes));
  }
  if (context.prior_report && gate.stage === context.prior_report.stage && decision === 'PROMOTE_BOUNDED'
    && (context.prior_report.decision === 'REJECT'
      || (context.prior_report.stage === 3 && context.prior_report.decision !== 'PROMOTE_BOUNDED'))) {
    throw new Error('TERMINAL_DECISION_CANNOT_PROMOTE');
  }

  const strata = decision === 'PROMOTE_BOUNDED' ? candidateStrata : candidateStrata.map(stratum => stratum.status === 'NOT_VALIDATED'
    ? stratum
    : {
      ...stratum,
      status: 'NOT_VALIDATED' as const,
      reason_codes: sortedUnique([...stratum.reason_codes, 'global_outcome_not_promoted']),
    });
  promotedStrata = strata.filter(stratum => stratum.status === 'PROMOTED').map(stratum => stratum.matching_stratum);

  const prior = context.prior_report;
  const reportCandidate = {
    schema_version: 3,
    evaluation_id: context.evaluation_id,
    evaluation_version: context.evaluation_version,
    pilot_id: manifest.pilot_id,
    manifest_hash: manifest.manifest_hash,
    evaluated_at: gate.evaluated_at,
    stage: gate.stage,
    decision,
    promoted_strata: sortedUnique(promotedStrata),
    not_validated_strata: strata.filter(stratum => stratum.status === 'NOT_VALIDATED').map(stratum => stratum.matching_stratum).sort(compareCodeUnits),
    reasons: sortedUnique(reasons),
    observation_set_hash: fullEvidence.observation_set_hash,
    decision_input_hash: inputHash,
    quality_evidence_hash: fullEvidence.quality_evidence_hash,
    quality_evidence_count: fullEvidence.quality_evidence_count,
    late_quality_evidence_count: fullEvidence.late_quality_evidence_count,
    gate_policy_hash: policyHash,
    metrics: reportMetrics,
    exclusions: computed.exclusions,
    efficiency_branches: branches,
    strata,
    operational_totals: fullEvidence.operational_totals,
    denominators: computed.denominators,
    completeness: computed.completeness,
    interval_metadata: {
      confidence_level: gate.thresholds.confidence_level,
      interval_algorithm_version: gate.thresholds.interval_algorithm_version,
      resampling_iterations: gate.thresholds.resampling_iterations,
      resampling_seed: gate.resampling_seed,
    },
    warnings: sortedUnique(warnings),
    supersedes_evaluation_id: prior?.evaluation_id ?? null,
    supersedes_evaluation_version: prior?.evaluation_version ?? null,
    expected_superseded_report_hash: prior ? hashCanonical(prior) : null,
  };
  const parsed = pilotEvaluationReportV3Schema.safeParse(reportCandidate);
  if (!parsed.success) throw new Error(`EVALUATION_REPORT_INVALID:${parsed.error.issues.map(issue => `${issue.path.join('.')}:${issue.message}`).join(';')}`);
  return deepFreeze(parsed.data);
}

function validateHistoryTransition(prior: PilotEvaluationReportV3, report: PilotEvaluationReportV3): void {
  if (report.pilot_id !== prior.pilot_id || report.manifest_hash !== prior.manifest_hash
    || report.evaluation_version !== prior.evaluation_version + 1
    || report.supersedes_evaluation_id !== prior.evaluation_id
    || report.supersedes_evaluation_version !== prior.evaluation_version
    || report.expected_superseded_report_hash !== hashCanonical(prior)) throw new Error('EVALUATION_SUPERSESSION_INVALID');
  if (report.gate_policy_hash !== prior.gate_policy_hash) throw new Error('GATE_POLICY_CHANGED');
  if (report.stage < prior.stage || report.stage > prior.stage + 1) throw new Error('EVALUATION_STAGE_SEQUENCE_INVALID');
  if ((prior.decision === 'REJECT' || prior.decision === 'PROMOTE_BOUNDED') && report.stage > prior.stage) throw new Error('TERMINAL_DECISION_CANNOT_ADVANCE');
  if (report.late_quality_evidence_count < prior.late_quality_evidence_count) throw new Error('LATE_QUALITY_EVIDENCE_DECREASED');
  if (report.quality_evidence_count < prior.quality_evidence_count) throw new Error('QUALITY_EVIDENCE_DECREASED');
  if (report.stage === prior.stage && report.quality_evidence_count <= prior.quality_evidence_count) {
    if (report.quality_evidence_hash !== prior.quality_evidence_hash) throw new Error('QUALITY_EVIDENCE_DECREASED');
    throw new Error('QUALITY_EVIDENCE_NOT_INCREASED');
  }
  if (report.stage === prior.stage && report.decision_input_hash !== prior.decision_input_hash) throw new Error('DECISION_INPUT_CHANGED');
  if (report.stage === prior.stage && report.decision === 'PROMOTE_BOUNDED'
    && (prior.decision === 'REJECT' || (prior.stage === 3 && prior.decision !== 'PROMOTE_BOUNDED'))) throw new Error('TERMINAL_DECISION_CANNOT_PROMOTE');
}

export function appendEvaluation(
  history: PilotEvaluationHistoryV3,
  report: PilotEvaluationReportV3,
): PilotEvaluationHistoryV3 {
  const reportHash = hashCanonical(report);
  for (const existing of history) {
    const sameIdentity = existing.evaluation_id === report.evaluation_id
      || (existing.pilot_id === report.pilot_id && existing.evaluation_version === report.evaluation_version);
    if (!sameIdentity) continue;
    if (hashCanonical(existing) === reportHash && canonicalize(existing) === canonicalize(report)) {
      return immutableHistorySnapshot(history);
    }
    throw new Error('EVALUATION_IDENTITY_COLLISION');
  }
  const parsed = pilotEvaluationReportV3Schema.safeParse(report);
  if (!parsed.success) throw new Error('EVALUATION_REPORT_INVALID');
  if (history.length === 0) {
    if (report.evaluation_version !== 1 || report.stage !== 1 || report.supersedes_evaluation_id !== null
      || report.supersedes_evaluation_version !== null || report.expected_superseded_report_hash !== null) {
      throw new Error('EVALUATION_SUPERSESSION_INVALID');
    }
  } else {
    validateHistoryTransition(history[history.length - 1], report);
  }
  return deepFreeze(structuredClone([...history, parsed.data]));
}
