import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';
import { normalizedRepositoryRelativePathV4Schema } from './contract-schemas.js';
import type { RuntimeWorkContractV4 } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const storyId = z.string().regex(/^story_[A-Za-z0-9_-]{4,96}$/);
const sessionId = z.string().regex(/^session_[A-Za-z0-9_-]{16,96}$/);
const path = normalizedRepositoryRelativePathV4Schema.max(512);
const unique = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) => z.array(item).min(min).max(max).refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, 'items must be unique');
const operation = z.enum(['CREATE', 'MODIFY', 'DELETE']);
const candidateChangeSchema = z.object({ path, operation }).strict();

const storyBodySchema = z.object({
  story_id: storyId,
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(2_000),
  priority: z.number().int().min(1).max(10_000),
  depends_on: unique(storyId, 32),
  allowed_changes: unique(z.object({ path, operations: unique(operation, 3, 1) }).strict(), 64, 1),
  validation_ids: unique(z.string().min(1).max(128), 32, 1),
  acceptance_criteria: unique(z.string().min(1).max(512), 32, 1),
  max_attempts: z.number().int().min(1).max(3),
}).strict();

const storySchema = storyBodySchema.extend({ story_hash: hash }).strict();
const planBodySchema = z.object({
  schema_version: z.literal(4),
  run_id: z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/),
  contract_hash: hash,
  base_sha: sha,
  max_iterations: z.number().int().min(1).max(64),
  stories: z.array(storySchema).min(1).max(64),
}).strict();
const planSchema = planBodySchema.extend({ plan_hash: hash }).strict();

const iterationBodySchema = z.object({
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
  execution_result_hash: hash,
  validation_manifest_hash: hash,
  review_attestation_hash: hash.nullable(),
  finding_hashes: unique(hash, 128),
}).strict();
const iterationSchema = iterationBodySchema.extend({ event_hash: hash }).strict();
const executionCandidateSchema = z.object({ candidate_tree_hash: hash, changes: unique(candidateChangeSchema, 256, 1), result_hash: hash }).strict();
const validationResultSchema = z.object({ passed: z.boolean(), manifest_hash: hash, finding_hashes: unique(hash, 128) }).strict();
const reviewResultSchema = z.object({ accepted: z.boolean(), attestation_hash: hash, finding_hashes: unique(hash, 128) }).strict();

export type IterativeStoryV4 = z.infer<typeof storySchema>;
export type IterativeStoryPlanV4 = z.infer<typeof planSchema>;
export type StoryIterationEventV4 = z.infer<typeof iterationSchema>;

export interface AcceptedStoryReceiptV4 {
  readonly story_id: string;
  readonly output_tree_hash: string;
  readonly changes: readonly { readonly path: string; readonly operation: 'CREATE' | 'MODIFY' | 'DELETE' }[];
  readonly validation_manifest_hash: string;
  readonly review_attestation_hash: string;
}

export interface IterativeExecutionRequestV4 {
  readonly contract: RuntimeWorkContractV4;
  readonly plan: IterativeStoryPlanV4;
  readonly initial_tree_hash: string;
  readonly prior_events: readonly StoryIterationEventV4[];
  readonly execute: (input: {
    story: IterativeStoryV4;
    iteration: number;
    attempt: number;
    session_id: string;
    input_tree_hash: string;
    accepted_receipts: readonly AcceptedStoryReceiptV4[];
  }) => Promise<{ candidate_tree_hash: string; changes: readonly { readonly path: string; readonly operation: 'CREATE' | 'MODIFY' | 'DELETE' }[]; result_hash: string }>;
  readonly validate: (input: { story: IterativeStoryV4; candidate_tree_hash: string }) => Promise<{ passed: boolean; manifest_hash: string; finding_hashes: readonly string[] }>;
  readonly review: (input: { story: IterativeStoryV4; candidate_tree_hash: string; validation_manifest_hash: string }) => Promise<{ accepted: boolean; attestation_hash: string; finding_hashes: readonly string[] }>;
  /** Atomically records the event and, when present, promotes the accepted tree. */
  readonly persist_iteration: (input: {
    event: StoryIterationEventV4;
    promotion: { story: IterativeStoryV4; input_tree_hash: string; candidate_tree_hash: string } | null;
  }) => Promise<void>;
  readonly create_session_id: (input: { run_id: string; story_id: string; iteration: number; attempt: number }) => string;
}

