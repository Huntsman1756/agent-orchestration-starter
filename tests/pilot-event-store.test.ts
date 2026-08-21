import assert from 'node:assert/strict';
import test from 'node:test';

import type { PilotEventV3 } from '../src/pilot/contracts.js';
import { canonicalize, hashCanonical } from '../src/pilot/canonical-json.js';
import { activeEvents, appendEvent } from '../src/pilot/event-store.js';
import { assertSafeEvent } from '../src/pilot/sensitive-guard.js';

const hash = (character: string) => character.repeat(64);
const timestamp = '2026-08-08T12:00:00.000Z';
type PlannedEvent = Extract<PilotEventV3, { event_type: 'BLOCK_PLANNED' }>;
type InvalidationEvent = Extract<PilotEventV3, { event_type: 'EVENT_INVALIDATED' }>;

// @ts-expect-error EVENT_INVALIDATED cannot carry the supersession envelope.
const invalidatedWithSupersession: PilotEventV3 = {
  ...planned('type-invalid', 1),
  event_type: 'EVENT_INVALIDATED',
  payload: { invalidated_event_id: 'event-prior', expected_event_content_hash: hash('c'), reason_code: 'corrected' },
  supersedes_event_id: 'event-prior',
  expected_superseded_event_content_hash: hash('c'),
};
void invalidatedWithSupersession;

function planned(eventId: string, sequenceNumber: number, blockId = 'block-a'): PlannedEvent {
  return {
    schema_version: 3,
    event_id: eventId,
    event_type: 'BLOCK_PLANNED',
    pilot_id: 'pilot-v3-001',
    manifest_hash: hash('a'),
    task_id: 'task-a',
    block_id: blockId,
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: 'triplet-a',
    case_fingerprint: hash('b'),
    pilot_arm: 'C_ADAPTIVE_EARLY_ESCALATION',
    sequence_number: sequenceNumber,
    occurred_at: timestamp,
    recorded_at: timestamp,
    producer_id: 'test-producer',
    payload: { planned_block_hash: hash('c') },
  };
}

function superseding(eventId: string, sequenceNumber: number, target: PilotEventV3, expectedHash = hashCanonical(target)): PilotEventV3 {
  return {
    ...planned(eventId, sequenceNumber, target.block_id),
    supersedes_event_id: target.event_id,
    expected_superseded_event_content_hash: expectedHash,
  };
}

function invalidating(
  eventId: string,
  sequenceNumber: number,
  target: PilotEventV3,
  expectedHash = hashCanonical(target),
): InvalidationEvent {
  const {
    supersedes_event_id: _supersedesEventId,
    expected_superseded_event_content_hash: _expectedSupersededEventContentHash,
    ...base
  } = planned(eventId, sequenceNumber, target.block_id);
  return {
    ...base,
    event_type: 'EVENT_INVALIDATED',
    payload: {
      invalidated_event_id: target.event_id,
      expected_event_content_hash: expectedHash,
      reason_code: 'corrected',
    },
  };
}

