import { hashCanonical } from './canonical-json.js';
import type { PilotEventV3, PilotManifestV3 } from './contracts.js';
import { activeEvents } from './event-store.js';

export type PilotBlockStateV3 =
  | 'PLANNED' | 'ASSIGNED' | 'READY_1' | 'EXECUTING_1' | 'READY_REVIEW_1' | 'REVIEWING_1'
  | 'READY_2' | 'EXECUTING_2' | 'READY_REVIEW_2' | 'REVIEWING_2' | 'ESCALATION_REQUIRED'
  | 'READY_3' | 'EXECUTING_3' | 'READY_FINAL_REVIEW' | 'FINAL_REVIEWING'
  | 'READY_ACCEPT' | 'READY_FAIL' | 'ACCEPTED' | 'FAILED' | 'BLOCKED' | 'INVALID';

export interface PilotBlockReplay {
  state: PilotBlockStateV3;
  valid_history: boolean;
  invalid_reason_codes: readonly string[];
  block_id: string | null;
  accepted_revision: string | null;
  accepted_tree_hash: string | null;
  accepted_review_id: string | null;
  unresolved_finding_ids: readonly string[];
}

type Arm = NonNullable<PilotEventV3['pilot_arm']>;
type Route = Arm | 'DIRECT_STRONG';
type ExecutionStarted = Extract<PilotEventV3, { event_type: 'EXECUTION_STARTED' }>;
type ExecutionCompleted = Extract<PilotEventV3, { event_type: 'EXECUTION_COMPLETED' }>;
type ReviewStarted = Extract<PilotEventV3, { event_type: 'REVIEW_STARTED' }>;
type ReviewCompleted = Extract<PilotEventV3, { event_type: 'REVIEW_COMPLETED' }>;
type ValidationRecorded = Extract<PilotEventV3, { event_type: 'VALIDATION_RECORDED' }>;
type OrchestratorOperationRecorded = Extract<PilotEventV3, { event_type: 'ORCHESTRATOR_OPERATION_RECORDED' }>;

const terminalStates = new Set<PilotBlockStateV3>(['ACCEPTED', 'FAILED', 'BLOCKED', 'INVALID']);

function blockContext(manifest: PilotManifestV3, event: PilotEventV3) {
  if (event.pilot_id !== manifest.pilot_id || event.manifest_hash !== manifest.manifest_hash) throw new Error('MANIFEST_MISMATCH');
  const block = manifest.blocks.find(candidate => candidate.block_id === event.block_id);
  if (!block) throw new Error('UNKNOWN_BLOCK');
  const assignment = manifest.arm_assignments.find(candidate => candidate.block_id === block.block_id);
  if (!assignment) {
    if (block.comparative_eligible || event.pilot_arm !== null
      || block.selected_executor_capability_initial !== 'strong'
      || block.selected_executor_capability_final_expected !== 'strong') throw new Error('ARM_MISMATCH');
    if (event.task_id !== block.task_id || event.matching_stratum !== block.matching_stratum || event.pair_or_triplet_id !== block.pair_or_triplet_id || event.case_fingerprint !== block.case_fingerprint) throw new Error('BLOCK_IDENTITY_MISMATCH');
    return { block, arm: 'DIRECT_STRONG' as const };
  }
  if (event.pilot_arm !== assignment.pilot_arm) throw new Error('ARM_MISMATCH');
  if (event.task_id !== block.task_id || event.matching_stratum !== block.matching_stratum || event.pair_or_triplet_id !== block.pair_or_triplet_id || event.case_fingerprint !== block.case_fingerprint) throw new Error('BLOCK_IDENTITY_MISMATCH');
  return { block, arm: assignment.pilot_arm };
}

function routeFor(arm: Route, attemptNumber: number): 'cheap' | 'strong' {
  if (arm === 'A_STRONG_BASELINE' || arm === 'DIRECT_STRONG') return 'strong';
  if (arm === 'B_CHEAP_NO_EARLY_ESCALATION') return 'cheap';
  return attemptNumber === 3 ? 'strong' : 'cheap';
}