export interface IterativeExecutionResultV4 {
  readonly status: 'COMPLETE' | 'ESCALATE' | 'ITERATION_LIMIT';
  readonly tree_hash: string;
  readonly accepted_receipts: readonly AcceptedStoryReceiptV4[];
  readonly events: readonly StoryIterationEventV4[];
  readonly escalation_story_id: string | null;
}

export interface IterativeTrajectorySnapshotV4 {
  readonly status: 'COMPLETE' | 'ESCALATE' | 'IN_PROGRESS';
  readonly tree_hash: string;
  readonly accepted_story_ids: readonly string[];
  readonly attempts_by_story: Readonly<Record<string, number>>;
  readonly session_count: number;
  readonly escalation_story_id: string | null;
  readonly events: readonly StoryIterationEventV4[];
}

function invalid(message: string): never { throw new Error(`INVALID_CONTRACT: ${message}`); }
function violation(message: string): never { throw new Error(`EXECUTOR_POLICY_VIOLATION: ${message}`); }

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

export function loadIterativeStoryPlanV4(value: unknown, contract: RuntimeWorkContractV4): IterativeStoryPlanV4 {
  exactHash(contract as unknown as Record<string, unknown>, 'contract_hash', 'work contract');
  const plan = planSchema.parse(structuredClone(value));
  exactHash(plan as unknown as Record<string, unknown>, 'plan_hash', 'plan');
  if (plan.run_id !== contract.run_id || plan.contract_hash !== contract.contract_hash || plan.base_sha !== contract.base_sha) invalid('plan identity does not match the work contract');
  const allowed = new Map(contract.allowed_changes.map((change) => [change.path, new Set(change.operations)]));
  const validationIds = new Set(contract.allowed_validation_ids);
  for (const story of plan.stories) {
    exactHash(story as unknown as Record<string, unknown>, 'story_hash', `story ${story.story_id}`);
    for (const change of story.allowed_changes) {
      const operations = allowed.get(change.path);
      if (operations === undefined || change.operations.some((operation) => !operations.has(operation))) invalid(`story ${story.story_id} exceeds allowed changes`);
    }
    if (story.validation_ids.some((id) => !validationIds.has(id))) invalid(`story ${story.story_id} uses an unapproved validation`);
  }
  assertDag(plan.stories);
  return Object.freeze({ ...plan, stories: Object.freeze(plan.stories.map((story) => Object.freeze({ ...story, depends_on: Object.freeze([...story.depends_on]), allowed_changes: Object.freeze(story.allowed_changes.map((change) => Object.freeze({ ...change, operations: Object.freeze([...change.operations]) }))), validation_ids: Object.freeze([...story.validation_ids]), acceptance_criteria: Object.freeze([...story.acceptance_criteria]) }))) }) as unknown as IterativeStoryPlanV4;
}

function nextStory(plan: IterativeStoryPlanV4, accepted: ReadonlyMap<string, AcceptedStoryReceiptV4>): IterativeStoryV4 | undefined {
  return [...plan.stories]
    .filter((candidate) => !accepted.has(candidate.story_id) && candidate.depends_on.every((id) => accepted.has(id)))
    .sort((left, right) => left.priority - right.priority || left.story_id.localeCompare(right.story_id))[0];
}

function changesAreAuthorized(story: IterativeStoryV4, changes: readonly { path: string; operation: 'CREATE' | 'MODIFY' | 'DELETE' }[]): boolean {
  const allowed = new Map(story.allowed_changes.map((change) => [change.path, new Set(change.operations)]));
  return changes.every((change) => allowed.get(change.path)?.has(change.operation) === true)
    && new Set(changes.map((change) => change.path)).size === changes.length;
}

export function createStoryIterationEventV4(body: z.input<typeof iterationBodySchema>): StoryIterationEventV4 {
  const parsed = iterationBodySchema.parse(structuredClone(body));
  return Object.freeze({ ...parsed, changes: Object.freeze(parsed.changes.map((change) => Object.freeze({ ...change }))), finding_hashes: Object.freeze([...parsed.finding_hashes]), event_hash: hashCanonicalV4(parsed) }) as unknown as StoryIterationEventV4;
}

