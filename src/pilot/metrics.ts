import { canonicalize, hashCanonical } from './canonical-json.js';
import type { PilotBlockObservationV3, PilotEvaluationReportV3, PilotManifestV3 } from './contracts.js';
import { verifyManifest } from './manifest.js';

export const pilotArms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;
export type PilotArmV3 = (typeof pilotArms)[number];

type ReportMetrics = PilotEvaluationReportV3['metrics'];
type PairedComparisons = ReportMetrics['paired_comparisons'];
type PointPairedQuality = Omit<PairedComparisons['final_acceptance'], 'confidence_interval'> & { confidence_interval: null };
type PointMetrics = Omit<ReportMetrics, 'paired_comparisons'> & {
  paired_comparisons: Omit<PairedComparisons, 'final_acceptance' | 'final_quality'> & {
    final_acceptance: PointPairedQuality;
    final_quality: PointPairedQuality;
  };
};
type ResourceTotalsV3 = PilotEvaluationReportV3['operational_totals']['direct_to_strong'];

export interface PilotMetricTripletV3 {
  pair_or_triplet_id: string;
  matching_stratum: string;
  members: Record<PilotArmV3, PilotBlockObservationV3>;
}

export interface PilotMetricsV3 {
  metrics: PointMetrics;
  exclusions: PilotEvaluationReportV3['exclusions'];
  operational_totals: PilotEvaluationReportV3['operational_totals'];
  denominators: PilotEvaluationReportV3['denominators'];
  completeness: PilotEvaluationReportV3['completeness'];
  observation_set_hash: string;
  quality_evidence_hash: string;
  quality_evidence_count: number;
  late_quality_evidence_count: number;
  integrity_reasons: string[];
  strata_support: Array<{ matching_stratum: string; candidate_triplets: number; admitted_triplets: number }>;
  populations: {
    core_triplets: PilotMetricTripletV3[];
    core_triplet_ids: string[];
    observed_cost_triplet_ids: string[];
    estimated_cost_triplet_ids: string[];
    observed_strong_token_triplet_ids: string[];
    estimated_strong_token_triplet_ids: string[];
    observed_all_role_token_triplet_ids: string[];
    estimated_all_role_token_triplet_ids: string[];
  };
}

type ResourceKey = keyof ResourceTotalsV3;
type ResourceDatum = { value: number | null; complete: boolean; total: 0 | 1 };

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

function checkedIntegerSum(values: readonly number[]): number {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
    total += BigInt(value);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
  }
  return Number(total);
}

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(JSON.stringify(value));
  if (!match) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function exactDecimalSum(values: readonly number[]): number {
  const parts = values.map(decimalParts);
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0);
  const coefficient = parts.reduce((total, part) => total + part.coefficient * 10n ** BigInt(scale - part.scale), 0n);
  const digits = coefficient.toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const value = Number(text);
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) throw new RangeError('SAFE_METRIC_ARITHMETIC_INVALID');
  return value;
}

function resourceDatum(observation: PilotBlockObservationV3, key: ResourceKey): ResourceDatum {
  const hasOperations = observation.total_usage.operations > 0;
  switch (key) {
    case 'wall_time_seconds':
      return { value: observation.wall_time_seconds, complete: observation.wall_time_seconds !== null, total: 1 };
    case 'cost_observed':
      return {
        value: hasOperations ? observation.cost_observed : 0,
        complete: hasOperations && observation.cost_observed !== null && observation.cost_observed_completeness === 1,
        total: hasOperations ? 1 : 0,
      };
    case 'cost_estimated':
      return {
        value: hasOperations ? observation.cost_estimated : 0,
        complete: hasOperations && observation.cost_estimated !== null && observation.cost_estimated_completeness === 1,
        total: hasOperations ? 1 : 0,
      };
    case 'strong_tokens_observed':
      return {
        value: hasOperations ? observation.strong_tokens_observed.total.value : 0,
        complete:
          hasOperations &&
          observation.strong_tokens_observed.total.value !== null &&
          observation.strong_tokens_observed.total.completeness_ratio === 1,
        total: hasOperations ? 1 : 0,
      };
    case 'strong_tokens_estimated':
      return {
        value: hasOperations ? observation.strong_tokens_estimated.total.value : 0,
        complete:
          hasOperations &&
          observation.strong_tokens_estimated.total.value !== null &&
          observation.strong_tokens_estimated.total.completeness_ratio === 1,
        total: hasOperations ? 1 : 0,
      };
    case 'all_role_tokens_observed':
      return {
        value: hasOperations ? observation.total_usage.observed_tokens : 0,
        complete: hasOperations && observation.total_usage.observed_tokens !== null,
        total: hasOperations ? 1 : 0,
      };
    case 'all_role_tokens_estimated':
      return {
        value: hasOperations ? observation.total_usage.estimated_tokens : 0,
        complete: hasOperations && observation.total_usage.estimated_tokens !== null,
        total: hasOperations ? 1 : 0,
      };
  }
}