function assertExecutionRoute(event: ExecutionStarted | ExecutionCompleted, manifest: PilotManifestV3, arm: Route): void {
  const payload = event.payload;
  const expectedCapability = routeFor(arm, payload.attempt_number);
  if (payload.executor_capability !== expectedCapability) throw new Error('CAPABILITY_MISMATCH');
  const binding = manifest.binding_registry.find(candidate => candidate.binding_ref === payload.executor_binding_ref);
  if (!binding || binding.capability_class !== expectedCapability) throw new Error('BINDING_MISMATCH');
}

function expectedAttempt(state: PilotBlockStateV3): { number: number; kind: ExecutionStarted['payload']['attempt_kind']; next: PilotBlockStateV3 } | null {
  if (state === 'READY_1') return { number: 1, kind: 'IMPLEMENTATION', next: 'EXECUTING_1' };
  if (state === 'READY_2') return { number: 2, kind: 'REPAIR_1', next: 'EXECUTING_2' };
  if (state === 'READY_3') return { number: 3, kind: 'FINAL_EXECUTION', next: 'EXECUTING_3' };
  return null;
}

function validDuration(payload: { started_monotonic_ms: number; finished_monotonic_ms: number; duration_ms: number }): boolean {
  return payload.finished_monotonic_ms >= payload.started_monotonic_ms && payload.duration_ms === payload.finished_monotonic_ms - payload.started_monotonic_ms;
}

function canonicalBoundary(event: ReviewCompleted): string {
  const payload = event.payload;
  return hashCanonical({
    pilot_id: event.pilot_id, block_id: event.block_id, review_id: payload.review_id,
    reviewed_attempt_id: payload.reviewed_attempt_id,
    review_boundary_from_revision: payload.review_boundary_from_revision,
    review_boundary_to_revision: payload.review_boundary_to_revision,
    review_input_diff_hash: payload.review_input_diff_hash,
    unresolved_finding_ids: payload.unresolved_finding_ids,
    validation_evidence_hashes: payload.validation_evidence_hashes,
  });
}

const contractualUtcTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

export function parseContractualUtc(value: string): number {
  const match = contractualUtcTimestamp.exec(value);
  if (!match) throw new Error('INVALID_OCCURRED_AT');
  const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map(component => Number(component ?? 0));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999) throw new Error('INVALID_OCCURRED_AT');
  const roundTrip = new Date(0);
  roundTrip.setUTCFullYear(year, month - 1, day);
  roundTrip.setUTCHours(hour, minute, second, millisecond);
  const instant = roundTrip.getTime();
  if (!Number.isFinite(instant)
    || roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
    || roundTrip.getUTCMilliseconds() !== millisecond) throw new Error('INVALID_OCCURRED_AT');
  return instant;
}

type RowState = PilotBlockStateV3 | null | 'ANY_NON_TERMINAL';
type RowTarget = PilotBlockStateV3 | 'SAME';
interface TransitionRowV3 {
  from: RowState;
  event_type: PilotEventV3['event_type'];
  to: RowTarget;
  decision?: ReviewCompleted['payload']['decision'];
  arms?: readonly Route[];
}

