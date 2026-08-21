import type { PilotEventV3 } from './contracts.js';
import { canonicalize, hashCanonical } from './canonical-json.js';
import { assertSafeEvent } from './sensitive-guard.js';

type InvalidationEvent = PilotEventV3 & {
  event_type: 'EVENT_INVALIDATED';
  payload: { invalidated_event_id: string; expected_event_content_hash: string };
};

function eventHash(event: PilotEventV3): string {
  return hashCanonical(event);
}

function isInvalidationEvent(event: PilotEventV3): event is InvalidationEvent {
  return event.event_type === 'EVENT_INVALIDATED';
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isDeepFrozen(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function snapshotEvent(event: PilotEventV3): PilotEventV3 {
  assertSafeEvent(event);
  return deepFreeze(JSON.parse(canonicalize(event)) as PilotEventV3);
}

function ownedLog(log: readonly PilotEventV3[]): readonly PilotEventV3[] {
  if (Object.isFrozen(log) && isDeepFrozen(log)) return log;
  return Object.freeze(log.map(snapshotEvent));
}

function assertValidLog(log: readonly PilotEventV3[]): void {
  const eventIds = new Set<string>();
  const nextSequenceByBlock = new Map<string, number>();
  for (let index = 0; index < log.length; index += 1) {
    const event = log[index];
    assertSafeEvent(event);
    if (eventIds.has(event.event_id)) throw new Error(`Duplicate event_id ${event.event_id} in audit log`);
    eventIds.add(event.event_id);
    const expectedSequence = nextSequenceByBlock.get(event.block_id) ?? 1;
    if (event.sequence_number !== expectedSequence) {
      throw new Error(`Expected contiguous sequence ${expectedSequence} for block ${event.block_id}`);
    }
    nextSequenceByBlock.set(event.block_id, expectedSequence + 1);
    assertReferencesKnown(log.slice(0, index), event);
  }
}

function assertReferencesKnown(log: readonly PilotEventV3[], event: PilotEventV3): void {
  const knownEvents = new Map(log.map((candidate) => [candidate.event_id, candidate]));
  if (event.supersedes_event_id) {
    const superseded = knownEvents.get(event.supersedes_event_id);
    if (!superseded) throw new Error(`Unknown superseded event ${event.supersedes_event_id}`);
    if (event.expected_superseded_event_content_hash !== eventHash(superseded)) {
      throw new Error(`Superseded event ${event.supersedes_event_id} content hash mismatch`);
    }
  }
  if (isInvalidationEvent(event)) {
    const invalidated = knownEvents.get(event.payload.invalidated_event_id);
    if (!invalidated) throw new Error(`Unknown invalidated event ${event.payload.invalidated_event_id}`);
    if (event.payload.expected_event_content_hash !== eventHash(invalidated)) {
      throw new Error(`Invalidated event ${event.payload.invalidated_event_id} content hash mismatch`);
    }
  }
}

export function appendEvent(log: readonly PilotEventV3[], event: PilotEventV3): readonly PilotEventV3[] {
  const stableLog = ownedLog(log);
  assertValidLog(stableLog);
  const stableEvent = snapshotEvent(event);
  const existing = stableLog.find((candidate) => candidate.event_id === stableEvent.event_id);
  if (existing) {
    if (canonicalize(existing) === canonicalize(stableEvent)) return stableLog;
    throw new Error(`event_id ${stableEvent.event_id} already exists with different content`);
  }
  const expectedSequence = stableLog.reduce((count, candidate) => count + Number(candidate.block_id === stableEvent.block_id), 1);
  if (stableEvent.sequence_number !== expectedSequence) {
    throw new Error(`Expected contiguous sequence ${expectedSequence} for block ${stableEvent.block_id}`);
  }
  assertReferencesKnown(stableLog, stableEvent);
  return Object.freeze([...stableLog, stableEvent]);
}

export function activeEvents(log: readonly PilotEventV3[]): readonly PilotEventV3[] {
  const stableLog = ownedLog(log);
  assertValidLog(stableLog);
  const inactiveEventIds = new Set<string>();
  for (let index = stableLog.length - 1; index >= 0; index -= 1) {
    const event = stableLog[index];
    assertReferencesKnown(stableLog.slice(0, index), event);
    if (isInvalidationEvent(event)) {
      if (!inactiveEventIds.has(event.event_id)) inactiveEventIds.add(event.payload.invalidated_event_id);
      inactiveEventIds.add(event.event_id);
    }
  }
  for (const event of stableLog) {
    if (!inactiveEventIds.has(event.event_id) && event.supersedes_event_id) inactiveEventIds.add(event.supersedes_event_id);
  }
  return Object.freeze(stableLog.filter((event) => !inactiveEventIds.has(event.event_id)));
}