export function loadStoryIterationEventV4(value: unknown): StoryIterationEventV4 {
  const event = iterationSchema.parse(structuredClone(value));
  exactHash(event as unknown as Record<string, unknown>, 'event_hash', 'iteration event');
  return Object.freeze({ ...event, changes: Object.freeze(event.changes.map((change) => Object.freeze({ ...change }))), finding_hashes: Object.freeze([...event.finding_hashes]) }) as unknown as StoryIterationEventV4;
}

function replay(plan: IterativeStoryPlanV4, initialTreeHash: string, supplied: readonly StoryIterationEventV4[]) {
  if (!/^[a-f0-9]{64}$/.test(initialTreeHash)) invalid('initial tree hash is invalid');
  if (supplied.length > plan.max_iterations) invalid('iteration history exceeds the plan budget');
  const events = supplied.map(loadStoryIterationEventV4);
  const attempts = new Map<string, number>();
  const accepted = new Map<string, AcceptedStoryReceiptV4>();
  const sessions = new Set<string>();
  let treeHash = initialTreeHash;
  let escalationStoryId: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.run_id !== plan.run_id || event.plan_hash !== plan.plan_hash || event.iteration !== index + 1 || event.input_tree_hash !== treeHash || sessions.has(event.session_id)) invalid('iteration history is not a contiguous plan-bound replay');
    const story = nextStory(plan, accepted);
    if (story === undefined || story.story_id !== event.story_id) invalid('iteration story selection is invalid');
    if (!changesAreAuthorized(story, event.changes)) invalid('iteration event exceeds the active story change authority');
    const attempt = (attempts.get(story.story_id) ?? 0) + 1;
    if (event.attempt !== attempt || attempt > story.max_attempts) invalid('iteration attempt sequence is invalid');
    attempts.set(story.story_id, attempt);
    sessions.add(event.session_id);
    if (event.outcome === 'ACCEPTED') {
      if (event.review_attestation_hash === null || event.finding_hashes.length !== 0 || event.candidate_tree_hash === event.input_tree_hash) invalid('accepted iteration evidence is inconsistent');
      treeHash = event.candidate_tree_hash;
      accepted.set(story.story_id, Object.freeze({ story_id: story.story_id, output_tree_hash: treeHash, changes: event.changes, validation_manifest_hash: event.validation_manifest_hash, review_attestation_hash: event.review_attestation_hash }));
    } else {
      if (event.finding_hashes.length === 0) invalid('rejected iteration lacks findings');
      if (event.outcome === 'ESCALATE') {
        if (attempt !== story.max_attempts || index !== events.length - 1) invalid('escalation must terminate history at the attempt limit');
        escalationStoryId = story.story_id;
      }
    }
  }
  return { events, attempts, accepted, sessions, treeHash, escalationStoryId };
}

export function inspectIterativeTrajectoryV4(input: { contract: RuntimeWorkContractV4; plan: IterativeStoryPlanV4; initial_tree_hash: string; events: readonly StoryIterationEventV4[] }): IterativeTrajectorySnapshotV4 {
  const plan = loadIterativeStoryPlanV4(input.plan, input.contract);
  const state = replay(plan, input.initial_tree_hash, input.events);
  const complete = state.accepted.size === plan.stories.length;
  return Object.freeze({
    status: complete ? 'COMPLETE' : state.escalationStoryId === null ? 'IN_PROGRESS' : 'ESCALATE',
    tree_hash: state.treeHash,
    accepted_story_ids: Object.freeze([...state.accepted.keys()]),
    attempts_by_story: Object.freeze(Object.fromEntries(state.attempts)),
    session_count: state.sessions.size,
    escalation_story_id: state.escalationStoryId,
    events: Object.freeze([...state.events]),
  });
}

