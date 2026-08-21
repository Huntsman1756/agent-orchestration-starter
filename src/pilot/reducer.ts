import type { PilotBlockObservationV3, PilotEventV3, PilotManifestV3 } from './contracts.js';
import { activeEvents } from './event-store.js';
import { loadPilotBlockObservationV3 } from './load.js';
import { verifyManifest } from './manifest.js';
import { parseContractualUtc, replayBlock } from './state-machine.js';
import { aggregateUsage, type AggregateMeasureV3, type PricedUsageV3 } from './usage-cost.js';

const dimensions = ['input', 'output', 'cached_input', 'reasoning'] as const;
const severityRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

function safeSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) throw new RangeError(`SAFE_INTEGER_OVERFLOW:${label}`);
    total += value;
  }
  return total;
}

function containedSafeSum<T extends number | null>(
  values: readonly number[],
  label: string,
  arithmeticErrors: Set<string>,
  fallback: T,
): number | T {
  try {
    return safeSum(values, label);
  } catch (error) {
    if (!(error instanceof RangeError) || error.message !== `SAFE_INTEGER_OVERFLOW:${label}`) throw error;
    arithmeticErrors.add(label);
    return fallback;
  }
}

function reasonCode(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : 'AUDIT_LOG_INVALID';
}

function orderedAudit(events: readonly PilotEventV3[], targetBlockId: string): readonly PilotEventV3[] {
  return [...events].sort((left, right) => {
    const leftTarget = left.block_id === targetBlockId;
    const rightTarget = right.block_id === targetBlockId;
    if (leftTarget !== rightTarget) return leftTarget ? -1 : 1;
    if (left.block_id !== right.block_id) return compareCodeUnits(left.block_id, right.block_id);
    if (left.sequence_number !== right.sequence_number) return left.sequence_number - right.sequence_number;
    return compareCodeUnits(left.event_id, right.event_id);
  });
}

function assertRawIdentity(manifest: PilotManifestV3, events: readonly PilotEventV3[]): void {
  for (const event of events) {
    const block = manifest.blocks.find(candidate => candidate.block_id === event.block_id);
    if (!block || event.pilot_id !== manifest.pilot_id || event.manifest_hash !== manifest.manifest_hash
      || event.task_id !== block.task_id || event.matching_stratum !== block.matching_stratum
      || event.pair_or_triplet_id !== block.pair_or_triplet_id || event.case_fingerprint !== block.case_fingerprint) throw new Error('RAW_EVENT_IDENTITY_INVALID');
    const assignment = manifest.arm_assignments.find(candidate => candidate.block_id === block.block_id);
    if ((assignment && event.pilot_arm !== assignment.pilot_arm) || (!assignment && (block.comparative_eligible || event.pilot_arm !== null))) throw new Error('RAW_EVENT_IDENTITY_INVALID');
  }
}

function usageSummary(events: readonly PricedUsageV3[], arithmeticErrors: Set<string>, label: string): { operations: number; observed_tokens: number | null; estimated_tokens: number | null } {
  if (events.length === 0) return { operations: 0, observed_tokens: null, estimated_tokens: null };
  const total = (kind: 'observed' | 'estimated'): number | null => {
    const values: number[] = [];
    for (const event of events) {
      if (kind === 'estimated' && (event.token_estimator_id === null || event.token_estimator_version === null)) return null;
      const record = dimensions.map(dimension => event[`${dimension}_tokens_${kind}`] as number | null);
      if (record.some(value => value === null)) return null;
      values.push(...record as number[]);
    }
    return containedSafeSum(values, `${label}_${kind}_tokens`, arithmeticErrors, null);
  };
  return { operations: events.length, observed_tokens: total('observed'), estimated_tokens: total('estimated') };
}