test('assertSafeEvent rejects raw content, secret-bearing fields, credential-shaped values, overlong strings, and arbitrary payload fields', () => {
  const rawFieldNames = ['prompt', 'response', 'transcript', 'diff', 'source', 'environment'];
  for (const fieldName of rawFieldNames) {
    const unsafe = planned(`unsafe-${fieldName}`, 1) as unknown as { payload: Record<string, unknown> };
    unsafe.payload[fieldName] = 'raw-content';
    assert.throws(() => assertSafeEvent(unsafe as PilotEventV3), new RegExp(fieldName, 'i'));
  }

  const secretKey = planned('unsafe-secret', 1) as unknown as { payload: Record<string, unknown> };
  secretKey.payload.api_key = 'safe-looking-value';
  assert.throws(() => assertSafeEvent(secretKey as PilotEventV3), /secret|credential/i);

  const credentialValue = { ...planned('unsafe-credential', 1), producer_id: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' };
  assert.throws(() => assertSafeEvent(credentialValue as PilotEventV3), /credential/i);

  const overlong = { ...planned('unsafe-overlong', 1), producer_id: 'x'.repeat(129) };
  assert.throws(() => assertSafeEvent(overlong as PilotEventV3), /too long/i);

  const arbitraryPayload = planned('unsafe-payload', 1) as unknown as { payload: Record<string, unknown> };
  arbitraryPayload.payload.audit_note = 'not part of the event contract';
  assert.throws(() => assertSafeEvent(arbitraryPayload as PilotEventV3), /payload|event/i);
});

test('appendEvent enforces globally unique IDs and contiguous per-block sequences', () => {
  const first = planned('event-1', 1);
  const log = appendEvent([], first);

  assert.throws(() => appendEvent(log, planned('event-2', 3)), /sequence/i);
  assert.throws(() => appendEvent(log, planned('event-1', 2)), /event_id|id/i);
  assert.throws(() => appendEvent([], planned('event-3', 2)), /sequence/i);
});

test('appendEvent makes crash retries idempotent and fails closed for same-ID content changes', () => {
  const committed = planned('event-1', 1);
  const afterCommit = appendEvent([], committed);
  const afterRetry = appendEvent(afterCommit, { ...committed });
  assert.equal(afterRetry, afterCommit, 'a byte-identical retry must not create another audit entry');

  const divergentRetry = { ...committed, producer_id: 'other-producer' } as PilotEventV3;
  assert.throws(() => appendEvent(afterCommit, divergentRetry), /different content|event_id/i);
});

test('appendEvent owns an immutable snapshot instead of the producer event reference', () => {
  const producerEvent = planned('event-owned', 1);
  const log = appendEvent([], producerEvent);

  (producerEvent.payload as Record<string, unknown>).planned_block_hash = hash('d');

  assert.equal((log[0].payload as Record<string, unknown>).planned_block_hash, hash('c'));
  assert.equal(appendEvent(log, planned('event-owned', 1)), log);
});

test('activeEvents does not expose mutable audit-history references to consumers', () => {
  const prior = planned('event-prior', 1);
  const correction = superseding('event-correction', 2, prior);
  const log = appendEvent(appendEvent([], prior), correction);
  const projection = activeEvents(log);

  try {
    (projection[0].payload as Record<string, unknown>).planned_block_hash = hash('d');
  } catch {
    // Frozen projections are also valid as long as history remains unchanged.
  }

  assert.equal((activeEvents(log)[0].payload as Record<string, unknown>).planned_block_hash, hash('c'));
});

test('appendEvent rejects corrupt historical supersession and invalidation references before accepting a new event', () => {
  const prior = planned('event-prior', 1);
  const mismatchedSupersession = superseding('event-bad-supersession', 2, prior, hash('9'));
  assert.throws(() => appendEvent([prior, mismatchedSupersession], planned('event-next', 3)), /hash/i);

  const mismatchedInvalidation = invalidating('event-bad-invalidation', 2, prior, hash('9'));
  assert.throws(() => appendEvent([prior, mismatchedInvalidation], planned('event-next', 3)), /hash/i);
});

test('appendEvent rejects undefined own optional envelope properties before canonical retry comparison', () => {
  const committed = planned('event-undefined', 1);
  const log = appendEvent([], committed);
  const retryWithUndefinedEnvelope = {
    ...committed,
    supersedes_event_id: undefined,
    expected_superseded_event_content_hash: undefined,
  } as PilotEventV3;

  assert.throws(
    () => appendEvent(log, retryWithUndefinedEnvelope),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /Canonical JSON/i);
      return /undefined|contract/i.test(error.message);
    },
  );
});

test('appendEvent rejects unknown and hash-mismatched supersession and invalidation targets', () => {
  const prior = planned('event-prior', 1);
  const log = appendEvent([], prior);

  assert.throws(() => appendEvent(log, superseding('event-supersedes-unknown', 2, planned('unknown', 1))), /unknown|supersed/i);
  assert.throws(() => appendEvent(log, superseding('event-supersedes-mismatch', 2, prior, hash('9'))), /hash/i);
  assert.throws(() => appendEvent(log, invalidating('event-invalidates-unknown', 2, planned('unknown', 1))), /unknown|invalidat/i);
  assert.throws(() => appendEvent(log, invalidating('event-invalidates-mismatch', 2, prior, hash('9'))), /hash/i);
});