const transitionRows: readonly TransitionRowV3[] = [
  { from: null, event_type: 'BLOCK_PLANNED', to: 'PLANNED' },
  { from: 'PLANNED', event_type: 'ARM_ASSIGNED', to: 'ASSIGNED' },
  { from: 'ASSIGNED', event_type: 'ISOLATION_ATTESTED', to: 'READY_1' },
  { from: 'PLANNED', event_type: 'ISOLATION_ATTESTED', arms: ['DIRECT_STRONG'], to: 'READY_1' },
  { from: 'READY_1', event_type: 'EXECUTION_STARTED', to: 'EXECUTING_1' },
  { from: 'EXECUTING_1', event_type: 'EXECUTION_COMPLETED', to: 'READY_REVIEW_1' },
  { from: 'READY_REVIEW_1', event_type: 'REVIEW_STARTED', to: 'REVIEWING_1' },
  { from: 'REVIEWING_1', event_type: 'REVIEW_COMPLETED', decision: 'ACCEPT', to: 'READY_ACCEPT' },
  { from: 'REVIEWING_1', event_type: 'REVIEW_COMPLETED', decision: 'REJECT', to: 'READY_2' },
  { from: 'READY_2', event_type: 'EXECUTION_STARTED', to: 'EXECUTING_2' },
  { from: 'EXECUTING_2', event_type: 'EXECUTION_COMPLETED', to: 'READY_REVIEW_2' },
  { from: 'READY_REVIEW_2', event_type: 'REVIEW_STARTED', to: 'REVIEWING_2' },
  { from: 'REVIEWING_2', event_type: 'REVIEW_COMPLETED', decision: 'ACCEPT', to: 'READY_ACCEPT' },
  { from: 'REVIEWING_2', event_type: 'REVIEW_COMPLETED', decision: 'REJECT', arms: ['C_ADAPTIVE_EARLY_ESCALATION'], to: 'ESCALATION_REQUIRED' },
  { from: 'REVIEWING_2', event_type: 'REVIEW_COMPLETED', decision: 'REJECT', arms: ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'DIRECT_STRONG'], to: 'READY_3' },
  { from: 'ESCALATION_REQUIRED', event_type: 'ESCALATION_DECIDED', arms: ['C_ADAPTIVE_EARLY_ESCALATION'], to: 'READY_3' },
  { from: 'READY_3', event_type: 'EXECUTION_STARTED', to: 'EXECUTING_3' },
  { from: 'EXECUTING_3', event_type: 'EXECUTION_COMPLETED', to: 'READY_FINAL_REVIEW' },
  { from: 'READY_FINAL_REVIEW', event_type: 'REVIEW_STARTED', to: 'FINAL_REVIEWING' },
  { from: 'FINAL_REVIEWING', event_type: 'REVIEW_COMPLETED', decision: 'ACCEPT', to: 'READY_ACCEPT' },
  { from: 'FINAL_REVIEWING', event_type: 'REVIEW_COMPLETED', decision: 'REJECT', to: 'READY_FAIL' },
  { from: 'READY_ACCEPT', event_type: 'BLOCK_ACCEPTED', to: 'ACCEPTED' },
  { from: 'READY_FAIL', event_type: 'BLOCK_FAILED', to: 'FAILED' },
  { from: 'ANY_NON_TERMINAL', event_type: 'BLOCK_BLOCKED', to: 'BLOCKED' },
  { from: 'ACCEPTED', event_type: 'POST_ACCEPT_DEFECT_RECORDED', to: 'ACCEPTED' },
  { from: 'ANY_NON_TERMINAL', event_type: 'ORCHESTRATOR_OPERATION_RECORDED', to: 'SAME' },
  { from: 'ANY_NON_TERMINAL', event_type: 'USAGE_RECORDED', to: 'SAME' },
  { from: 'ANY_NON_TERMINAL', event_type: 'VALIDATION_RECORDED', to: 'SAME' },
  { from: 'ANY_NON_TERMINAL', event_type: 'PARENT_REWORK_RECORDED', to: 'SAME' },
];

function rowMatches(row: TransitionRowV3, state: PilotBlockStateV3 | null, event: PilotEventV3, arm: Route): boolean {
  const fromMatches = row.from === 'ANY_NON_TERMINAL'
    ? state !== null && !terminalStates.has(state)
    : row.from === state;
  if (!fromMatches || row.event_type !== event.event_type || (row.arms && !row.arms.includes(arm))) return false;
  return row.decision === undefined || (event.event_type === 'REVIEW_COMPLETED' && event.payload.decision === row.decision);
}

