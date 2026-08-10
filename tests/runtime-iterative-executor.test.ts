import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { loadIterativeStoryPlanV4, runIterativeExecutorV4, type IterativeStoryPlanV4, type StoryIterationEventV4 } from '../src/runtime/iterative-executor.js';
import { validWorkContract } from './runtime-contracts.test.js';

const evidence = (character: string) => character.repeat(64);

function contract(): RuntimeWorkContractV4 {
  const source = validWorkContract();
  const body = { ...source, allowed_changes: [{ path: 'src/a.ts', operations: ['MODIFY'] }, { path: 'src/b.ts', operations: ['CREATE'] }], allowed_validation_ids: ['typecheck', 'test'] } as Record<string, unknown>;
  delete body.contract_hash;
  return { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
}

function story(input: { id: string; path: string; operation: 'CREATE' | 'MODIFY'; priority: number; dependencies?: string[]; attempts?: number }) {
  const body = { story_id: input.id, title: `Implement ${input.id}`, objective: `Complete ${input.id}`, priority: input.priority, depends_on: input.dependencies ?? [], allowed_changes: [{ path: input.path, operations: [input.operation] }], validation_ids: ['typecheck', 'test'], acceptance_criteria: [`${input.id} is validated`], max_attempts: input.attempts ?? 2 };
  return { ...body, story_hash: hashCanonicalV4(body) };
}

function plan(work = contract()): IterativeStoryPlanV4 {
  const stories = [story({ id: 'story_alpha', path: 'src/a.ts', operation: 'MODIFY', priority: 1 }), story({ id: 'story_beta', path: 'src/b.ts', operation: 'CREATE', priority: 2, dependencies: ['story_alpha'] })];
  const body = { schema_version: 4 as const, run_id: work.run_id, contract_hash: work.contract_hash, base_sha: work.base_sha, max_iterations: 6, stories };
  return { ...body, plan_hash: hashCanonicalV4(body) };
}

function fixture(options: { rejectFirst?: boolean; alwaysReject?: boolean; prior?: StoryIterationEventV4[] } = {}) {
  const work = contract();
  const storyPlan = plan(work);
  const calls: Array<{ story: string; attempt: number; input: string; receipts: readonly string[]; session: string }> = [];
  const events: StoryIterationEventV4[] = [...(options.prior ?? [])];
  const promotions: string[] = [];
  let executions = 0;
  return { work, storyPlan, calls, events, promotions, input: {
    contract: work,
    plan: storyPlan,
    initial_tree_hash: evidence('1'),
    prior_events: options.prior ?? [],
    create_session_id: ({ iteration }: { iteration: number }) => `session_${String(iteration).padStart(16, '0')}`,
    execute: async (value: any) => {
      executions += 1;
      calls.push({ story: value.story.story_id, attempt: value.attempt, input: value.input_tree_hash, receipts: value.accepted_receipts.map((receipt: any) => receipt.story_id), session: value.session_id });
      return { candidate_tree_hash: value.input_tree_hash === evidence('1') ? evidence('2') : evidence('3'), changes: [{ path: value.story.allowed_changes[0].path, operation: value.story.allowed_changes[0].operations[0] }], result_hash: evidence('4') };
    },
    validate: async () => ({ passed: true, manifest_hash: evidence('5'), finding_hashes: [] }),
    review: async ({ story }: any) => {
      const rejected = options.alwaysReject || (options.rejectFirst && story.story_id === 'story_alpha' && calls.filter((call) => call.story === 'story_alpha').length === 1);
      return { accepted: !rejected, attestation_hash: evidence('6'), finding_hashes: rejected ? [evidence('7')] : [] };
    },
    persist_iteration: async ({ event, promotion }: any) => {
      events.push(event);
      if (promotion !== null) promotions.push(promotion.story.story_id);
    },
  } };
}

test('executes one dependency-ordered story per fresh context and carries only accepted receipts', async () => {
  const value = fixture();
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(value.calls.map((call) => [call.story, call.attempt, call.receipts]), [['story_alpha', 1, []], ['story_beta', 1, ['story_alpha']]]);
  assert.notEqual(value.calls[0]!.session, value.calls[1]!.session);
  assert.deepEqual(value.promotions, ['story_alpha', 'story_beta']);
  assert.deepEqual(result.events.map((event) => event.outcome), ['ACCEPTED', 'ACCEPTED']);
});

test('retries a rejected candidate from the last accepted tree without promoting rejected bytes', async () => {
  const value = fixture({ rejectFirst: true });
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(value.calls.slice(0, 2).map((call) => [call.story, call.attempt, call.input]), [['story_alpha', 1, evidence('1')], ['story_alpha', 2, evidence('1')]]);
  assert.deepEqual(value.promotions, ['story_alpha', 'story_beta']);
  assert.deepEqual(result.events.slice(0, 2).map((event) => event.outcome), ['RETRY', 'ACCEPTED']);
});

test('escalates after the story attempt budget instead of looping indefinitely', async () => {
  const value = fixture({ alwaysReject: true });
  const result = await runIterativeExecutorV4(value.input);
  assert.equal(result.status, 'ESCALATE');
  assert.equal(result.escalation_story_id, 'story_alpha');
  assert.equal(value.calls.length, 2);
  assert.deepEqual(value.promotions, []);
});

test('resumes from verified events and rejects forged plans, sessions, paths, and histories', async () => {
  const first = fixture();
  const persisted: StoryIterationEventV4[] = [];
  first.input.persist_iteration = async ({ event }: any) => {
    persisted.push(event);
    throw new Error('simulated lost response after atomic persistence');
  };
  await assert.rejects(runIterativeExecutorV4(first.input), /simulated lost response/);
  const resumed = fixture({ prior: persisted });
  const result = await runIterativeExecutorV4(resumed.input);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(resumed.calls.map((call) => call.story), ['story_beta']);

  const forgedEventBody = structuredClone(persisted[0]) as any;
  delete forgedEventBody.event_hash;
  forgedEventBody.changes[0].operation = 'DELETE';
  const forgedEvent = { ...forgedEventBody, event_hash: hashCanonicalV4(forgedEventBody) };
  const forgedHistory = fixture({ prior: [forgedEvent] });
  await assert.rejects(runIterativeExecutorV4(forgedHistory.input), /change authority/);

  const invalid = fixture();
  assert.throws(() => loadIterativeStoryPlanV4({ ...invalid.storyPlan, plan_hash: evidence('0') }, invalid.work), /INVALID_CONTRACT/);
  const outsideStory = story({ id: 'story_bad1', path: 'src/outside.ts', operation: 'MODIFY', priority: 1 });
  const outsideBody = { ...invalid.storyPlan, stories: [outsideStory] } as any;
  delete outsideBody.plan_hash;
  assert.throws(() => loadIterativeStoryPlanV4({ ...outsideBody, plan_hash: hashCanonicalV4(outsideBody) }, invalid.work), /allowed changes/);
  const duplicateSession = fixture();
  duplicateSession.input.create_session_id = () => 'session_0000000000000001';
  await assert.rejects(runIterativeExecutorV4(duplicateSession.input), /fresh and valid/);

  const wrongOperation = fixture();
  wrongOperation.input.execute = async (value: any) => ({ candidate_tree_hash: evidence('2'), changes: [{ path: value.story.allowed_changes[0].path, operation: 'DELETE' }], result_hash: evidence('4') });
  await assert.rejects(runIterativeExecutorV4(wrongOperation.input), /change authority/);
});

test('publishes strict provider-neutral JSON schemas for plans and iteration receipts', async () => {
  const value = fixture();
  const result = await runIterativeExecutorV4(value.input);
  const ajv = new Ajv2020({ strict: true });
  const planSchema = JSON.parse(await readFile(new URL('../contracts/runtime-story-plan-v4.schema.json', import.meta.url), 'utf8'));
  const iterationSchema = JSON.parse(await readFile(new URL('../contracts/runtime-story-iteration-v4.schema.json', import.meta.url), 'utf8'));
  const validatePlan = ajv.compile(planSchema);
  const validateIteration = ajv.compile(iterationSchema);
  assert.equal(validatePlan(value.storyPlan), true, JSON.stringify(validatePlan.errors));
  assert.equal(validateIteration(result.events[0]), true, JSON.stringify(validateIteration.errors));
  assert.equal(validatePlan({ ...value.storyPlan, provider: 'coupled-provider' }), false);
  assert.equal(validateIteration({ ...result.events[0], raw_reasoning: 'hidden context' }), false);
});