function hasZeroOperationEconomicValue(observation: PilotBlockObservationV3): boolean {
  return (
    observation.total_usage.operations === 0 &&
    [
      observation.cost_observed,
      observation.cost_estimated,
      observation.strong_tokens_observed.total.value,
      observation.strong_tokens_estimated.total.value,
      observation.total_usage.observed_tokens,
      observation.total_usage.estimated_tokens,
    ].some((value) => value !== null && value !== 0)
  );
}

function resourceMeasure(data: readonly ResourceDatum[], key: ResourceKey): ResourceTotalsV3[ResourceKey] {
  const known = data.flatMap((item) => (item.value === null ? [] : [item.value]));
  const complete = data.filter((item) => item.total === 1 && item.complete).length;
  const total = data.reduce((sum, item) => sum + item.total, 0);
  const knownSum = key === 'wall_time_seconds' ? exactDecimalSum(known) : checkedIntegerSum(known);
  return {
    known_sum: knownSum,
    complete,
    total,
    completeness_ratio: total === 0 ? null : complete / total,
    complete_value: complete === total ? knownSum : null,
  };
}

function resourceTotals(observations: readonly PilotBlockObservationV3[]): ResourceTotalsV3 {
  return {
    wall_time_seconds: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'wall_time_seconds')),
      'wall_time_seconds',
    ),
    cost_observed: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'cost_observed')),
      'cost_observed',
    ),
    cost_estimated: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'cost_estimated')),
      'cost_estimated',
    ),
    strong_tokens_observed: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'strong_tokens_observed')),
      'strong_tokens_observed',
    ),
    strong_tokens_estimated: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'strong_tokens_estimated')),
      'strong_tokens_estimated',
    ),
    all_role_tokens_observed: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'all_role_tokens_observed')),
      'all_role_tokens_observed',
    ),
    all_role_tokens_estimated: resourceMeasure(
      observations.map((value) => resourceDatum(value, 'all_role_tokens_estimated')),
      'all_role_tokens_estimated',
    ),
  };
}

function observationSetHash(observations: readonly PilotBlockObservationV3[]): string {
  const ordered = observations
    .map((observation) => ({ observation, hash: hashCanonical(observation) }))
    .sort((left, right) => {
      const leftTuple = [
        left.observation.block_id,
        left.observation.pilot_arm ?? '',
        left.observation.task_id,
        left.observation.pair_or_triplet_id,
        left.hash,
      ];
      const rightTuple = [
        right.observation.block_id,
        right.observation.pilot_arm ?? '',
        right.observation.task_id,
        right.observation.pair_or_triplet_id,
        right.hash,
      ];
      for (let index = 0; index < leftTuple.length; index += 1) {
        const comparison = compareCodeUnits(leftTuple[index], rightTuple[index]);
        if (comparison !== 0) return comparison;
      }
      return 0;
    })
    .map((item) => JSON.parse(canonicalize(item.observation)) as unknown);
  return hashCanonical(ordered);
}