function assertTransitionGuard(state: PilotBlockStateV3 | null, event: PilotEventV3, manifest: PilotManifestV3, block: PilotManifestV3['blocks'][number], arm: Route): void {
  if (event.event_type === 'BLOCK_PLANNED' && event.payload.planned_block_hash !== block.contract_hash) throw new Error('PLANNED_BLOCK_HASH_MISMATCH');
  if (event.event_type === 'ARM_ASSIGNED' && (event.payload.assigned_arm !== arm || event.payload.assignment_algorithm_version !== manifest.assignment_algorithm_version)) throw new Error('ASSIGNMENT_MISMATCH');
  if (event.event_type === 'ISOLATION_ATTESTED' && (event.payload.base_revision !== block.base_revision || event.payload.clean_tree_hash !== block.clean_tree_hash || event.payload.isolation_policy_version !== manifest.isolation_policy_version || event.payload.isolation_status !== 'CLEAN' || event.payload.observed_tree_hash !== event.payload.clean_tree_hash)) throw new Error('ISOLATION_INVALID');
  if (event.event_type === 'EXECUTION_STARTED') {
    const expected = state === null ? null : expectedAttempt(state);
    if (!expected || event.payload.attempt_number !== expected.number || event.payload.attempt_kind !== expected.kind) throw new Error('ATTEMPT_CEILING_OR_ORDER');
    assertExecutionRoute(event, manifest, arm);
  }
  if (event.event_type === 'EXECUTION_COMPLETED') {
    const expectedNumber = state === 'EXECUTING_1' ? 1 : state === 'EXECUTING_2' ? 2 : state === 'EXECUTING_3' ? 3 : 0;
    if (event.payload.attempt_number !== expectedNumber) throw new Error('COMPLETION_ORDER_INVALID');
    assertExecutionRoute(event, manifest, arm);
    if (!validDuration(event.payload)) throw new Error('EXECUTION_DURATION_INVALID');
    if (event.payload.canonical_tree_algorithm_version !== manifest.canonical_tree_algorithm_version || event.payload.volatile_paths_policy_hash !== manifest.volatile_paths_policy_hash || !event.payload.tree_reproduced) throw new Error('TREE_REPRODUCTION_INVALID');
  }
  if (event.event_type === 'REVIEW_STARTED') {
    const expectedRound = state === 'READY_REVIEW_1' ? 1 : state === 'READY_REVIEW_2' ? 2 : state === 'READY_FINAL_REVIEW' ? 3 : 0;
    if (event.payload.review_round !== expectedRound) throw new Error('REVIEW_ORDER_INVALID');
    if (event.payload.reviewer_binding_ref !== manifest.routing_reviewer_binding_ref || event.payload.reviewer_session_id === event.payload.executor_session_id_reviewed) throw new Error('REVIEWER_INDEPENDENCE_INVALID');
  }
  if (event.event_type === 'REVIEW_COMPLETED') {
    if (!validDuration(event.payload) || event.payload.review_boundary_hash !== canonicalBoundary(event)) throw new Error('REVIEW_PROOF_INVALID');
    if (event.payload.decision === 'ACCEPT' && event.payload.unresolved_finding_ids.length > 0) throw new Error('UNRESOLVED_ACCEPTANCE');
    if (event.payload.decision === 'REJECT' && event.payload.unresolved_finding_ids.length === 0 && event.payload.material_findings.length === 0 && event.payload.non_material_findings.length === 0) throw new Error('EMPTY_REJECTION');
  }
  if (event.event_type === 'ESCALATION_DECIDED') {
    const binding = manifest.binding_registry.find(candidate => candidate.binding_ref === event.payload.target_binding_ref);
    if (!binding || binding.capability_class !== 'strong' || event.payload.target_capability !== 'strong' || event.payload.decision_policy_version !== manifest.routing_policy_version) throw new Error('ESCALATION_INVALID');
  }
}

function transitionChecked(state: PilotBlockStateV3 | null, event: PilotEventV3, manifest: PilotManifestV3): PilotBlockStateV3 {
  if (event.event_type === 'EVENT_INVALIDATED') throw new Error('INVALIDATION_NOT_PROJECTED');
  const { block, arm } = blockContext(manifest, event);
  const row = transitionRows.find(candidate => rowMatches(candidate, state, event, arm));
  if (!row) throw new Error(state !== null && terminalStates.has(state) ? 'CONFLICTING_TERMINAL' : 'ILLEGAL_EVENT_STATE_PAIR');
  assertTransitionGuard(state, event, manifest, block, arm);
  if (row.to === 'SAME') {
    if (state === null) throw new Error('ORPHAN_EVIDENCE');
    return state;
  }
  return row.to;
}

