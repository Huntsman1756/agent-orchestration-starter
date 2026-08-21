import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';
import { normalizedRepositoryRelativePathV4Schema } from './contract-schemas.js';
import type { RuntimeWorkContractV4 } from './contracts.js';
import { loadRepairPacketV4, type RepairPacketV4 } from './repair-packet.js';
import { loadWorkerCapabilityV4, type WorkerCapabilityV4 } from './worker-capability.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const storyId = z.string().regex(/^story_[A-Za-z0-9_-]{4,96}$/);
const sessionId = z.string().regex(/^session_[A-Za-z0-9_-]{16,96}$/);
const decisionId = z.string().regex(/^decision_[A-Za-z0-9_-]{16,96}$/);
const decisionOwnerRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
const path = normalizedRepositoryRelativePathV4Schema.max(512);
const unique = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, 'items must be unique');
const operation = z.enum(['CREATE', 'MODIFY', 'DELETE']);
const candidateChangeSchema = z.object({ path, operation }).strict();

const storyBodySchema = z
  .object({
    story_id: storyId,
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(2_000),
    priority: z.number().int().min(1).max(10_000),
    depends_on: unique(storyId, 32),
    allowed_changes: unique(z.object({ path, operations: unique(operation, 3, 1) }).strict(), 64, 1),
    validation_ids: unique(z.string().min(1).max(128), 32, 1),
    acceptance_criteria: unique(z.string().min(1).max(512), 32, 1),
    required_capabilities: unique(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/), 32, 1),
    context_budget_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
    max_changed_lines: z.number().int().min(1).max(100_000),
    max_steps: z.number().int().min(1).max(128),
    max_attempts: z.number().int().min(1).max(3),
  })
  .strict();

const storySchema = storyBodySchema.extend({ story_hash: hash }).strict();
const planBodySchema = z
  .object({
    schema_version: z.literal(4),
    run_id: z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/),
    contract_hash: hash,
    base_sha: sha,
    worker_capability_hash: hash,
    max_iterations: z.number().int().min(1).max(64),
    stories: z.array(storySchema).min(1).max(64),
  })
  .strict();
const planSchema = planBodySchema.extend({ plan_hash: hash }).strict();

const iterationBodySchema = z
  .object({
    schema_version: z.literal(4),
    type: z.literal('STORY_ITERATION_RECORDED'),
    run_id: z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/),
    plan_hash: hash,
    story_id: storyId,
    iteration: z.number().int().min(1).max(64),
    attempt: z.number().int().min(1).max(3),
    session_id: sessionId,
    input_tree_hash: hash,
    candidate_tree_hash: hash,
    outcome: z.enum(['ACCEPTED', 'RETRY', 'ESCALATE']),
    changes: unique(candidateChangeSchema, 256, 1),
    changed_lines: z.number().int().min(1).max(100_000),
    execution_result_hash: hash,
    validation_manifest_hash: hash,
    review_attestation_hash: hash.nullable(),
    finding_hashes: unique(hash, 128),
    repair_packet_hash: hash.nullable(),
    frontier_decision_hash: hash.nullable().optional(),
    failure_signature_hash: hash.nullable(),
    escalation_reason: z.enum(['ATTEMPT_LIMIT', 'NO_PROGRESS']).nullable(),
  })
  .strict();
const iterationSchema = iterationBodySchema.extend({ event_hash: hash }).strict();
const executionCandidateSchema = z
  .object({
    candidate_tree_hash: hash,
    changes: unique(candidateChangeSchema, 256, 1),
    changed_lines: z.number().int().min(1).max(100_000),
    result_hash: hash,
  })
  .strict();
const validationResultSchema = z
  .object({ passed: z.boolean(), manifest_hash: hash, finding_hashes: unique(hash, 128), failure_signature_hash: hash.nullable() })
  .strict();
const reviewResultSchema = z
  .object({ accepted: z.boolean(), attestation_hash: hash, finding_hashes: unique(hash, 128), failure_signature_hash: hash.nullable() })
  .strict();
const frontierDecisionInputSchema = z
  .object({
    decision_id: decisionId,
    decision_owner_ref: decisionOwnerRef,
    authority_evidence_hash: hash,
    rejected_event_hash: hash,
    action: z.enum(['RETRY', 'ESCALATE']),
  })
  .strict();
const frontierDecisionBodySchema = frontierDecisionInputSchema
  .extend({
    schema_version: z.literal(4),
    type: z.literal('FRONTIER_DECISION_RECORDED'),
    run_id: z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/),
    plan_hash: hash,
    decision_index: z.number().int().min(1).max(64),
    previous_decision_hash: hash.nullable(),
  })
  .strict();
const frontierDecisionSchema = frontierDecisionBodySchema.extend({ decision_hash: hash }).strict();
const reviewControlSchema = z
  .object({
    mode: z.enum(['AUTONOMOUS_BROKER', 'FRONTIER_LED']),
    frontier_decision: frontierDecisionInputSchema.optional(),
  })
  .strict();

