import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { A2A_PROTOCOL_VERSION_V1, projectRuntimeResultToA2AV1 } from '../src/runtime/a2a-adapter.js';
import type { RuntimeResultV4 } from '../src/runtime/contracts.js';
import { validRuntimeResult } from './runtime-contracts.test.js';

const timestamp = '2026-08-10T12:00:00.000Z';

function result(state: string, attempts = 0): RuntimeResultV4 {
  const base = validRuntimeResult();
  return { ...base, state, attempts: Array.from({ length: attempts }, (_, index) => ({ attempt: index + 1, executor_binding_ref: 'executor', result_hash: 'a'.repeat(64) })) } as RuntimeResultV4;
}

test('projects broker lifecycle states to A2A v1 task states without content artifacts', () => {
  const cases = [
    ['READY_FOR_EXECUTOR', 0, 'TASK_STATE_SUBMITTED'],
    ['READY_FOR_EXECUTOR', 1, 'TASK_STATE_WORKING'],
    ['EXECUTION_STARTED', 0, 'TASK_STATE_WORKING'],
    ['PULL_REQUEST_OPEN', 0, 'TASK_STATE_WORKING'],
    ['FINALIZED', 0, 'TASK_STATE_COMPLETED'],
    ['FAILED', 0, 'TASK_STATE_FAILED'],
    ['ABORTED', 0, 'TASK_STATE_CANCELED'],
  ] as const;
  for (const [runtimeState, attempts, expected] of cases) {
    const projection = projectRuntimeResultToA2AV1(result(runtimeState, attempts), timestamp);
    assert.equal(projection.status.state, expected);
    assert.equal(projection.metadata.agentOrchestration.protocolVersion, A2A_PROTOCOL_VERSION_V1);
    assert.equal(projection.metadata.agentOrchestration.projectionHash.length, 64);
    assert.deepEqual(Object.keys(projection), ['id', 'contextId', 'status', 'metadata']);
    assert.equal('artifacts' in projection, false);
    assert.equal('history' in projection, false);
  }
});

test('fails closed for unknown runtime state, malformed evidence, or implicit time', () => {
  assert.throws(() => projectRuntimeResultToA2AV1(result('WAITING_FOR_MAGIC'), timestamp), /INVALID_CONTRACT/);
  assert.throws(() => projectRuntimeResultToA2AV1({ ...result('FINALIZED'), contract_hash: 'bad' }, timestamp), /invalid/i);
  assert.throws(() => projectRuntimeResultToA2AV1(result('FINALIZED'), '2026-08-10'), /timestamp/);
});

test('publishes a strict schema for the content-free A2A projection', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/a2a-runtime-task-projection-v1.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  const projection = projectRuntimeResultToA2AV1(result('FINALIZED'), timestamp);
  assert.equal(validate(projection), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...projection, artifacts: [{ name: 'source' }] }), false);
  assert.equal(validate({ ...projection, metadata: { ...projection.metadata, credential: 'secret' } }), false);
});