function observationFor(
  manifest: PilotManifestV3,
  events: readonly PilotEventV3[],
  block: PilotManifestV3['blocks'][number],
): PilotBlockObservationV3 {
  const assignment = manifest.arm_assignments.find(candidate => candidate.block_id === block.block_id);
  const arithmeticErrors = new Set<string>();
  const emptyUsage = { operations: 0, observed_tokens: null, estimated_tokens: null };
  const base = {
    schema_version: 3 as const, pilot_id: manifest.pilot_id, manifest_hash: manifest.manifest_hash, task_id: block.task_id,
    block_id: block.block_id, matching_stratum: block.matching_stratum, pair_or_triplet_id: block.pair_or_triplet_id,
    case_fingerprint: block.case_fingerprint, pilot_arm: assignment?.pilot_arm ?? null, complexity_class: block.complexity_class,
    risk_class: block.risk_class, changed_line_band: block.changed_line_band, cheap_eligible: block.cheap_eligible,
    comparative_eligible: block.comparative_eligible,
  };
  let active: readonly PilotEventV3[] = [];
  let replay = replayBlock(manifest, []);
  let reducerError: string | null = null;
  try {
    const ordered = orderedAudit(events, block.block_id);
    active = activeEvents(ordered).filter(event => event.block_id === block.block_id);
    replay = replayBlock(manifest, ordered.some(event => event.block_id === block.block_id) ? ordered : []);
  } catch (error) {
    reducerError = error instanceof Error ? error.message : String(error);
  }
  let invalid = reducerError !== null || !replay.valid_history;
  const executions = active.filter((event): event is Extract<PilotEventV3, { event_type: 'EXECUTION_COMPLETED' }> => event.event_type === 'EXECUTION_COMPLETED');
  const starts = active.filter((event): event is Extract<PilotEventV3, { event_type: 'EXECUTION_STARTED' }> => event.event_type === 'EXECUTION_STARTED');
  const reviews = active.filter((event): event is Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }> => event.event_type === 'REVIEW_COMPLETED');
  const validations = active.filter((event): event is Extract<PilotEventV3, { event_type: 'VALIDATION_RECORDED' }> => event.event_type === 'VALIDATION_RECORDED');
  const rework = active.filter((event): event is Extract<PilotEventV3, { event_type: 'PARENT_REWORK_RECORDED' }> => event.event_type === 'PARENT_REWORK_RECORDED');
  const escalations = active.filter((event): event is Extract<PilotEventV3, { event_type: 'ESCALATION_DECIDED' }> => event.event_type === 'ESCALATION_DECIDED');
  const usages = active.filter((event): event is Extract<PilotEventV3, { event_type: 'USAGE_RECORDED' }> => event.event_type === 'USAGE_RECORDED');
  const accepted = active.find((event): event is Extract<PilotEventV3, { event_type: 'BLOCK_ACCEPTED' }> => event.event_type === 'BLOCK_ACCEPTED');
  let aggregate;
  try { aggregate = aggregateUsage(usages.map(event => event.payload), manifest.binding_registry, manifest.pricing_snapshot); }
  catch { reducerError = 'USAGE_AGGREGATION_INVALID'; }
  if (validations.some(event => (event.payload.passed && event.payload.tests_failing !== 0) || (!event.payload.passed && event.payload.tests_failing === 0))) reducerError = 'VALIDATION_TEST_COUNT_INVALID';
  invalid = reducerError !== null || !replay.valid_history;
  const priced = aggregate?.priced_usage ?? [];
  const byRole = (role: 'orchestrator' | 'executor' | 'reviewer') => usageSummary(priced.filter(event => event.role === role), arithmeticErrors, role);
  const initialReview = reviews.find(event => event.payload.review_round === 1);
  const acceptedReview = reviews.find(event => event.payload.decision === 'ACCEPT');
  const firstPass = initialReview?.payload.decision === 'ACCEPT';
  const acceptAfterOneRepair = firstPass || reviews.some(event => event.payload.review_round === 2 && event.payload.decision === 'ACCEPT');
  let quality = { closed: false, accepted_at: null as string | null, opens_at: null as string | null, closes_at: null as string | null, defects: [] as Array<{ defect_id: string; severity: 'low' | 'medium' | 'high' | 'critical'; material: boolean; discovered_at: string; evidence_id: string; affected_revision: string; category_code: string }>, late: 0, warnings: [] as string[] };
  if (accepted && !invalid) try {
    const acceptedAt = parseContractualUtc(accepted.payload.accepted_at);
    const closesAt = acceptedAt + manifest.post_acceptance_window.duration_seconds * 1000;
    const defectEvents = active.filter((event): event is Extract<PilotEventV3, { event_type: 'POST_ACCEPT_DEFECT_RECORDED' }> => event.event_type === 'POST_ACCEPT_DEFECT_RECORDED');
    if (defectEvents.some(event => parseContractualUtc(event.payload.discovered_at) < acceptedAt)) throw new Error('QUALITY_TIMESTAMP_INVALID');
    const inWindow = defectEvents.filter(event => { const discoveredAt = parseContractualUtc(event.payload.discovered_at); return discoveredAt >= acceptedAt && discoveredAt <= closesAt; });
    const late = defectEvents.filter(event => { const discoveredAt = parseContractualUtc(event.payload.discovered_at); return discoveredAt < acceptedAt || discoveredAt > closesAt; });
    const watermark = active.reduce<number | null>((latest, event) => { const value = parseContractualUtc(event.recorded_at); return latest === null || value > latest ? value : latest; }, null);
    const elapsed = watermark !== null && watermark >= closesAt + manifest.post_acceptance_window.allowed_clock_skew_seconds * 1000;
    const terminalMaterial = inWindow.some(event => event.payload.material);
    quality = { closed: elapsed || (manifest.post_acceptance_window.closure_rule === 'terminal_material_defect' && terminalMaterial), accepted_at: accepted.payload.accepted_at, opens_at: new Date(acceptedAt).toISOString(), closes_at: new Date(closesAt).toISOString(), defects: inWindow.map(event => ({ defect_id: event.payload.defect_id, severity: event.payload.severity, material: event.payload.material, discovered_at: event.payload.discovered_at, evidence_id: event.payload.evidence_id, affected_revision: event.payload.affected_revision, category_code: event.payload.category_code })), late: late.length, warnings: late.length > 0 ? ['LATE_QUALITY_EVIDENCE'] : [] };
  } catch { reducerError = 'QUALITY_TIMESTAMP_INVALID'; invalid = true; }
  const reviewFindingsMaterial = containedSafeSum(reviews.map(event => event.payload.material_findings.length), 'material_findings', arithmeticErrors, 0);
  const reviewFindingsNonMaterial = containedSafeSum(reviews.map(event => event.payload.non_material_findings.length), 'non_material_findings', arithmeticErrors, 0);
  const reworkLinesProduction = containedSafeSum(rework.map(event => event.payload.lines_production), 'rework_lines_production', arithmeticErrors, 0);
  const reworkLinesTests = containedSafeSum(rework.map(event => event.payload.lines_tests), 'rework_lines_tests', arithmeticErrors, 0);
  const reworkLinesDocs = containedSafeSum(rework.map(event => event.payload.lines_docs), 'rework_lines_docs', arithmeticErrors, 0);
  const changedLinesProduction = containedSafeSum(executions.map(event => event.payload.changed_lines_production), 'changed_lines_production', arithmeticErrors, 0);
  const changedLinesTests = containedSafeSum(executions.map(event => event.payload.changed_lines_tests), 'changed_lines_tests', arithmeticErrors, 0);
  const changedLinesDocs = containedSafeSum(executions.map(event => event.payload.changed_lines_docs), 'changed_lines_docs', arithmeticErrors, 0);
  const orchestratorUsage = byRole('orchestrator');
  const executorUsage = byRole('executor');
  const reviewerUsage = byRole('reviewer');
  const totalUsage = usageSummary(priced, arithmeticErrors, 'total');
  const executorDurationMs = executions.length ? containedSafeSum(executions.map(event => event.payload.duration_ms), 'executor_duration', arithmeticErrors, null) : null;
  const reviewDurationMs = reviews.length ? containedSafeSum(reviews.map(event => event.payload.duration_ms), 'review_duration', arithmeticErrors, null) : null;
  const terminalEvent = active.find(event => event.event_type === 'BLOCK_ACCEPTED' || event.event_type === 'BLOCK_FAILED' || event.event_type === 'BLOCK_BLOCKED');
  const wallTimeSeconds = starts.length > 0 && terminalEvent !== undefined
    ? (parseContractualUtc(terminalEvent.occurred_at) - parseContractualUtc(starts[0].occurred_at)) / 1_000
    : null;
  if (arithmeticErrors.size > 0) { reducerError = 'SAFE_ARITHMETIC_INVALID'; invalid = true; }
  const terminal = invalid ? 'INVALID' : replay.state === 'ACCEPTED' ? 'ACCEPTED' : replay.state === 'FAILED' ? 'FAILED' : replay.state === 'BLOCKED' ? 'BLOCKED' : 'INVALID';
  const finalInvalidReasonCodes = [...new Set([...(replay.invalid_reason_codes ?? []).map(reasonCode), ...(reducerError ? [reasonCode(reducerError)] : [])])].sort(compareCodeUnits);
  const blocked = active.find((event): event is Extract<PilotEventV3, { event_type: 'BLOCK_BLOCKED' }> => event.event_type === 'BLOCK_BLOCKED');
  const cost = aggregate?.cost_observed ?? { value: null, completeness_ratio: 0 } as AggregateMeasureV3;
  const estimatedCost = aggregate?.cost_estimated ?? { value: null, completeness_ratio: 0 } as AggregateMeasureV3;
  const observation = {
    ...base, state: invalid ? 'INVALID' : replay.state, valid_history: !invalid, invalid_reason_codes: finalInvalidReasonCodes,
    executor_binding_initial: starts[0]?.payload.executor_binding_ref ?? null, executor_binding_final: starts.at(-1)?.payload.executor_binding_ref ?? null,
    reviewer_binding_refs: [...new Set(reviews.map(event => event.payload.reviewer_binding_ref))].sort(compareCodeUnits), execution_attempts: executions.length,
    repair_rounds: starts.filter(event => event.payload.attempt_kind === 'REPAIR_1').length, escalated: escalations.length > 0,
    escalation_reason: escalations.at(-1)?.payload.escalation_reason ?? null, first_pass_accept: terminal === 'ACCEPTED' ? firstPass : false,
    accept_after_one_repair: terminal === 'ACCEPTED' ? acceptAfterOneRepair : false, final_accepted: terminal === 'ACCEPTED',
    tests_initially_failing: validations[0]?.payload.tests_failing ?? 0, tests_finally_passing: validations.at(-1)?.payload.tests_passing ?? 0,
    review_findings_material: reviewFindingsMaterial, review_findings_non_material: reviewFindingsNonMaterial,
    parent_rework_files: { production: new Set(rework.flatMap(event => event.payload.files_production)).size, tests: new Set(rework.flatMap(event => event.payload.files_tests)).size, docs: new Set(rework.flatMap(event => event.payload.files_docs)).size },
    parent_rework_lines_production: reworkLinesProduction, parent_rework_lines_tests: reworkLinesTests, parent_rework_lines_docs: reworkLinesDocs,
    changed_lines_production: changedLinesProduction, changed_lines_tests: changedLinesTests, changed_lines_docs: changedLinesDocs,
    orchestrator_usage: orchestratorUsage, executor_usage: executorUsage, reviewer_usage: reviewerUsage, total_usage: totalUsage,
    cost_observed: cost.value, cost_estimated: estimatedCost.value, cost_observed_completeness: cost.completeness_ratio, cost_estimated_completeness: estimatedCost.completeness_ratio,
    strong_tokens_observed: aggregate?.strong_tokens_observed ?? { input: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, output: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, cached_input: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, reasoning: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, total: { value: null, complete: 0, total: 0, completeness_ratio: 0 } },
    strong_tokens_estimated: aggregate?.strong_tokens_estimated ?? { input: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, output: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, cached_input: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, reasoning: { value: null, complete: 0, total: 0, completeness_ratio: 0 }, total: { value: null, complete: 0, total: 0, completeness_ratio: 0 } },
    wall_time_seconds: wallTimeSeconds, executor_time_seconds: executorDurationMs === null ? null : executorDurationMs / 1000, review_time_seconds: reviewDurationMs === null ? null : reviewDurationMs / 1000,
    blocked_cause: terminal === 'BLOCKED' ? blocked?.payload.cause ?? null : null, blocked_reason_code: terminal === 'BLOCKED' ? blocked?.payload.reason_code ?? null : null,
    post_acceptance_window_closed: quality.closed, accepted_at: quality.accepted_at, window_opens_at: quality.opens_at, window_closes_at: quality.closes_at,
    post_accept_defects: quality.defects, post_accept_defects_count: quality.defects.length, post_accept_max_severity: quality.defects.length ? quality.defects.map(defect => defect.severity).sort((left, right) => severityRank[right] - severityRank[left])[0] : null,
    late_quality_evidence_count: quality.late, quality_warnings: quality.warnings, final_outcome: terminal,
  };
  void acceptedReview;
  return deepFreeze(loadPilotBlockObservationV3(observation));
}

export function reduceEvents(manifest: PilotManifestV3, events: readonly PilotEventV3[]): readonly PilotBlockObservationV3[] {
  const verification = verifyManifest(manifest);
  if (!verification.ok) throw new Error(`MANIFEST_OR_PRICING_INVALID:${verification.errors.join('; ')}`);
  assertRawIdentity(manifest, events);
  return deepFreeze(manifest.blocks
    .slice()
    .sort((left, right) => compareCodeUnits(left.block_id, right.block_id))
    .map(block => observationFor(manifest, events, block)));
}