export type IterativeStoryV4 = z.infer<typeof storySchema>;
export type IterativeStoryPlanV4 = z.infer<typeof planSchema>;
export type StoryIterationEventV4 = z.infer<typeof iterationSchema>;
export type FrontierDecisionEventV4 = z.infer<typeof frontierDecisionSchema>;

export interface AcceptedStoryReceiptV4 {
  readonly story_id: string;
  readonly output_tree_hash: string;
  readonly changes: readonly { readonly path: string; readonly operation: 'CREATE' | 'MODIFY' | 'DELETE' }[];
  readonly validation_manifest_hash: string;
  readonly review_attestation_hash: string;
}

export interface IterativeExecutionRequestV4 {
  readonly contract: RuntimeWorkContractV4;
  readonly worker: WorkerCapabilityV4;
  readonly plan: IterativeStoryPlanV4;
  readonly initial_tree_hash: string;
  readonly prior_events: readonly StoryIterationEventV4[];
  readonly prior_frontier_decisions?: readonly FrontierDecisionEventV4[];
  /**
   * FRONTIER_LED stops after every rejected attempt until the trusted host
   * supplies a decision bound to that exact persisted event.
   */
  readonly review_control?: {
    readonly mode: 'AUTONOMOUS_BROKER' | 'FRONTIER_LED';
    readonly frontier_decision?: {
      readonly decision_id: string;
      readonly decision_owner_ref: string;
      readonly authority_evidence_hash: string;
      readonly rejected_event_hash: string;
      readonly action: 'RETRY' | 'ESCALATE';
    };
  };
  readonly execute: (input: {
    story: IterativeStoryV4;
    iteration: number;
    attempt: number;
    session_id: string;
    input_tree_hash: string;
    accepted_receipts: readonly AcceptedStoryReceiptV4[];
    repair_packet: RepairPacketV4 | null;
  }) => Promise<{
    candidate_tree_hash: string;
    changes: readonly { readonly path: string; readonly operation: 'CREATE' | 'MODIFY' | 'DELETE' }[];
    changed_lines: number;
    result_hash: string;
  }>;
  readonly load_repair_packet: (input: {
    story: IterativeStoryV4;
    failed_attempt: number;
    finding_hashes: readonly string[];
  }) => Promise<RepairPacketV4>;
  readonly validate: (input: {
    story: IterativeStoryV4;
    candidate_tree_hash: string;
  }) => Promise<{ passed: boolean; manifest_hash: string; finding_hashes: readonly string[]; failure_signature_hash: string | null }>;
  readonly review: (input: {
    story: IterativeStoryV4;
    candidate_tree_hash: string;
    validation_manifest_hash: string;
  }) => Promise<{ accepted: boolean; attestation_hash: string; finding_hashes: readonly string[]; failure_signature_hash: string | null }>;
  /** Atomically records the event and, when present, promotes the accepted tree. */
  readonly persist_iteration: (input: {
    event: StoryIterationEventV4;
    promotion: { story: IterativeStoryV4; input_tree_hash: string; candidate_tree_hash: string } | null;
  }) => Promise<void>;
  /** Durably records a frontier authorization before its action can take effect. */
  readonly persist_frontier_decision?: (input: { event: FrontierDecisionEventV4 }) => Promise<void>;
  readonly create_session_id: (input: { run_id: string; story_id: string; iteration: number; attempt: number }) => string;
}

export interface IterativeExecutionResultV4 {
  readonly status: 'COMPLETE' | 'ESCALATE' | 'ITERATION_LIMIT' | 'AWAITING_FRONTIER_DECISION';
  readonly tree_hash: string;
  readonly accepted_receipts: readonly AcceptedStoryReceiptV4[];
  readonly events: readonly StoryIterationEventV4[];
  readonly frontier_decisions: readonly FrontierDecisionEventV4[];
  readonly escalation_story_id: string | null;
  readonly escalation_reason: 'ATTEMPT_LIMIT' | 'NO_PROGRESS' | 'FRONTIER_DECISION' | null;
}

export interface IterativeTrajectorySnapshotV4 {
  readonly status: 'COMPLETE' | 'ESCALATE' | 'IN_PROGRESS';
  readonly tree_hash: string;
  readonly accepted_story_ids: readonly string[];
  readonly attempts_by_story: Readonly<Record<string, number>>;
  readonly session_count: number;
  readonly escalation_story_id: string | null;
  readonly escalation_reason: 'ATTEMPT_LIMIT' | 'NO_PROGRESS' | 'FRONTIER_DECISION' | null;
  readonly events: readonly StoryIterationEventV4[];
  readonly frontier_decisions: readonly FrontierDecisionEventV4[];
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
}
function violation(message: string): never {
  throw new Error(`EXECUTOR_POLICY_VIOLATION: ${message}`);
}