export async function runIterativeExecutorV4(input: IterativeExecutionRequestV4): Promise<IterativeExecutionResultV4> {
  const plan = loadIterativeStoryPlanV4(input.plan, input.contract);
  const state = replay(plan, input.initial_tree_hash, input.prior_events);
  const events = [...state.events];
  if (state.escalationStoryId !== null) return Object.freeze({ status: 'ESCALATE', tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]), events: Object.freeze(events), escalation_story_id: state.escalationStoryId });
  while (events.length < plan.max_iterations) {
    const story = nextStory(plan, state.accepted);
    if (story === undefined) {
      if (state.accepted.size !== plan.stories.length) violation('story graph has no executable pending story');
      return Object.freeze({ status: 'COMPLETE', tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]), events: Object.freeze(events), escalation_story_id: null });
    }
    const attempt = (state.attempts.get(story.story_id) ?? 0) + 1;
    if (attempt > story.max_attempts) return Object.freeze({ status: 'ESCALATE', tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]), events: Object.freeze(events), escalation_story_id: story.story_id });
    const iteration = events.length + 1;
    const session = input.create_session_id({ run_id: plan.run_id, story_id: story.story_id, iteration, attempt });
    if (!sessionId.safeParse(session).success || state.sessions.has(session)) violation('executor session must be fresh and valid');
    const candidateResult = executionCandidateSchema.safeParse(await input.execute({ story, iteration, attempt, session_id: session, input_tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]) }));
    if (!candidateResult.success) violation('executor returned invalid evidence');
    const candidate = candidateResult.data;
    if (candidate.candidate_tree_hash === state.treeHash) violation('executor candidate must differ from the accepted tree');
    if (!changesAreAuthorized(story, candidate.changes)) violation('executor exceeded the active story change authority');
    const validationResult = validationResultSchema.safeParse(await input.validate({ story, candidate_tree_hash: candidate.candidate_tree_hash }));
    if (!validationResult.success) violation('validation returned invalid evidence');
    const validation = validationResult.data;
    const reviewResult = validation.passed ? reviewResultSchema.safeParse(await input.review({ story, candidate_tree_hash: candidate.candidate_tree_hash, validation_manifest_hash: validation.manifest_hash })) : null;
    if (reviewResult !== null && !reviewResult.success) violation('review returned invalid evidence');
    const review = reviewResult?.data ?? null;
    const accepted = validation.passed && review?.accepted === true;
    const findingHashes = [...new Set([...validation.finding_hashes, ...(review?.finding_hashes ?? [])])];
    if ((!accepted && findingHashes.length === 0) || (accepted && findingHashes.length !== 0)) violation('acceptance decision and findings are inconsistent');
    const outcome = accepted ? 'ACCEPTED' : attempt >= story.max_attempts ? 'ESCALATE' : 'RETRY';
    const event = createStoryIterationEventV4({ schema_version: 4, type: 'STORY_ITERATION_RECORDED', run_id: plan.run_id, plan_hash: plan.plan_hash, story_id: story.story_id, iteration, attempt, session_id: session, input_tree_hash: state.treeHash, candidate_tree_hash: candidate.candidate_tree_hash, outcome, changes: candidate.changes.map((change) => ({ ...change })), execution_result_hash: candidate.result_hash, validation_manifest_hash: validation.manifest_hash, review_attestation_hash: review?.attestation_hash ?? null, finding_hashes: findingHashes });
    await input.persist_iteration({ event, promotion: accepted ? { story, input_tree_hash: state.treeHash, candidate_tree_hash: candidate.candidate_tree_hash } : null });
    events.push(event);
    state.attempts.set(story.story_id, attempt);
    state.sessions.add(session);
    if (accepted) {
      state.treeHash = candidate.candidate_tree_hash;
      state.accepted.set(story.story_id, Object.freeze({ story_id: story.story_id, output_tree_hash: state.treeHash, changes: event.changes, validation_manifest_hash: event.validation_manifest_hash, review_attestation_hash: event.review_attestation_hash! }));
    } else if (outcome === 'ESCALATE') {
      return Object.freeze({ status: 'ESCALATE', tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]), events: Object.freeze(events), escalation_story_id: story.story_id });
    }
  }
  return Object.freeze({ status: state.accepted.size === plan.stories.length ? 'COMPLETE' : 'ITERATION_LIMIT', tree_hash: state.treeHash, accepted_receipts: Object.freeze([...state.accepted.values()]), events: Object.freeze(events), escalation_story_id: null });
}