test('activeEvents deterministically projects corrections while preserving the immutable audit log', () => {
  const prior = planned('event-prior', 1);
  const correction = superseding('event-correction', 2, prior);
  const log = appendEvent(appendEvent([], prior), correction);

  assert.deepEqual(
    log.map((event) => event.event_id),
    ['event-prior', 'event-correction'],
  );
  assert.deepEqual(
    activeEvents(log).map((event) => event.event_id),
    ['event-correction'],
  );

  const invalidation = invalidating('event-invalidation', 3, correction);
  const correctedLog = appendEvent(log, invalidation);
  assert.deepEqual(
    activeEvents(correctedLog).map((event) => event.event_id),
    ['event-prior'],
  );
});

test('invalidating a superseding correction restores the original event in the active projection', () => {
  const original = planned('event-original', 1);
  const correction = superseding('event-correction', 2, original);
  const invalidation = invalidating('event-invalidate-correction', 3, correction);
  const log = appendEvent(appendEvent(appendEvent([], original), correction), invalidation);

  assert.deepEqual(
    activeEvents(log).map((event) => event.event_id),
    ['event-original'],
  );
});

test('invalidating an invalidation recursively restores the original event', () => {
  const original = planned('event-original-nested', 1);
  const invalidation = invalidating('event-invalidate-original', 2, original);
  const reversal = invalidating('event-invalidate-invalidation', 3, invalidation);
  const log = appendEvent(appendEvent(appendEvent([], original), invalidation), reversal);

  assert.deepEqual(
    activeEvents(log).map((event) => event.event_id),
    ['event-original-nested'],
  );
});

test('nested invalidation effects resolve newest-first at every dependency depth', () => {
  const original = planned('event-original-depth', 1);
  const first = invalidating('event-invalidation-depth-1', 2, original);
  const second = invalidating('event-invalidation-depth-2', 3, first);
  const third = invalidating('event-invalidation-depth-3', 4, second);
  const fourth = invalidating('event-invalidation-depth-4', 5, third);
  const oddDepth = appendEvent(appendEvent(appendEvent(appendEvent([], original), first), second), third);
  const evenDepth = appendEvent(oddDepth, fourth);

  assert.deepEqual(
    activeEvents(oddDepth).map((event) => event.event_id),
    [],
  );
  assert.deepEqual(
    activeEvents(evenDepth).map((event) => event.event_id),
    ['event-original-depth'],
  );
});

test('two writers with one snapshot cannot both claim the same next sequence', () => {
  const snapshot = appendEvent([], planned('event-1', 1));
  const writerA = planned('event-writer-a', 2);
  const writerB = planned('event-writer-b', 2);
  const committedByA = appendEvent(snapshot, writerA);

  assert.throws(() => appendEvent(committedByA, writerB), /sequence/i);
  assert.equal(appendEvent(committedByA, { ...writerA }), committedByA);
});

test('activeEvents produces canonical byte-equivalent output for the same correction stream', () => {
  const prior = planned('event-prior', 1);
  const correction = superseding('event-correction', 2, prior);
  const reorderedCorrection = {
    expected_superseded_event_content_hash: correction.expected_superseded_event_content_hash,
    supersedes_event_id: correction.supersedes_event_id,
    payload: correction.payload,
    producer_id: correction.producer_id,
    recorded_at: correction.recorded_at,
    occurred_at: correction.occurred_at,
    sequence_number: correction.sequence_number,
    pilot_arm: correction.pilot_arm,
    case_fingerprint: correction.case_fingerprint,
    pair_or_triplet_id: correction.pair_or_triplet_id,
    matching_stratum: correction.matching_stratum,
    block_id: correction.block_id,
    task_id: correction.task_id,
    manifest_hash: correction.manifest_hash,
    pilot_id: correction.pilot_id,
    event_type: correction.event_type,
    event_id: correction.event_id,
    schema_version: correction.schema_version,
  } as PilotEventV3;

  const firstProjection = activeEvents([prior, correction]);
  const secondProjection = activeEvents([prior, reorderedCorrection]);
  assert.deepEqual(
    firstProjection.map((event) => event.event_id),
    ['event-correction'],
  );
  assert.deepEqual(
    secondProjection.map((event) => event.event_id),
    ['event-correction'],
  );
  assert.equal(canonicalize(firstProjection), canonicalize(secondProjection));
});
