import assert from 'node:assert/strict';
import test from 'node:test';

import type { BrokerDaemonV4 } from '../src/runtime/broker-daemon.js';
import { composeRuntimeHostControlV4, type RuntimeHostOperationsV4 } from '../src/runtime/host-composition.js';
import type { RuntimeFailureV4, RuntimeResultV4 } from '../src/runtime/contracts.js';
import { validRuntimeResult } from './runtime-contracts.test.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';

function daemonFixture() {
  const result = { ...validRuntimeResult(), run_id: runId, state: 'READY_FOR_EXECUTOR', failure: null } as RuntimeResultV4;
  const failures: RuntimeFailureV4[] = [];
  let aborts = 0;
  const daemon: BrokerDaemonV4 = {
    submit: async (command) => ({
      request_id: command.type === 'RUN_CODING_TASK' ? command.request.request_id : result.request_id,
      run_id: runId,
      state: result.state,
      status_token: 'a'.repeat(64),
    }),
    status: async () => result,
    recover: async () => undefined,
    close: async () => undefined,
    recordAttempt: async () => undefined,
    reinspect: async () => undefined,
    recordExternalProcessStarted: async () => undefined,
    recordAcceptedCandidate: async () => undefined,
    recordFailure: async (_id, failure) => {
      failures.push(failure);
      result.state = 'FAILED';
      result.failure = failure;
    },
    recordAbort: async () => {
      aborts += 1;
      result.state = 'ABORTED';
    },
    recordCommitCreated: async () => undefined,
    recordPublication: async () => undefined,
  };
  return { daemon, result, failures, aborts: () => aborts };
}

function operations(overrides: Partial<RuntimeHostOperationsV4> = {}): RuntimeHostOperationsV4 {
  return {
    advance: async () => undefined,
    prepareRepair: async () => undefined,
    finalize: async () => undefined,
    stopExternal: async () => undefined,
    ...overrides,
  };
}

test('automatically schedules one daemon-owned pipeline flight for replayed submissions', async () => {
  const fixture = daemonFixture();
  let advances = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = composeRuntimeHostControlV4(
    fixture.daemon,
    operations({
      advance: async () => {
        advances += 1;
        await blocked;
      },
    }),
  );
  const request = { schema_version: 4, request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1' } as never;
  await host.daemon.submit({ type: 'RUN_CODING_TASK', command_id: 'one', request });
  await host.daemon.submit({ type: 'RUN_CODING_TASK', command_id: 'two', request });
  assert.equal(advances, 1);
  await assert.rejects(() => host.controlPlane.finalize({ command_id: 'finalize', run_id: runId }), /REPOSITORY_BUSY/);
  release();
  await host.close();
});

test('persists bounded terminal failure without leaking operation details', async () => {
  const fixture = daemonFixture();
  const host = composeRuntimeHostControlV4(
    fixture.daemon,
    operations({
      advance: async () => {
        throw new Error('VALIDATION_FAILED: C:/secret/project/raw.log');
      },
    }),
  );
  const request = { schema_version: 4, request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1' } as never;
  await host.daemon.submit({ type: 'RUN_CODING_TASK', command_id: 'one', request });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.failures[0]?.code, 'VALIDATION_FAILED');
  assert.doesNotMatch(fixture.failures[0]?.message ?? '', /secret|raw\.log/);
  await host.close();
});

test('wires repair, finalize, and abort through exact host operations', async () => {
  const fixture = daemonFixture();
  const calls: string[] = [];
  const host = composeRuntimeHostControlV4(
    fixture.daemon,
    operations({
      prepareRepair: async (input) => {
        calls.push(`repair:${input.command_id}:${input.findings[0]?.id}`);
      },
      finalize: async (input) => {
        calls.push(`finalize:${input.command_id}`);
        fixture.result.state = 'FINALIZED';
      },
      stopExternal: async (id) => {
        calls.push(`abort:${id}`);
      },
    }),
  );
  await host.controlPlane.repair({
    command_id: 'repair-one',
    run_id: runId,
    findings: [{ id: 'finding-1', evidence_hash: 'b'.repeat(64) }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.result.state = 'REVIEW_ACCEPTED';
  await host.controlPlane.finalize({ command_id: 'finalize-one', run_id: runId });
  fixture.result.state = 'READY_FOR_EXECUTOR';
  await host.controlPlane.abort({ command_id: 'abort-one', run_id: runId });
  assert.deepEqual(calls, ['repair:repair-one:finding-1', 'finalize:finalize-one', `abort:${runId}`]);
  assert.equal(fixture.aborts(), 1);
  await host.close();
});
