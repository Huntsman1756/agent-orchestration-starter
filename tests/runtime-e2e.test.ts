import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeOrchestratorV4 } from '../src/runtime/orchestrator.js';
import type { RuntimeFailureV4 } from '../src/runtime/failures.js';
import type { RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRuntimeResult, validTaskRequest } from './runtime-contracts.test.js';

test('one request is durably accepted once and automatically advances outside the short start call', async () => {
  const result = { ...validRuntimeResult(), state: 'READY_FOR_EXECUTOR', commit_sha: null, head_sha: null } as unknown as RuntimeResultV4;
  const byRequest = new Map<string, string>();
  let submits = 0;
  let advances = 0;
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const orchestrator = createRuntimeOrchestratorV4({
    command_id: () => 'fixed-command',
    daemon: {
      submit: async (command) => {
        submits += 1;
        const prior = byRequest.get(command.request.request_id);
        if (prior !== undefined)
          return { request_id: command.request.request_id, run_id: prior, state: result.state, status_token: 'a'.repeat(64) };
        byRequest.set(command.request.request_id, result.run_id);
        return { request_id: result.request_id, run_id: result.run_id, state: result.state, status_token: 'a'.repeat(64) };
      },
      status: async () => result,
    },
    pipeline: {
      advance: async () => {
        advances += 1;
        await completed;
        result.state = 'FINALIZED';
        result.commit_sha = 'c'.repeat(40);
      },
      abort: async () => {
        result.state = 'ABORTED';
      },
    },
    persist_terminal_failure: async () => {
      throw new Error('unexpected failure');
    },
  });
  const first = await orchestrator.start(validTaskRequest() as unknown as RuntimeTaskRequestV4);
  const replay = await orchestrator.start(validTaskRequest() as unknown as RuntimeTaskRequestV4);
  assert.equal(first.state, 'READY_FOR_EXECUTOR');
  assert.equal(replay.run_id, first.run_id);
  assert.equal(submits, 2);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(advances, 1);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await orchestrator.resume(result.run_id)).state, 'FINALIZED');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(advances, 1);
});

test('typed pipeline failure is persisted and abort delegates only to daemon-owned control', async () => {
  const result = { ...validRuntimeResult(), state: 'READY_FOR_EXECUTOR', failure: null } as unknown as RuntimeResultV4;
  const failures: RuntimeFailureV4[] = [];
  let aborted = false;
  const orchestrator = createRuntimeOrchestratorV4({
    daemon: {
      submit: async () => ({ request_id: result.request_id, run_id: result.run_id, state: result.state, status_token: 'a'.repeat(64) }),
      status: async () => result,
    },
    pipeline: {
      advance: async () => {
        throw new Error('VALIDATION_FAILED: raw repository detail');
      },
      abort: async () => {
        aborted = true;
        result.state = 'ABORTED';
      },
    },
    persist_terminal_failure: async (_runId, failure) => {
      failures.push(failure);
      result.state = 'FAILED';
      result.failure = failure;
    },
  });
  await orchestrator.start(validTaskRequest() as unknown as RuntimeTaskRequestV4);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.state, 'FAILED');
  assert.deepEqual(failures[0], {
    code: 'VALIDATION_FAILED',
    message: 'VALIDATION_FAILED: automated pipeline failed',
    retryable: false,
    evidence_hashes: [],
  });
  result.state = 'READY_FOR_EXECUTOR';
  result.failure = null;
  assert.equal((await orchestrator.abort(result.run_id)).state, 'ABORTED');
  assert.equal(aborted, true);
});