function exactHash<T extends Record<string, unknown>>(value: T, hashKey: keyof T, label: string): void {
  const body = { ...value };
  const supplied = body[hashKey];
  delete body[hashKey];
  if (supplied !== hashCanonicalV4(body)) invalid(`${label} hash is invalid`);
}

function assertDag(stories: readonly IterativeStoryV4[]): void {
  const ids = new Set(stories.map((story) => story.story_id));
  if (ids.size !== stories.length) invalid('story IDs must be unique');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(stories.map((story) => [story.story_id, story]));
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid('story dependencies must be acyclic');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.depends_on) {
      if (!ids.has(dependency) || dependency === id) invalid('story dependency is invalid');
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const story of stories) visit(story.story_id);
}

export function loadIterativeStoryPlanV4(
  value: unknown,
  contract: RuntimeWorkContractV4,
  workerInput: WorkerCapabilityV4,
): IterativeStoryPlanV4 {
  exactHash(contract as unknown as Record<string, unknown>, 'contract_hash', 'work contract');
  const plan = planSchema.parse(structuredClone(value));
  exactHash(plan as unknown as Record<string, unknown>, 'plan_hash', 'plan');
  if (plan.run_id !== contract.run_id || plan.contract_hash !== contract.contract_hash || plan.base_sha !== contract.base_sha)
    invalid('plan identity does not match the work contract');
  const allowed = new Map(contract.implementation_targets.map((change) => [change.path, new Set(change.operations)]));
  const validationIds = new Set(contract.allowed_validation_ids);
  const worker = loadWorkerCapabilityV4(workerInput);
  if (plan.worker_capability_hash !== worker.worker_capability_hash) invalid('plan worker capability does not match the active worker');
  const workerCapabilities = new Set(worker.capabilities);
  for (const story of plan.stories) {
    exactHash(story as unknown as Record<string, unknown>, 'story_hash', `story ${story.story_id}`);
    for (const change of story.allowed_changes) {
      const operations = allowed.get(change.path);
      if (operations === undefined || change.operations.some((operation) => !operations.has(operation)))
        invalid(`story ${story.story_id} exceeds allowed changes`);
    }
    if (story.validation_ids.some((id) => !validationIds.has(id))) invalid(`story ${story.story_id} uses an unapproved validation`);
    if (story.allowed_changes.length > contract.max_files_changed)
      invalid(`story file budget exceeds the work contract for ${story.story_id}`);
    if (story.allowed_changes.length > worker.limits.max_story_files) invalid(`story files exceed worker capability for ${story.story_id}`);
    if (story.max_changed_lines > worker.limits.max_story_changed_lines || story.max_changed_lines > contract.max_changed_lines)
      invalid(`story changed-line budget exceeds worker capability for ${story.story_id}`);
    if (story.context_budget_bytes > worker.limits.max_story_context_bytes)
      invalid(`story context budget exceeds worker capability for ${story.story_id}`);
    if (story.acceptance_criteria.length > worker.limits.max_acceptance_criteria)
      invalid(`story acceptance criteria exceed worker capability for ${story.story_id}`);
    if (story.max_steps > worker.limits.max_steps_per_attempt) invalid(`story step budget exceeds worker capability for ${story.story_id}`);
    if (story.max_attempts > worker.limits.max_attempts) invalid(`story attempts exceed worker capability for ${story.story_id}`);
    if (story.required_capabilities.some((capability) => !workerCapabilities.has(capability)))
      invalid(`story requires an unsupported worker capability for ${story.story_id}`);
  }
  assertDag(plan.stories);
  const byId = new Map(plan.stories.map((story) => [story.story_id, story]));
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const value = Math.max(0, ...byId.get(id)!.depends_on.map((dependency) => depth(dependency) + 1));
    depths.set(id, value);
    return value;
  };
  if (plan.stories.some((story) => depth(story.story_id) > worker.limits.max_dependency_depth))
    invalid('story dependency depth exceeds worker capability');
  return Object.freeze({
    ...plan,
    stories: Object.freeze(
      plan.stories.map((story) =>
        Object.freeze({
          ...story,
          depends_on: Object.freeze([...story.depends_on]),
          allowed_changes: Object.freeze(
            story.allowed_changes.map((change) => Object.freeze({ ...change, operations: Object.freeze([...change.operations]) })),
          ),
          validation_ids: Object.freeze([...story.validation_ids]),
          acceptance_criteria: Object.freeze([...story.acceptance_criteria]),
          required_capabilities: Object.freeze([...story.required_capabilities]),
        }),
      ),
    ),
  }) as unknown as IterativeStoryPlanV4;
}