function qualityEvidence(observations: readonly PilotBlockObservationV3[]): { hash: string; count: number } {
  const defects = observations.flatMap((observation) =>
    observation.post_accept_defects.map((defect) => ({
      block_id: observation.block_id,
      arm: observation.pilot_arm,
      task_id: observation.task_id,
      pair_or_triplet_id: observation.pair_or_triplet_id,
      defect,
    })),
  );
  const lateMarkers = observations.flatMap((observation) =>
    observation.late_quality_evidence_count === 0
      ? []
      : [
          {
            block_id: observation.block_id,
            arm: observation.pilot_arm,
            task_id: observation.task_id,
            pair_or_triplet_id: observation.pair_or_triplet_id,
            late_quality_evidence_count: observation.late_quality_evidence_count,
          },
        ],
  );
  const closureMarkers = observations.flatMap((observation) =>
    observation.final_outcome === 'ACCEPTED' && observation.post_acceptance_window_closed
      ? [
          {
            block_id: observation.block_id,
            arm: observation.pilot_arm,
            task_id: observation.task_id,
            pair_or_triplet_id: observation.pair_or_triplet_id,
            post_acceptance_window_closed: true as const,
          },
        ]
      : [],
  );
  const records = [...defects, ...lateMarkers, ...closureMarkers];
  const ordered = records
    .map((record) => ({ record, hash: hashCanonical(record) }))
    .sort((left, right) => compareCodeUnits(left.hash, right.hash))
    .map((item) => item.record);
  const count = checkedIntegerSum([
    defects.length,
    closureMarkers.length,
    ...observations.map((observation) => observation.late_quality_evidence_count),
  ]);
  return { hash: hashCanonical(ordered), count };
}

function identityMatches(
  manifest: PilotManifestV3,
  block: PilotManifestV3['blocks'][number],
  arm: PilotArmV3,
  observation: PilotBlockObservationV3,
): boolean {
  return baseIdentityMatches(manifest, block, observation) && observation.pilot_arm === arm && observation.comparative_eligible;
}

function baseIdentityMatches(
  manifest: PilotManifestV3,
  block: PilotManifestV3['blocks'][number],
  observation: PilotBlockObservationV3,
): boolean {
  return (
    observation.pilot_id === manifest.pilot_id &&
    observation.manifest_hash === manifest.manifest_hash &&
    observation.block_id === block.block_id &&
    observation.task_id === block.task_id &&
    observation.matching_stratum === block.matching_stratum &&
    observation.pair_or_triplet_id === block.pair_or_triplet_id &&
    observation.case_fingerprint === block.case_fingerprint &&
    observation.complexity_class === block.complexity_class &&
    observation.risk_class === block.risk_class &&
    observation.changed_line_band === block.changed_line_band &&
    observation.cheap_eligible === block.cheap_eligible &&
    observation.comparative_eligible === block.comparative_eligible
  );
}

function exclusionReasons(
  manifest: PilotManifestV3,
  block: PilotManifestV3['blocks'][number],
  arm: PilotArmV3,
  matches: readonly PilotBlockObservationV3[],
): string[] {
  const reasons = new Set<string>();
  if (matches.length === 0) reasons.add('missing_observation');
  if (matches.length > 1) reasons.add('duplicate_observation');
  for (const observation of matches) {
    if (!identityMatches(manifest, block, arm, observation)) reasons.add('manifest_identity_mismatch');
    if (!observation.valid_history || observation.final_outcome === 'INVALID') {
      reasons.add('invalid_event_history');
      for (const reason of observation.invalid_reason_codes) reasons.add(reason);
    }
    if (hasZeroOperationEconomicValue(observation)) reasons.add('zero_operation_economic_value');
    if (observation.final_outcome === 'BLOCKED') reasons.add('blocked_observation');
    if (observation.final_outcome !== 'ACCEPTED' && observation.final_outcome !== 'FAILED') reasons.add('nonterminal_observation');
    if (observation.final_outcome === 'ACCEPTED' && !observation.post_acceptance_window_closed) reasons.add('quality_window_open');
  }
  return [...reasons].sort(compareCodeUnits);
}

function metric(numerator: number, denominator: number, complete = true) {
  return {
    numerator,
    denominator,
    value: complete && denominator > 0 ? numerator / denominator : null,
    confidence_interval: null,
  };
}

function qualitySuccess(observation: PilotBlockObservationV3): boolean {
  return observation.final_accepted && !observation.post_accept_defects.some((defect) => defect.material);
}

