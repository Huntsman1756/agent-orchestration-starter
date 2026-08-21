import assert from 'node:assert/strict';
import test from 'node:test';

import { appendRuntimeEventV4, createRuntimeEventV4, RUNTIME_EVENT_TYPES_V4 } from '../src/runtime/telemetry.js';

const hash = 'a'.repeat(64);
const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
function event(type: (typeof RUNTIME_EVENT_TYPES_V4)[number], sequence: number, previous_hash: string | null) {
  return createRuntimeEventV4({
    schema_version: 4,
    type,
    event_id: `evt_${String(sequence).padStart(16, '0')}`,
    run_id: runId,
    sequence,
    previous_hash,
    recorded_at: '2026-08-10T12:00:00.000Z',
    contract_hash: hash,
    evidence_hashes: [hash],
  });
}

test('accepts every approved bounded event in one strict hash chain and idempotently replays exact IDs', () => {
  let log = Object.freeze([]) as ReturnType<typeof appendRuntimeEventV4>;
  for (const type of RUNTIME_EVENT_TYPES_V4) {
    const next = event(type, log.length + 1, log.at(-1)?.event_hash ?? null);
    log = appendRuntimeEventV4(log, next);
    assert.equal(appendRuntimeEventV4(log, next), log);
  }
  assert.equal(log.length, RUNTIME_EVENT_TYPES_V4.length);
  assert.throws(() => appendRuntimeEventV4(log, { ...log[0]!, event_hash: 'b'.repeat(64) }), /self-hash|collision/);
  assert.throws(() => appendRuntimeEventV4(log, event('RUN_FAILED', log.length + 2, log.at(-1)!.event_hash)), /chain/);
  const tampered = [...log];
  tampered[0] = { ...tampered[0]!, event_hash: 'b'.repeat(64) };
  assert.throws(() => appendRuntimeEventV4(tampered, event('RUN_FAILED', log.length + 1, log.at(-1)!.event_hash)), /self-hash/);
  const { event_hash: _discarded, ...identityDraft } = event('RUN_FAILED', log.length + 1, log.at(-1)!.event_hash);
  assert.throws(
    () =>
      appendRuntimeEventV4(
        log,
        createRuntimeEventV4({ ...identityDraft, event_id: 'evt_identity-change1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N2' }),
      ),
    /identity/,
  );
});

test('recursively rejects raw context, secret fields, credential-shaped values, and unbounded findings', () => {
  const base = {
    schema_version: 4 as const,
    type: 'RUN_FAILED' as const,
    event_id: 'evt_0000000000000001',
    run_id: runId,
    sequence: 1,
    previous_hash: null,
    recorded_at: '2026-08-10T12:00:00.000Z',
    contract_hash: hash,
    evidence_hashes: [hash],
  };
  for (const value of [
    { ...base, prompt: 'hidden' },
    { ...base, nested: { reasoning: 'hidden' } },
    { ...base, credential: 'x' },
    { ...base, binding_ref: `sk-${'x'.repeat(24)}` },
  ])
    assert.throws(() => createRuntimeEventV4(value as never), /telemetry/);
  assert.throws(() => createRuntimeEventV4({ ...base, evidence_hashes: [hash, hash] }), /unique/);
  assert.throws(
    () =>
      createRuntimeEventV4({
        ...base,
        findings: Array.from({ length: 129 }, (_, index) => ({ id: `f-${index}`, severity: 'low' as const, evidence_hash: hash })),
      }),
    /too_big|128|array/i,
  );
});