function nextStory(plan: IterativeStoryPlanV4, accepted: ReadonlyMap<string, AcceptedStoryReceiptV4>): IterativeStoryV4 | undefined {
  return [...plan.stories]
    .filter((candidate) => !accepted.has(candidate.story_id) && candidate.depends_on.every((id) => accepted.has(id)))
    .sort((left, right) => left.priority - right.priority || left.story_id.localeCompare(right.story_id))[0];
}

function changesAreAuthorized(
  story: IterativeStoryV4,
  changes: readonly { path: string; operation: 'CREATE' | 'MODIFY' | 'DELETE' }[],
): boolean {
  const allowed = new Map(story.allowed_changes.map((change) => [change.path, new Set(change.operations)]));
  return (
    changes.every((change) => allowed.get(change.path)?.has(change.operation) === true) &&
    new Set(changes.map((change) => change.path)).size === changes.length
  );
}

export function createStoryIterationEventV4(body: z.input<typeof iterationBodySchema>): StoryIterationEventV4 {
  const parsed = iterationBodySchema.parse(structuredClone(body));
  return Object.freeze({
    ...parsed,
    changes: Object.freeze(parsed.changes.map((change) => Object.freeze({ ...change }))),
    finding_hashes: Object.freeze([...parsed.finding_hashes]),
    event_hash: hashCanonicalV4(parsed),
  }) as unknown as StoryIterationEventV4;
}

export function loadStoryIterationEventV4(value: unknown): StoryIterationEventV4 {
  const event = iterationSchema.parse(structuredClone(value));
  exactHash(event as unknown as Record<string, unknown>, 'event_hash', 'iteration event');
  return Object.freeze({
    ...event,
    changes: Object.freeze(event.changes.map((change) => Object.freeze({ ...change }))),
    finding_hashes: Object.freeze([...event.finding_hashes]),
  }) as unknown as StoryIterationEventV4;
}

export function createFrontierDecisionEventV4(body: z.input<typeof frontierDecisionBodySchema>): FrontierDecisionEventV4 {
  const parsed = frontierDecisionBodySchema.parse(structuredClone(body));
  return Object.freeze({ ...parsed, decision_hash: hashCanonicalV4(parsed) });
}

export function loadFrontierDecisionEventV4(value: unknown): FrontierDecisionEventV4 {
  const event = frontierDecisionSchema.parse(structuredClone(value));
  exactHash(event as unknown as Record<string, unknown>, 'decision_hash', 'frontier decision');
  return Object.freeze({ ...event });
}

function replay(
  plan: IterativeStoryPlanV4,
  initialTreeHash: string,
  supplied: readonly StoryIterationEventV4[],
  worker: WorkerCapabilityV4,
) {
  if (!/^[a-f0-9]{64}$/.test(initialTreeHash)) invalid('initial tree hash is invalid');
  if (supplied.length > plan.max_iterations) invalid('iteration history exceeds the plan budget');
  const events = supplied.map(loadStoryIterationEventV4);
  const attempts = new Map<string, number>();
  const accepted = new Map<string, AcceptedStoryReceiptV4>();
  const sessions = new Set<string>();
  let treeHash = initialTreeHash;
  let escalationStoryId: string | null = null;
  let escalationReason: 'ATTEMPT_LIMIT' | 'NO_PROGRESS' | null = null;
  for (const [index, event] of events.entries()) {
    if (
      event.run_id !== plan.run_id ||
      event.plan_hash !== plan.plan_hash ||
      event.iteration !== index + 1 ||
      event.input_tree_hash !== treeHash ||
      sessions.has(event.session_id)
    )
      invalid('iteration history is not a contiguous plan-bound replay');
    const story = nextStory(plan, accepted);
    if (story === undefined || story.story_id !== event.story_id) invalid('iteration story selection is invalid');
    if (!changesAreAuthorized(story, event.changes)) invalid('iteration event exceeds the active story change authority');
    if (event.candidate_tree_hash === event.input_tree_hash) invalid('iteration candidate did not change the accepted tree');
    if (event.changed_lines > story.max_changed_lines) invalid('iteration exceeds the story changed-line budget');
    const attempt = (attempts.get(story.story_id) ?? 0) + 1;
    if (event.attempt !== attempt || attempt > story.max_attempts) invalid('iteration attempt sequence is invalid');
    if ((attempt === 1 && event.repair_packet_hash !== null) || (attempt > 1 && event.repair_packet_hash === null))
      invalid('iteration repair packet binding is invalid');
    attempts.set(story.story_id, attempt);
    sessions.add(event.session_id);
    if (event.outcome === 'ACCEPTED') {
      if (
        event.review_attestation_hash === null ||
        event.finding_hashes.length !== 0 ||
        event.failure_signature_hash !== null ||
        event.escalation_reason !== null
      )
        invalid('accepted iteration evidence is inconsistent');
      treeHash = event.candidate_tree_hash;
      accepted.set(
        story.story_id,
        Object.freeze({
          story_id: story.story_id,
          output_tree_hash: treeHash,
          changes: event.changes,
          validation_manifest_hash: event.validation_manifest_hash,
          review_attestation_hash: event.review_attestation_hash,
        }),
      );
    } else {
      if (event.finding_hashes.length === 0 || event.failure_signature_hash === null) invalid('rejected iteration lacks findings');
      let repeats = 1;
      for (let prior = index - 1; prior >= 0; prior -= 1) {
        const previous = events[prior]!;
        if (
          previous.story_id !== event.story_id ||
          previous.outcome === 'ACCEPTED' ||
          previous.failure_signature_hash !== event.failure_signature_hash
        )
          break;
        repeats += 1;
      }
      const expectedEscalationReason =
        repeats >= worker.limits.no_progress_repeat_limit
          ? ('NO_PROGRESS' as const)
          : attempt >= story.max_attempts
            ? ('ATTEMPT_LIMIT' as const)
            : null;
      if (event.outcome === 'ESCALATE') {
        if (event.escalation_reason !== expectedEscalationReason || expectedEscalationReason === null || index !== events.length - 1)
          invalid('escalation evidence is invalid');
        escalationStoryId = story.story_id;
        escalationReason = event.escalation_reason;
      } else if (event.escalation_reason !== null || expectedEscalationReason !== null) {
        invalid('retry should have escalated');
      }
    }
  }
  return { events, attempts, accepted, sessions, treeHash, escalationStoryId, escalationReason };
}