function pairedQuality(
  triplets: readonly PilotMetricTripletV3[],
  predicate: (value: PilotBlockObservationV3) => boolean,
): PointPairedQuality {
  let both = 0;
  let baselineOnly = 0;
  let candidateOnly = 0;
  let neither = 0;
  for (const triplet of triplets) {
    const baseline = predicate(triplet.members.A_STRONG_BASELINE);
    const candidate = predicate(triplet.members.C_ADAPTIVE_EARLY_ESCALATION);
    if (baseline && candidate) both += 1;
    else if (baseline) baselineOnly += 1;
    else if (candidate) candidateOnly += 1;
    else neither += 1;
  }
  const denominator = triplets.length;
  const baselineSuccesses = both + baselineOnly;
  const candidateSuccesses = both + candidateOnly;
  return {
    baseline_successes: baselineSuccesses,
    candidate_successes: candidateSuccesses,
    both_success: both,
    baseline_only_success: baselineOnly,
    candidate_only_success: candidateOnly,
    neither_success: neither,
    denominator,
    difference: denominator === 0 ? null : (candidateSuccesses - baselineSuccesses) / denominator,
    confidence_interval: null,
  } as PointPairedQuality;
}

function relativeImprovement(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (baseline - candidate) / baseline;
}

function pairedMetric(baseline: number | null, candidate: number | null) {
  return {
    baseline_value: baseline,
    candidate_value: candidate,
    relative_improvement: relativeImprovement(baseline, candidate),
    confidence_interval: null,
  };
}

function tripletPopulation(triplets: readonly PilotMetricTripletV3[], key: ResourceKey): PilotMetricTripletV3[] {
  return triplets.filter((triplet) => pilotArms.every((arm) => resourceDatum(triplet.members[arm], key).complete));
}

function populationMetric(population: readonly PilotMetricTripletV3[], arm: PilotArmV3, key: ResourceKey) {
  const observations = population.map((triplet) => triplet.members[arm]);
  const numeric = observations.map((value) => resourceDatum(value, key).value ?? 0);
  const numerator = key === 'wall_time_seconds' ? exactDecimalSum(numeric) : checkedIntegerSum(numeric);
  const denominator = observations.filter((value) => value.final_accepted).length;
  return metric(numerator, denominator);
}

function completenessByArm(triplets: readonly PilotMetricTripletV3[], key: ResourceKey): Record<PilotArmV3, number | null> {
  return Object.fromEntries(
    pilotArms.map((arm) => [
      arm,
      triplets.length === 0
        ? null
        : triplets.filter((triplet) => resourceDatum(triplet.members[arm], key).complete).length / triplets.length,
    ]),
  ) as Record<PilotArmV3, number | null>;
}

function dimensionCompleteness(
  triplets: readonly PilotMetricTripletV3[],
  kind: 'strong_tokens_observed' | 'strong_tokens_estimated',
  dimension: 'input' | 'output' | 'cached_input' | 'reasoning' | 'total',
): Record<PilotArmV3, number | null> {
  return Object.fromEntries(
    pilotArms.map((arm) => [
      arm,
      triplets.length === 0
        ? null
        : triplets.filter((triplet) => {
            const measure = triplet.members[arm][kind][dimension];
            return measure.value !== null && measure.completeness_ratio === 1;
          }).length / triplets.length,
    ]),
  ) as Record<PilotArmV3, number | null>;
}

