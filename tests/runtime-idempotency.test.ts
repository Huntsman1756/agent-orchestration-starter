import assert from 'node:assert/strict';
import test from 'node:test';

import { registerRequestV4, replayRequestIndexV4 } from '../src/runtime/request-idempotency.js';

test('returns the existing run for the same request ID and canonical request hash', () => {
  const initial = registerRequestV4({}, 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', 'a'.repeat(64), 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');

  const replay = registerRequestV4(initial.index, 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', 'a'.repeat(64), 'run_DIFFERENT000000000000');

  assert.equal(replay.created, false);
  assert.equal(replay.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
});

test('rejects reuse of a request ID for different canonical bytes', () => {
  const initial = registerRequestV4({}, 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', 'a'.repeat(64), 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');

  assert.throws(
    () => registerRequestV4(initial.index, 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', 'b'.repeat(64), 'run_DIFFERENT000000000000'),
    /INVALID_CONTRACT/,
  );
});

test('rejects duplicate accepted request records that disagree during replay', () => {
  assert.throws(
    () => replayRequestIndexV4([
      { request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', request_hash: 'a'.repeat(64), run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1' },
      { request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', request_hash: 'b'.repeat(64), run_id: 'run_DIFFERENT000000000000' },
    ]),
    /BROKER_STATE_CORRUPT/,
  );
});