function replayFrontierDecisions(
  plan: IterativeStoryPlanV4,
  events: readonly StoryIterationEventV4[],
  supplied: readonly FrontierDecisionEventV4[],
  mode: 'AUTONOMOUS_BROKER' | 'FRONTIER_LED',
) {
  if (supplied.length > plan.max_iterations) invalid('frontier decision history exceeds the plan budget');
  const decisions = supplied.map(loadFrontierDecisionEventV4);
  if (mode === 'AUTONOMOUS_BROKER' && decisions.length > 0) invalid('frontier decision history requires FRONTIER_LED review control');
  const eventIndexByHash = new Map(events.map((event, index) => [event.event_hash, index]));
  const decisionByHash = new Map<string, FrontierDecisionEventV4>();
  const decisionIds = new Set<string>();
  const decidedRejections = new Set<string>();
  let previousDecisionHash: string | null = null;
  let previousTargetIndex = -1;
  let pendingRetry: FrontierDecisionEventV4 | null = null;
  let escalationDecision: FrontierDecisionEventV4 | null = null;
  for (const [index, decision] of decisions.entries()) {
    if (
      decision.run_id !== plan.run_id ||
      decision.plan_hash !== plan.plan_hash ||
      decision.decision_index !== index + 1 ||
      decision.previous_decision_hash !== previousDecisionHash
    ) {
      invalid('frontier decision history is not a contiguous plan-bound chain');
    }
    if (decisionIds.has(decision.decision_id) || decidedRejections.has(decision.rejected_event_hash))
      invalid('frontier decision is duplicated');
    const targetIndex = eventIndexByHash.get(decision.rejected_event_hash);
    if (targetIndex === undefined) invalid('frontier decision is stale or not bound to a rejected iteration');
    const target = events[targetIndex];
    if (target === undefined || target.outcome !== 'RETRY' || targetIndex <= previousTargetIndex)
      invalid('frontier decision is stale or not bound to a rejected iteration');
    const following = events[targetIndex + 1];
    if (decision.action === 'RETRY') {
      if (following === undefined) {
        if (index !== decisions.length - 1) invalid('pending frontier decision must be the end of the decision chain');
        pendingRetry = decision;
      } else if (following.frontier_decision_hash !== decision.decision_hash) {
        invalid('retry iteration is not bound to its durable frontier decision');
      }
    } else {
      if (following !== undefined || index !== decisions.length - 1) invalid('frontier escalation decision must terminate the trajectory');
      escalationDecision = decision;
    }
    decisionIds.add(decision.decision_id);
    decidedRejections.add(decision.rejected_event_hash);
    decisionByHash.set(decision.decision_hash, decision);
    previousDecisionHash = decision.decision_hash;
    previousTargetIndex = targetIndex;
  }
  for (const [index, event] of events.entries()) {
    if (event.attempt === 1) {
      if (event.frontier_decision_hash !== undefined && event.frontier_decision_hash !== null)
        invalid('first attempt cannot consume a frontier retry decision');
      continue;
    }
    if (mode === 'AUTONOMOUS_BROKER') {
      if (event.frontier_decision_hash !== undefined && event.frontier_decision_hash !== null)
        invalid('autonomous retry cannot consume a frontier decision');
      continue;
    }
    const prior = events[index - 1];
    const decision =
      event.frontier_decision_hash === undefined || event.frontier_decision_hash === null
        ? undefined
        : decisionByHash.get(event.frontier_decision_hash);
    if (
      prior === undefined ||
      prior.story_id !== event.story_id ||
      prior.outcome !== 'RETRY' ||
      decision?.action !== 'RETRY' ||
      decision.rejected_event_hash !== prior.event_hash
    ) {
      invalid('frontier-led retry lacks its exact durable decision');
    }
  }
  return { decisions, pendingRetry, escalationDecision };
}