function computePilotMetricsInternal(
  manifest: PilotManifestV3,
  observations: readonly PilotBlockObservationV3[],
  selectedTripletIds?: ReadonlySet<string>,
): PilotMetricsV3 {
  const verified = verifyManifest(manifest);
  if (!verified.ok) throw new Error(`MANIFEST_INVALID:${verified.errors.join(';')}`);
  observations = structuredClone(observations);

  const assignments = new Map(manifest.arm_assignments.map((assignment) => [assignment.block_id, assignment.pilot_arm]));
  const candidateGroups = new Map<string, PilotManifestV3['blocks']>();
  for (const block of manifest.blocks) {
    if (!block.comparative_eligible) continue;
    if (selectedTripletIds && !selectedTripletIds.has(block.pair_or_triplet_id)) continue;
    const members = candidateGroups.get(block.pair_or_triplet_id) ?? [];
    members.push(block);
    candidateGroups.set(block.pair_or_triplet_id, members);
  }

  const admitted: PilotMetricTripletV3[] = [];
  const exclusions: PilotEvaluationReportV3['exclusions'] = [];
  const support = new Map<string, { candidate: number; admitted: number }>();
  for (const [tripletId, blocks] of [...candidateGroups.entries()].sort(([left], [right]) => compareCodeUnits(left, right))) {
    const matchingStratum = blocks[0].matching_stratum;
    const stratum = support.get(matchingStratum) ?? { candidate: 0, admitted: 0 };
    stratum.candidate += 1;
    support.set(matchingStratum, stratum);
    const byArm = Object.fromEntries(
      pilotArms.map((arm) => [arm, blocks.find((block) => assignments.get(block.block_id) === arm)!]),
    ) as Record<PilotArmV3, PilotManifestV3['blocks'][number]>;
    const matches = Object.fromEntries(
      pilotArms.map((arm) => [arm, observations.filter((observation) => observation.block_id === byArm[arm].block_id)]),
    ) as Record<PilotArmV3, PilotBlockObservationV3[]>;
    const reasons = [...new Set(pilotArms.flatMap((arm) => exclusionReasons(manifest, byArm[arm], arm, matches[arm])))].sort(
      compareCodeUnits,
    );
    if (reasons.length === 0) {
      admitted.push({
        pair_or_triplet_id: tripletId,
        matching_stratum: matchingStratum,
        members: Object.fromEntries(pilotArms.map((arm) => [arm, matches[arm][0]])) as Record<PilotArmV3, PilotBlockObservationV3>,
      });
      stratum.admitted += 1;
      continue;
    }
    const membersByArm = Object.fromEntries(
      pilotArms.map((arm) => [
        arm,
        {
          block_ids: matches[arm].map((value) => value.block_id).sort(compareCodeUnits),
          resources: resourceTotals(matches[arm]),
        },
      ]),
    ) as PilotEvaluationReportV3['exclusions'][number]['members_by_arm'];
    exclusions.push({
      pair_or_triplet_id: tripletId,
      reason_codes: reasons,
      members_by_arm: membersByArm,
      operational_resources: resourceTotals(pilotArms.flatMap((arm) => matches[arm])),
    });
  }

  const coreByArm = Object.fromEntries(pilotArms.map((arm) => [arm, admitted.map((triplet) => triplet.members[arm])])) as Record<
    PilotArmV3,
    PilotBlockObservationV3[]
  >;
  const populations = {
    observedCost: tripletPopulation(admitted, 'cost_observed'),
    estimatedCost: tripletPopulation(admitted, 'cost_estimated'),
    observedStrong: tripletPopulation(admitted, 'strong_tokens_observed'),
    estimatedStrong: tripletPopulation(admitted, 'strong_tokens_estimated'),
    observedAllRole: tripletPopulation(admitted, 'all_role_tokens_observed'),
    estimatedAllRole: tripletPopulation(admitted, 'all_role_tokens_estimated'),
  };
  const byArm = Object.fromEntries(
    pilotArms.map((arm) => {
      const values = coreByArm[arm];
      const accepted = values.filter((value) => value.final_accepted).length;
      const escapedMaterialDefects = checkedIntegerSum(
        values.map((value) => (value.final_accepted ? value.post_accept_defects.filter((defect) => defect.material).length : 0)),
      );
      const highDefects = checkedIntegerSum(
        values.map((value) => (value.final_accepted ? value.post_accept_defects.filter((defect) => defect.severity === 'high').length : 0)),
      );
      const criticalDefects = checkedIntegerSum(
        values.map((value) =>
          value.final_accepted ? value.post_accept_defects.filter((defect) => defect.severity === 'critical').length : 0,
        ),
      );
      const wall = resourceTotals(values).wall_time_seconds;
      const reworkBlocks = values.filter(
        (value) =>
          value.parent_rework_lines_production > 0 ||
          value.parent_rework_lines_tests > 0 ||
          value.parent_rework_lines_docs > 0 ||
          value.parent_rework_files.production > 0 ||
          value.parent_rework_files.tests > 0 ||
          value.parent_rework_files.docs > 0,
      ).length;
      const reworkLines = checkedIntegerSum(values.map((value) => value.parent_rework_lines_production));
      const changedLines = checkedIntegerSum(values.map((value) => value.changed_lines_production));
      return [
        arm,
        {
          final_acceptance_rate: metric(accepted, values.length),
          escaped_material_defect_rate: metric(escapedMaterialDefects, accepted),
          escaped_high_defects: metric(highDefects, values.length),
          escaped_critical_defects: metric(criticalDefects, values.length),
          wall_time_per_accepted_block: metric(wall.known_sum, accepted, wall.complete === wall.total),
          observed_cost_per_accepted_block: populationMetric(populations.observedCost, arm, 'cost_observed'),
          estimated_cost_per_accepted_block: populationMetric(populations.estimatedCost, arm, 'cost_estimated'),
          strong_tokens_observed_per_accepted_block: populationMetric(populations.observedStrong, arm, 'strong_tokens_observed'),
          strong_tokens_estimated_per_accepted_block: populationMetric(populations.estimatedStrong, arm, 'strong_tokens_estimated'),
          all_role_tokens_observed_per_accepted_block: populationMetric(populations.observedAllRole, arm, 'all_role_tokens_observed'),
          all_role_tokens_estimated_per_accepted_block: populationMetric(populations.estimatedAllRole, arm, 'all_role_tokens_estimated'),
          first_pass_accept_rate: metric(values.filter((value) => value.first_pass_accept).length, values.length),
          accept_after_one_repair_rate: metric(values.filter((value) => value.accept_after_one_repair).length, values.length),
          escalation_rate: metric(values.filter((value) => value.escalated).length, values.length),
          parent_rework_block_rate: metric(reworkBlocks, values.length),
          parent_rework_production_line_share: metric(reworkLines, changedLines),
        },
      ];
    }),
  ) as ReportMetrics['by_arm'];

  const paired = {
    final_acceptance: pairedQuality(admitted, (value) => value.final_accepted),
    final_quality: pairedQuality(admitted, qualitySuccess),
    parent_rework_block_rate: pairedMetric(
      byArm.A_STRONG_BASELINE.parent_rework_block_rate.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.parent_rework_block_rate.value,
    ),
    parent_rework_production_line_share: pairedMetric(
      byArm.A_STRONG_BASELINE.parent_rework_production_line_share.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.parent_rework_production_line_share.value,
    ),
    wall_time_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.wall_time_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.wall_time_per_accepted_block.value,
    ),
    observed_cost_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.observed_cost_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.observed_cost_per_accepted_block.value,
    ),
    estimated_cost_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.estimated_cost_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.estimated_cost_per_accepted_block.value,
    ),
    strong_tokens_observed_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.strong_tokens_observed_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.strong_tokens_observed_per_accepted_block.value,
    ),
    strong_tokens_estimated_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.strong_tokens_estimated_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.strong_tokens_estimated_per_accepted_block.value,
    ),
    all_role_tokens_observed_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.all_role_tokens_observed_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.all_role_tokens_observed_per_accepted_block.value,
    ),
    all_role_tokens_estimated_per_accepted_block: pairedMetric(
      byArm.A_STRONG_BASELINE.all_role_tokens_estimated_per_accepted_block.value,
      byArm.C_ADAPTIVE_EARLY_ESCALATION.all_role_tokens_estimated_per_accepted_block.value,
    ),
  };

  const allComparative = Object.fromEntries(
    pilotArms.map((arm) => [arm, observations.filter((value) => value.pilot_arm === arm)]),
  ) as Record<PilotArmV3, PilotBlockObservationV3[]>;
  const direct = observations.filter((value) => value.pilot_arm === null);
  const manifestBlocks = new Map(manifest.blocks.map((block) => [block.block_id, block]));
  const integrityReasons = sortedUnique(
    observations.flatMap((observation) => {
      const block = manifestBlocks.get(observation.block_id);
      if (!block) return ['unknown_manifest_block'];
      const expectedArm = assignments.get(block.block_id) ?? null;
      const reasons: string[] = [];
      if (!baseIdentityMatches(manifest, block, observation) || observation.pilot_arm !== expectedArm)
        reasons.push('manifest_identity_mismatch');
      if (!observation.valid_history || observation.final_outcome === 'INVALID')
        reasons.push('invalid_event_history', ...observation.invalid_reason_codes);
      if (hasZeroOperationEconomicValue(observation)) reasons.push('zero_operation_economic_value');
      return reasons;
    }),
  );
  const evidence = qualityEvidence(observations);
  const armCount = (predicate: (value: PilotBlockObservationV3) => boolean) =>
    Object.fromEntries(pilotArms.map((arm) => [arm, coreByArm[arm].filter(predicate).length])) as Record<PilotArmV3, number>;
  const result: PilotMetricsV3 = {
    metrics: { by_arm: byArm, paired_comparisons: paired },
    exclusions,
    operational_totals: {
      comparative_by_arm: Object.fromEntries(
        pilotArms.map((arm) => [arm, resourceTotals(allComparative[arm])]),
      ) as PilotEvaluationReportV3['operational_totals']['comparative_by_arm'],
      direct_to_strong: resourceTotals(direct),
    },
    denominators: {
      manifest_blocks: manifest.blocks.length,
      comparative_blocks: manifest.blocks.filter((block) => block.comparative_eligible).length,
      candidate_triplets: candidateGroups.size,
      admitted_triplets: admitted.length,
      excluded_triplets: exclusions.length,
      comparable_blocks_by_arm: Object.fromEntries(pilotArms.map((arm) => [arm, coreByArm[arm].length])) as Record<PilotArmV3, number>,
      accepted_blocks_by_arm: armCount((value) => value.final_accepted),
      quality_complete_blocks_by_arm: armCount((value) => value.final_outcome !== 'ACCEPTED' || value.post_acceptance_window_closed),
    },
    completeness: {
      observed_cost_by_arm: completenessByArm(admitted, 'cost_observed'),
      estimated_cost_by_arm: completenessByArm(admitted, 'cost_estimated'),
      strong_tokens_observed: {
        input_by_arm: dimensionCompleteness(admitted, 'strong_tokens_observed', 'input'),
        output_by_arm: dimensionCompleteness(admitted, 'strong_tokens_observed', 'output'),
        cached_input_by_arm: dimensionCompleteness(admitted, 'strong_tokens_observed', 'cached_input'),
        reasoning_by_arm: dimensionCompleteness(admitted, 'strong_tokens_observed', 'reasoning'),
        total_by_arm: dimensionCompleteness(admitted, 'strong_tokens_observed', 'total'),
      },
      strong_tokens_estimated: {
        input_by_arm: dimensionCompleteness(admitted, 'strong_tokens_estimated', 'input'),
        output_by_arm: dimensionCompleteness(admitted, 'strong_tokens_estimated', 'output'),
        cached_input_by_arm: dimensionCompleteness(admitted, 'strong_tokens_estimated', 'cached_input'),
        reasoning_by_arm: dimensionCompleteness(admitted, 'strong_tokens_estimated', 'reasoning'),
        total_by_arm: dimensionCompleteness(admitted, 'strong_tokens_estimated', 'total'),
      },
      wall_time_by_arm: completenessByArm(admitted, 'wall_time_seconds'),
    },
    observation_set_hash: observationSetHash(observations),
    quality_evidence_hash: evidence.hash,
    quality_evidence_count: evidence.count,
    late_quality_evidence_count: checkedIntegerSum(observations.map((value) => value.late_quality_evidence_count)),
    integrity_reasons: integrityReasons,
    strata_support: [...support.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([matching_stratum, counts]) => ({
        matching_stratum,
        candidate_triplets: counts.candidate,
        admitted_triplets: counts.admitted,
      })),
    populations: {
      core_triplets: admitted,
      core_triplet_ids: admitted.map((value) => value.pair_or_triplet_id),
      observed_cost_triplet_ids: populations.observedCost.map((value) => value.pair_or_triplet_id),
      estimated_cost_triplet_ids: populations.estimatedCost.map((value) => value.pair_or_triplet_id),
      observed_strong_token_triplet_ids: populations.observedStrong.map((value) => value.pair_or_triplet_id),
      estimated_strong_token_triplet_ids: populations.estimatedStrong.map((value) => value.pair_or_triplet_id),
      observed_all_role_token_triplet_ids: populations.observedAllRole.map((value) => value.pair_or_triplet_id),
      estimated_all_role_token_triplet_ids: populations.estimatedAllRole.map((value) => value.pair_or_triplet_id),
    },
  };
  return deepFreeze(result);
}

export function computePilotMetrics(manifest: PilotManifestV3, observations: readonly PilotBlockObservationV3[]): PilotMetricsV3 {
  return computePilotMetricsInternal(manifest, observations);
}

/** Task 7 evaluator-only entry point; public diagnostics remain full-manifest. */
export function computePilotMetricsForTripletIds(
  manifest: PilotManifestV3,
  observations: readonly PilotBlockObservationV3[],
  selectedTripletIds: ReadonlySet<string>,
): PilotMetricsV3 {
  return computePilotMetricsInternal(manifest, observations, selectedTripletIds);
}