export function transition(state: PilotBlockStateV3 | null, event: PilotEventV3, manifest: PilotManifestV3): PilotBlockStateV3 {
  try {
    return transitionChecked(state, event, manifest);
  } catch {
    return 'INVALID';
  }
}

function invalid(blockId: string | null, reason: unknown, unresolved: readonly string[] = []): PilotBlockReplay {
  const code = reason instanceof Error ? reason.message : String(reason);
  return { state: 'INVALID', valid_history: false, invalid_reason_codes: [code || 'INVALID_HISTORY'], block_id: blockId, accepted_revision: null, accepted_tree_hash: null, accepted_review_id: null, unresolved_finding_ids: [...unresolved] };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function replayBlock(manifest: PilotManifestV3, events: readonly PilotEventV3[]): PilotBlockReplay {
  let projected: readonly PilotEventV3[];
  try {
    projected = activeEvents(events);
  } catch (error) {
    return invalid(events[0]?.block_id ?? null, error);
  }
  const targetBlockId = events[0]?.block_id ?? projected[0]?.block_id ?? null;
  if (!targetBlockId) return invalid(null, 'EMPTY_HISTORY');
  const workspaceOwners = new Map<string, string>();
  for (const event of projected) {
    if (event.event_type !== 'ISOLATION_ATTESTED') continue;
    const prior = workspaceOwners.get(event.payload.workspace_instance_id);
    if (prior && prior !== event.block_id) return invalid(targetBlockId, 'WORKSPACE_REUSED_ACROSS_BLOCKS');
    workspaceOwners.set(event.payload.workspace_instance_id, event.block_id);
  }
  const history = projected.filter(event => event.block_id === targetBlockId).sort((left, right) => left.sequence_number - right.sequence_number);
  if (history.length === 0) return invalid(targetBlockId, 'EMPTY_ACTIVE_HISTORY');

  let state: PilotBlockStateV3 | null = null;
  let previousOccurredAt: number | null = null;
  let currentAttempt: ExecutionStarted | null = null;
  let currentCompletion: ExecutionCompleted | null = null;
  let currentReview: ReviewStarted | null = null;
  let previousReview: ReviewCompleted | null = null;
  let acceptedReview: ReviewCompleted | null = null;
  let acceptedCompletion: ExecutionCompleted | null = null;
  let rejectedReviewEventId: string | null = null;
  let escalationTargetBinding: string | null = null;
  const attempts = new Map<string, { started: ExecutionStarted; completed?: ExecutionCompleted; review_started: boolean }>();
  const reviews = new Map<string, { started: ReviewStarted; completed?: ReviewCompleted; window_open: boolean }>();
  const validations = new Map<string, ValidationRecorded[]>();
  const orchestratorOperations = new Map<string, OrchestratorOperationRecorded>();
  let openOrchestratorOperation: OrchestratorOperationRecorded | null = null;
  const executorSessions = new Set<string>();
  const reviewerSessions = new Set<string>();
  const unresolved = new Set<string>();

  try {
    for (let index = 0; index < history.length; index += 1) {
      const event = history[index];
      if (event.sequence_number !== index + 1) throw new Error('INCOMPATIBLE_SEQUENCE_GAP');
      const occurredAt = parseContractualUtc(event.occurred_at);
      if (previousOccurredAt !== null && occurredAt < previousOccurredAt) throw new Error('REGRESSIVE_OCCURRED_AT');
      previousOccurredAt = occurredAt;
      const { block, arm } = blockContext(manifest, event);

      if (event.event_type !== 'USAGE_RECORDED') openOrchestratorOperation = null;

      if (event.event_type === 'EXECUTION_STARTED' || event.event_type === 'ESCALATION_DECIDED' || event.event_type === 'BLOCK_ACCEPTED' || event.event_type === 'BLOCK_FAILED' || event.event_type === 'BLOCK_BLOCKED') {
        for (const review of reviews.values()) review.window_open = false;
      }

      if (event.event_type === 'ISOLATION_ATTESTED' && (event.payload.isolation_status === 'CONTAMINATED' || event.payload.observed_tree_hash !== event.payload.clean_tree_hash)) throw new Error('WORKSPACE_CONTAMINATED');
      if (event.event_type === 'EXECUTION_STARTED') {
        if (attempts.has(event.payload.attempt_id) || event.payload.attempt_number > 3) throw new Error('ATTEMPT_ID_OR_CEILING_INVALID');
        const expectedInput = event.payload.attempt_number === 1 ? block.base_revision : previousReview?.payload.review_boundary_to_revision;
        if (!expectedInput || event.payload.input_revision !== expectedInput) throw new Error('INPUT_REVISION_CHAIN_INVALID');
        if (executorSessions.has(event.payload.executor_session_id) || reviewerSessions.has(event.payload.executor_session_id)) throw new Error('EXECUTOR_SESSION_REUSED');
        if (arm === 'C_ADAPTIVE_EARLY_ESCALATION' && event.payload.attempt_number === 3 && event.payload.executor_binding_ref !== escalationTargetBinding) throw new Error('ESCALATION_TARGET_BINDING_MISMATCH');
        executorSessions.add(event.payload.executor_session_id);
        currentAttempt = event;
        currentCompletion = null;
        attempts.set(event.payload.attempt_id, { started: event, review_started: false });
      } else if (event.event_type === 'EXECUTION_COMPLETED') {
        if (!currentAttempt || currentAttempt.payload.attempt_id !== event.payload.attempt_id) throw new Error('COMPLETION_ATTEMPT_MISMATCH');
        for (const field of ['attempt_number', 'attempt_kind', 'executor_capability', 'executor_binding_ref', 'executor_session_id', 'input_revision', 'started_monotonic_ms'] as const) if (currentAttempt.payload[field] !== event.payload[field]) throw new Error('COMPLETION_OWNERSHIP_MISMATCH');
        if (event.payload.canonical_tree_algorithm_version !== manifest.canonical_tree_algorithm_version || event.payload.volatile_paths_policy_hash !== manifest.volatile_paths_policy_hash || !event.payload.tree_reproduced) throw new Error('TREE_REPRODUCTION_INVALID');
        attempts.get(event.payload.attempt_id)!.completed = event;
        currentCompletion = event;
      } else if (event.event_type === 'VALIDATION_RECORDED') {
        const attempt = attempts.get(event.payload.attempt_id);
        if (!attempt?.completed || attempt.review_started) throw new Error('ORPHAN_OR_MISORDERED_VALIDATION');
        if (event.payload.validation_surface.some(surface => !block.validation_surface.includes(surface))) throw new Error('VALIDATION_SURFACE_INVALID');
        if (event.payload.passed !== (event.payload.tests_failing === 0)) throw new Error('VALIDATION_TEST_COUNTS_INCONSISTENT');
        const owned = validations.get(event.payload.attempt_id) ?? [];
        owned.push(event);
        validations.set(event.payload.attempt_id, owned);
      } else if (event.event_type === 'REVIEW_STARTED') {
        const attempt = attempts.get(event.payload.reviewed_attempt_id);
        if (!attempt?.completed || attempt.completed !== currentCompletion || event.payload.executor_session_id_reviewed !== attempt.completed.payload.executor_session_id) throw new Error('REVIEW_ATTEMPT_REFERENCE_INVALID');
        if (reviews.has(event.payload.review_id) || executorSessions.has(event.payload.reviewer_session_id) || reviewerSessions.has(event.payload.reviewer_session_id)) throw new Error('REVIEW_SESSION_OR_ID_INVALID');
        attempt.review_started = true;
        reviewerSessions.add(event.payload.reviewer_session_id);
        currentReview = event;
        reviews.set(event.payload.review_id, { started: event, window_open: false });
      } else if (event.event_type === 'REVIEW_COMPLETED') {
        if (!currentReview || currentReview.payload.review_id !== event.payload.review_id) throw new Error('REVIEW_COMPLETION_OWNER_INVALID');
        for (const field of ['review_round', 'reviewer_binding_ref', 'reviewer_session_id', 'reviewed_attempt_id', 'executor_session_id_reviewed', 'started_monotonic_ms'] as const) if (currentReview.payload[field] !== event.payload[field]) throw new Error('REVIEW_COMPLETION_OWNERSHIP_MISMATCH');
        const attempt = attempts.get(event.payload.reviewed_attempt_id)?.completed;
        if (!attempt) throw new Error('ORPHAN_REVIEW');
        const expectedFrom = event.payload.review_round === 1 ? block.base_revision : previousReview?.payload.review_boundary_to_revision;
        const expectedPrevious = event.payload.review_round === 1 ? null : previousReview?.payload.review_boundary_hash;
        if (event.payload.review_boundary_from_revision !== expectedFrom || event.payload.review_boundary_to_revision !== attempt.payload.output_revision || event.payload.previous_review_boundary_hash !== expectedPrevious) throw new Error('REVIEW_BOUNDARY_CHAIN_INVALID');
        const validationHashes = (validations.get(event.payload.reviewed_attempt_id) ?? []).flatMap(validation => validation.payload.evidence_hashes);
        if (!sameStrings(event.payload.validation_evidence_hashes, validationHashes)) throw new Error('VALIDATION_EVIDENCE_MISMATCH');
        const nextUnresolved = new Set(unresolved);
        for (const finding of event.payload.material_findings) {
          if (!finding.material) throw new Error('MATERIAL_FINDING_FLAG_INVALID');
          if (finding.status === 'OPEN') nextUnresolved.add(finding.finding_id);
          else if (!nextUnresolved.delete(finding.finding_id)) throw new Error('ORPHAN_FINDING_RESOLUTION');
        }
        if (event.payload.non_material_findings.some(finding => finding.material)) throw new Error('NON_MATERIAL_FINDING_FLAG_INVALID');
        if (!sameStrings(event.payload.unresolved_finding_ids, [...nextUnresolved])) throw new Error('UNRESOLVED_FINDING_RETENTION_INVALID');
        unresolved.clear();
        for (const findingId of nextUnresolved) unresolved.add(findingId);
        const ownedReview = reviews.get(event.payload.review_id)!;
        ownedReview.completed = event;
        ownedReview.window_open = true;
        previousReview = event;
        currentReview = null;
        if (event.payload.decision === 'REJECT') rejectedReviewEventId = event.event_id;
        else { acceptedReview = event; acceptedCompletion = attempt; }
      } else if (event.event_type === 'ORCHESTRATOR_OPERATION_RECORDED') {
        const payload = event.payload;
        if (orchestratorOperations.has(payload.orchestrator_operation_id)) throw new Error('ORCHESTRATOR_OPERATION_ID_REUSED');
        if (!manifest.binding_registry.some(candidate => candidate.binding_ref === payload.binding_ref)) throw new Error('ORCHESTRATOR_OPERATION_BINDING_INVALID');
        orchestratorOperations.set(payload.orchestrator_operation_id, event);
        openOrchestratorOperation = event;
      } else if (event.event_type === 'USAGE_RECORDED') {
        const payload = event.payload;
        const binding = manifest.binding_registry.find(candidate => candidate.binding_ref === payload.binding_ref);
        if (!binding || payload.pricing_snapshot_id !== manifest.pricing_snapshot.pricing_snapshot_id || payload.currency !== manifest.pricing_snapshot.currency) throw new Error('USAGE_POLICY_INVALID');
        if (payload.orchestrator_operation_id !== null) {
          const operation = orchestratorOperations.get(payload.orchestrator_operation_id);
          if (!operation || operation !== openOrchestratorOperation) throw new Error('ORPHAN_OR_MISORDERED_USAGE_ORCHESTRATOR_OPERATION');
          if (payload.role !== 'orchestrator' || payload.binding_ref !== operation.payload.binding_ref || payload.attempt_number !== operation.payload.attempt_number) throw new Error('ORCHESTRATOR_USAGE_OWNERSHIP_MISMATCH');
        } else {
          openOrchestratorOperation = null;
          if (payload.role === 'orchestrator') throw new Error('ORCHESTRATOR_USAGE_OWNER_INVALID');
        }
        if (payload.attempt_id !== null) {
          const attempt = attempts.get(payload.attempt_id);
          if (!attempt?.completed || attempt.review_started) throw new Error('ORPHAN_OR_MISORDERED_USAGE_ATTEMPT');
          if (payload.role !== 'executor' || payload.binding_ref !== attempt.completed.payload.executor_binding_ref
            || payload.attempt_number !== attempt.completed.payload.attempt_number) throw new Error('ATTEMPT_USAGE_OWNERSHIP_MISMATCH');
        }
        if (payload.review_id !== null) {
          const review = reviews.get(payload.review_id);
          if (!review?.completed || !review.window_open) throw new Error('ORPHAN_OR_MISORDERED_USAGE_REVIEW');
          if (payload.role !== 'reviewer' || payload.binding_ref !== review.completed.payload.reviewer_binding_ref
            || payload.attempt_number !== review.completed.payload.review_round) throw new Error('REVIEW_USAGE_OWNERSHIP_MISMATCH');
        }
      } else if (event.event_type === 'PARENT_REWORK_RECORDED') {
        const ownedReview = reviews.get(event.payload.review_id);
        const review = ownedReview?.completed;
        const attempt = attempts.get(event.payload.attempt_id)?.completed;
        if (!review || !ownedReview.window_open || !attempt || review.payload.reviewed_attempt_id !== attempt.payload.attempt_id) throw new Error('ORPHAN_OR_MISORDERED_REWORK');
      } else if (event.event_type === 'ESCALATION_DECIDED') {
        if (!rejectedReviewEventId || event.payload.rejected_review_event_id !== rejectedReviewEventId) throw new Error('ESCALATION_REVIEW_REFERENCE_INVALID');
        escalationTargetBinding = event.payload.target_binding_ref;
      } else if (event.event_type === 'BLOCK_ACCEPTED') {
        if (!acceptedReview || !acceptedCompletion || event.payload.accepted_revision !== acceptedReview.payload.review_boundary_to_revision || event.payload.accepted_revision !== acceptedCompletion.payload.output_revision || event.payload.accepted_tree_hash !== acceptedCompletion.payload.output_tree_hash) throw new Error('ACCEPTED_REVISION_TREE_INVALID');
      } else if (event.event_type === 'POST_ACCEPT_DEFECT_RECORDED') {
        if (!acceptedReview || event.payload.accepted_review_id !== acceptedReview.payload.review_id || event.payload.affected_revision !== acceptedReview.payload.review_boundary_to_revision) throw new Error('DEFECT_ACCEPTANCE_REFERENCE_INVALID');
      }

      state = transitionChecked(state, event, manifest);
      if (state === 'INVALID') throw new Error('INVALID_TRANSITION');
      void arm;
    }
  } catch (error) {
    return invalid(targetBlockId, error, [...unresolved]);
  }
  if (state === null) return invalid(targetBlockId, 'EMPTY_REDUCTION', [...unresolved]);
  return {
    state, valid_history: true, invalid_reason_codes: [], block_id: targetBlockId,
    accepted_revision: state === 'ACCEPTED' ? acceptedCompletion?.payload.output_revision ?? null : null,
    accepted_tree_hash: state === 'ACCEPTED' ? acceptedCompletion?.payload.output_tree_hash ?? null : null,
    accepted_review_id: state === 'ACCEPTED' ? acceptedReview?.payload.review_id ?? null : null,
    unresolved_finding_ids: [...unresolved],
  };
}