export function inspectIterativeTrajectoryV4(input: {
  contract: RuntimeWorkContractV4;
  worker: WorkerCapabilityV4;
  plan: IterativeStoryPlanV4;
  initial_tree_hash: string;
  events: readonly StoryIterationEventV4[];
  review_control_mode?: 'AUTONOMOUS_BROKER' | 'FRONTIER_LED';
  frontier_decisions?: readonly FrontierDecisionEventV4[];
}): IterativeTrajectorySnapshotV4 {
  const worker = loadWorkerCapabilityV4(input.worker);
  const plan = loadIterativeStoryPlanV4(input.plan, input.contract, worker);
  const state = replay(plan, input.initial_tree_hash, input.events, worker);
  const frontierState = replayFrontierDecisions(
    plan,
    state.events,
    input.frontier_decisions ?? [],
    input.review_control_mode ?? 'AUTONOMOUS_BROKER',
  );
  const complete = state.accepted.size === plan.stories.length;
  return Object.freeze({
    status: complete
      ? 'COMPLETE'
      : state.escalationStoryId === null && frontierState.escalationDecision === null
        ? 'IN_PROGRESS'
        : 'ESCALATE',
    tree_hash: state.treeHash,
    accepted_story_ids: Object.freeze([...state.accepted.keys()]),
    attempts_by_story: Object.freeze(Object.fromEntries(state.attempts)),
    session_count: state.sessions.size,
    escalation_story_id:
      state.escalationStoryId ??
      (frontierState.escalationDecision === null
        ? null
        : (state.events.find((event) => event.event_hash === frontierState.escalationDecision?.rejected_event_hash)?.story_id ?? null)),
    escalation_reason: state.escalationReason ?? (frontierState.escalationDecision === null ? null : 'FRONTIER_DECISION'),
    events: Object.freeze([...state.events]),
    frontier_decisions: Object.freeze([...frontierState.decisions]),
  });
}

export async function runIterativeExecutorV4(input: IterativeExecutionRequestV4): Promise<IterativeExecutionResultV4> {
  const worker = loadWorkerCapabilityV4(input.worker);
  const plan = loadIterativeStoryPlanV4(input.plan, input.contract, worker);
  const parsedReviewControl = reviewControlSchema.safeParse(input.review_control ?? { mode: 'AUTONOMOUS_BROKER' });
  if (!parsedReviewControl.success) invalid('review control is invalid');
  const controlMode = parsedReviewControl.data.mode;
  const frontierDecision = parsedReviewControl.data.frontier_decision;
  const state = replay(plan, input.initial_tree_hash, input.prior_events, worker);
  const events = [...state.events];
  const frontierState = replayFrontierDecisions(plan, events, input.prior_frontier_decisions ?? [], controlMode);
  const frontierDecisions = [...frontierState.decisions];
  if (state.escalationStoryId !== null)
    return Object.freeze({
      status: 'ESCALATE',
      tree_hash: state.treeHash,
      accepted_receipts: Object.freeze([...state.accepted.values()]),
      events: Object.freeze(events),
      frontier_decisions: Object.freeze(frontierDecisions),
      escalation_story_id: state.escalationStoryId,
      escalation_reason: state.escalationReason,
    });
  if (frontierState.escalationDecision !== null) {
    const rejected = events.find((event) => event.event_hash === frontierState.escalationDecision?.rejected_event_hash)!;
    return Object.freeze({
      status: 'ESCALATE',
      tree_hash: state.treeHash,
      accepted_receipts: Object.freeze([...state.accepted.values()]),
      events: Object.freeze(events),
      frontier_decisions: Object.freeze(frontierDecisions),
      escalation_story_id: rejected.story_id,
      escalation_reason: 'FRONTIER_DECISION',
    });
  }
  const pendingRejection = events.at(-1)?.outcome === 'RETRY' ? events.at(-1)! : null;
  let activeFrontierDecisionHash: string | null = frontierState.pendingRetry?.decision_hash ?? null;
  if (controlMode === 'AUTONOMOUS_BROKER' && frontierDecision !== undefined)
    invalid('frontier decision requires FRONTIER_LED review control');
  if (controlMode === 'FRONTIER_LED') {
    if (pendingRejection === null && frontierDecision !== undefined) invalid('frontier decision has no pending rejected iteration');
    if (frontierState.pendingRetry !== null && frontierDecision !== undefined) invalid('frontier decision is duplicated');
    if (pendingRejection !== null && frontierDecision === undefined && frontierState.pendingRetry === null) {
      return Object.freeze({
        status: 'AWAITING_FRONTIER_DECISION',
        tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        events: Object.freeze(events),
        frontier_decisions: Object.freeze(frontierDecisions),
        escalation_story_id: null,
        escalation_reason: null,
      });
    }
    if (pendingRejection !== null && frontierDecision !== undefined && frontierDecision.rejected_event_hash !== pendingRejection.event_hash)
      invalid('frontier decision is not bound to the pending rejected iteration');
    if (pendingRejection !== null && frontierDecision !== undefined) {
      if (
        frontierDecisions.some(
          (decision) =>
            decision.decision_id === frontierDecision.decision_id || decision.rejected_event_hash === frontierDecision.rejected_event_hash,
        )
      )
        invalid('frontier decision is duplicated');
      if (input.persist_frontier_decision === undefined) violation('frontier decision persistence is unavailable');
      const decisionEvent = createFrontierDecisionEventV4({
        schema_version: 4,
        type: 'FRONTIER_DECISION_RECORDED',
        run_id: plan.run_id,
        plan_hash: plan.plan_hash,
        decision_index: frontierDecisions.length + 1,
        previous_decision_hash: frontierDecisions.at(-1)?.decision_hash ?? null,
        ...frontierDecision,
      });
      await input.persist_frontier_decision({ event: decisionEvent });
      frontierDecisions.push(decisionEvent);
      activeFrontierDecisionHash = decisionEvent.decision_hash;
      if (frontierDecision.action === 'ESCALATE') {
        return Object.freeze({
          status: 'ESCALATE',
          tree_hash: state.treeHash,
          accepted_receipts: Object.freeze([...state.accepted.values()]),
          events: Object.freeze(events),
          frontier_decisions: Object.freeze(frontierDecisions),
          escalation_story_id: pendingRejection.story_id,
          escalation_reason: 'FRONTIER_DECISION',
        });
      }
    }
  }
  while (events.length < plan.max_iterations) {
    const story = nextStory(plan, state.accepted);
    if (story === undefined) {
      if (state.accepted.size !== plan.stories.length) violation('story graph has no executable pending story');
      return Object.freeze({
        status: 'COMPLETE',
        tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        events: Object.freeze(events),
        frontier_decisions: Object.freeze(frontierDecisions),
        escalation_story_id: null,
        escalation_reason: null,
      });
    }
    const attempt = (state.attempts.get(story.story_id) ?? 0) + 1;
    if (attempt > story.max_attempts)
      return Object.freeze({
        status: 'ESCALATE',
        tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        events: Object.freeze(events),
        frontier_decisions: Object.freeze(frontierDecisions),
        escalation_story_id: story.story_id,
        escalation_reason: 'ATTEMPT_LIMIT',
      });
    const iteration = events.length + 1;
    const session = input.create_session_id({ run_id: plan.run_id, story_id: story.story_id, iteration, attempt });
    if (!sessionId.safeParse(session).success || state.sessions.has(session)) violation('executor session must be fresh and valid');
    const previousFailure = [...events].reverse().find((event) => event.story_id === story.story_id && event.outcome !== 'ACCEPTED');
    let repairPacket: RepairPacketV4 | null = null;
    if (attempt > 1) {
      if (controlMode === 'FRONTIER_LED' && activeFrontierDecisionHash === null) violation('retry lacks a durable frontier decision');
      if (previousFailure === undefined || previousFailure.attempt !== attempt - 1) violation('retry lacks contiguous failure evidence');
      repairPacket = loadRepairPacketV4(
        await input.load_repair_packet({ story, failed_attempt: previousFailure.attempt, finding_hashes: previousFailure.finding_hashes }),
      );
      if (
        repairPacket.story_id !== story.story_id ||
        repairPacket.failed_attempt !== previousFailure.attempt ||
        repairPacket.findings.length !== previousFailure.finding_hashes.length ||
        repairPacket.findings.some((finding) => !previousFailure.finding_hashes.includes(finding.evidence_hash))
      ) {
        violation('repair packet differs from persisted failure evidence');
      }
    }
    const candidateResult = executionCandidateSchema.safeParse(
      await input.execute({
        story,
        iteration,
        attempt,
        session_id: session,
        input_tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        repair_packet: repairPacket,
      }),
    );
    if (!candidateResult.success) violation('executor returned invalid evidence');
    const candidate = candidateResult.data;
    if (candidate.candidate_tree_hash === state.treeHash) violation('executor candidate must differ from the accepted tree');
    if (!changesAreAuthorized(story, candidate.changes)) violation('executor exceeded the active story change authority');
    if (candidate.changed_lines > story.max_changed_lines) violation('executor exceeded the story changed-line budget');
    const validationResult = validationResultSchema.safeParse(
      await input.validate({ story, candidate_tree_hash: candidate.candidate_tree_hash }),
    );
    if (!validationResult.success) violation('validation returned invalid evidence');
    const validation = validationResult.data;
    const reviewResult = validation.passed
      ? reviewResultSchema.safeParse(
          await input.review({
            story,
            candidate_tree_hash: candidate.candidate_tree_hash,
            validation_manifest_hash: validation.manifest_hash,
          }),
        )
      : null;
    if (reviewResult !== null && !reviewResult.success) violation('review returned invalid evidence');
    const review = reviewResult?.data ?? null;
    const accepted = validation.passed && review?.accepted === true;
    if (validation.passed !== (validation.finding_hashes.length === 0 && validation.failure_signature_hash === null))
      violation('validation failure evidence is inconsistent');
    if (review !== null && review.accepted !== (review.finding_hashes.length === 0 && review.failure_signature_hash === null))
      violation('review failure evidence is inconsistent');
    const findingHashes = [...new Set([...validation.finding_hashes, ...(review?.finding_hashes ?? [])])];
    if ((!accepted && findingHashes.length === 0) || (accepted && findingHashes.length !== 0))
      violation('acceptance decision and findings are inconsistent');
    const failureSignatureHash = accepted
      ? null
      : hashCanonicalV4({ validation: validation.failure_signature_hash, review: review?.failure_signature_hash ?? null });
    let repeats = accepted ? 0 : 1;
    if (failureSignatureHash !== null) {
      for (let prior = events.length - 1; prior >= 0; prior -= 1) {
        const previous = events[prior]!;
        if (
          previous.story_id !== story.story_id ||
          previous.outcome === 'ACCEPTED' ||
          previous.failure_signature_hash !== failureSignatureHash
        )
          break;
        repeats += 1;
      }
    }
    const noProgress = repeats >= worker.limits.no_progress_repeat_limit;
    const escalationReason = accepted
      ? null
      : noProgress
        ? ('NO_PROGRESS' as const)
        : attempt >= story.max_attempts
          ? ('ATTEMPT_LIMIT' as const)
          : null;
    const outcome = accepted ? 'ACCEPTED' : escalationReason === null ? 'RETRY' : 'ESCALATE';
    const event = createStoryIterationEventV4({
      schema_version: 4,
      type: 'STORY_ITERATION_RECORDED',
      run_id: plan.run_id,
      plan_hash: plan.plan_hash,
      story_id: story.story_id,
      iteration,
      attempt,
      session_id: session,
      input_tree_hash: state.treeHash,
      candidate_tree_hash: candidate.candidate_tree_hash,
      outcome,
      changes: candidate.changes.map((change) => ({ ...change })),
      changed_lines: candidate.changed_lines,
      execution_result_hash: candidate.result_hash,
      validation_manifest_hash: validation.manifest_hash,
      review_attestation_hash: review?.attestation_hash ?? null,
      finding_hashes: findingHashes,
      repair_packet_hash: repairPacket?.packet_hash ?? null,
      frontier_decision_hash: attempt > 1 ? activeFrontierDecisionHash : null,
      failure_signature_hash: failureSignatureHash,
      escalation_reason: escalationReason,
    });
    await input.persist_iteration({
      event,
      promotion: accepted ? { story, input_tree_hash: state.treeHash, candidate_tree_hash: candidate.candidate_tree_hash } : null,
    });
    events.push(event);
    state.attempts.set(story.story_id, attempt);
    state.sessions.add(session);
    if (accepted) {
      state.treeHash = candidate.candidate_tree_hash;
      state.accepted.set(
        story.story_id,
        Object.freeze({
          story_id: story.story_id,
          output_tree_hash: state.treeHash,
          changes: event.changes,
          validation_manifest_hash: event.validation_manifest_hash,
          review_attestation_hash: event.review_attestation_hash!,
        }),
      );
    } else if (outcome === 'ESCALATE') {
      return Object.freeze({
        status: 'ESCALATE',
        tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        events: Object.freeze(events),
        frontier_decisions: Object.freeze(frontierDecisions),
        escalation_story_id: story.story_id,
        escalation_reason: escalationReason,
      });
    } else if (controlMode === 'FRONTIER_LED') {
      return Object.freeze({
        status: 'AWAITING_FRONTIER_DECISION',
        tree_hash: state.treeHash,
        accepted_receipts: Object.freeze([...state.accepted.values()]),
        events: Object.freeze(events),
        frontier_decisions: Object.freeze(frontierDecisions),
        escalation_story_id: null,
        escalation_reason: null,
      });
    }
  }
  return Object.freeze({
    status: state.accepted.size === plan.stories.length ? 'COMPLETE' : 'ITERATION_LIMIT',
    tree_hash: state.treeHash,
    accepted_receipts: Object.freeze([...state.accepted.values()]),
    events: Object.freeze(events),
    frontier_decisions: Object.freeze(frontierDecisions),
    escalation_story_id: null,
    escalation_reason: null,
  });
}
