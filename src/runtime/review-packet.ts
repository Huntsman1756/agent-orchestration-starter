import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeResultV4 } from './contracts.js';
import { loadRuntimeWorkContractV4 } from './load.js';
import {
  buildReviewEnvelope,
  type ReviewEnvelopeV4,
} from './review-envelope.js';

export type BrokerVerdictV4 = 'APPROVED' | 'REJECTED';

export interface BrokerReviewPacketV4 {
  readonly schema_version: 4;
  readonly run_id: string;
  readonly request_id: string;
  readonly state: 'REVIEW_ACCEPTED';
  readonly contract_hash: string;
  readonly base_sha: string;
  readonly diff_hash: string;
  readonly tree_hash: string;
  readonly capability_snapshot_hash: string;
  readonly validation_manifest_hash: string;
  readonly envelope: ReviewEnvelopeV4;
  readonly packet_hash: string;
}

export interface BrokerReviewPacketInputV4 {
  readonly result: RuntimeResultV4;
  readonly envelope: ReviewEnvelopeV4;
}

export interface BrokerVerdictInputV4 {
  readonly run_id: string;
  readonly packet_hash: string;
  readonly verdict: BrokerVerdictV4;
  readonly reason: string;
}

export interface BrokerVerdictRecordV4 {
  readonly schema_version: 4;
  readonly run_id: string;
  readonly review_packet_hash: string;
  readonly contract_hash: string;
  readonly diff_hash: string;
  readonly tree_hash: string;
  readonly capability_snapshot_hash: string;
  readonly verdict: BrokerVerdictV4;
  readonly reason: string;
  readonly verdict_hash: string;
}

function invalid(message: string): never {
  throw new Error(`REVIEW_PACKET_INVALID: ${message}`);
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(`${name} is invalid`);
  return value;
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^run_[A-Za-z0-9_-]{16,96}$/u.test(value)) invalid('run_id is invalid');
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^req_[A-Za-z0-9_-]{16,96}$/u.test(value)) invalid('request_id is invalid');
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) invalid(`${name} has unknown or missing properties`);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function validateEnvelope(envelope: ReviewEnvelopeV4): ReviewEnvelopeV4 {
  const rebuilt = buildReviewEnvelope({
    contract: envelope.contract,
    complete_diff: envelope.complete_diff,
    changed_files: envelope.changed_files,
    capability_snapshot_hash: envelope.capability_snapshot_hash,
    diff_hash: envelope.diff_hash,
    tree_hash: envelope.tree_hash,
    validation_results: envelope.validation_manifest,
    unresolved_findings: envelope.unresolved_findings,
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(envelope)) invalid('envelope hash or canonical bytes are invalid');
  return rebuilt;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildBrokerReviewPacket(input: BrokerReviewPacketInputV4): BrokerReviewPacketV4 {
  if (Object.keys(input).sort().join(',') !== 'envelope,result') invalid('packet input contains hidden context');
  if (input.result.state !== 'REVIEW_ACCEPTED') throw new Error('REVIEW_PACKET_UNAVAILABLE: deterministic validation and review are not complete');

  const envelope = validateEnvelope(input.envelope);
  if (envelope.unresolved_findings.length > 0) throw new Error('REVIEW_PACKET_UNAVAILABLE: unresolved review findings must be repaired before verdict submission');
  const contract = loadRuntimeWorkContractV4(structuredClone(envelope.contract));
  if (contract.run_id !== input.result.run_id || contract.request_id !== input.result.request_id) invalid('packet identity is not bound to the run');
  if (contract.contract_hash !== input.result.contract_hash || envelope.contract.contract_hash !== input.result.contract_hash) invalid('packet contract hash does not match the durable result');
  if (envelope.base_sha !== input.result.base_sha || envelope.diff_hash !== input.result.diff_hash || envelope.tree_hash !== input.result.tree_hash) invalid('packet diff/tree evidence does not match the durable result');
  if (envelope.changed_files.length !== input.result.changed_files.length || envelope.changed_files.some((path, index) => path !== input.result.changed_files[index])) invalid('packet changed files do not match the durable result');
  if (envelope.validation_manifest.length !== input.result.validation_results.length) invalid('packet validation manifest length does not match the durable result');
  for (const [index, validation] of envelope.validation_manifest.entries()) {
    const result = input.result.validation_results[index];
    if (result === undefined || result.exit_code !== 0 || validation.validation_id !== result.validation_id || !validation.passed || validation.result_hash !== result.result_hash || validation.validated_tree_hash !== input.result.tree_hash) {
      invalid('packet contains validation evidence that is not deterministically accepted');
    }
  }

  const body = {
    schema_version: 4 as const,
    run_id: input.result.run_id,
    request_id: input.result.request_id,
    state: 'REVIEW_ACCEPTED' as const,
    contract_hash: input.result.contract_hash,
    base_sha: input.result.base_sha,
    diff_hash: input.result.diff_hash,
    tree_hash: input.result.tree_hash,
    capability_snapshot_hash: envelope.capability_snapshot_hash,
    validation_manifest_hash: envelope.validation_manifest_hash,
    envelope,
  };
  return freeze({ ...body, packet_hash: hashCanonicalV4(body) });
}

export function loadBrokerReviewPacketV4(value: unknown): BrokerReviewPacketV4 {
  const packet = objectValue(value, 'review packet');
  exactKeys(packet, ['schema_version', 'run_id', 'request_id', 'state', 'contract_hash', 'base_sha', 'diff_hash', 'tree_hash', 'capability_snapshot_hash', 'validation_manifest_hash', 'envelope', 'packet_hash'], 'review packet');
  if (packet.schema_version !== 4 || packet.state !== 'REVIEW_ACCEPTED') invalid('review packet schema or state is invalid');
  const envelope = objectValue(packet.envelope, 'review envelope') as unknown as ReviewEnvelopeV4;
  const normalized = buildBrokerReviewPacket({
    result: {
      run_id: runId(packet.run_id),
      request_id: requestId(packet.request_id),
      state: 'REVIEW_ACCEPTED',
      base_sha: String(packet.base_sha),
      contract_hash: hash(packet.contract_hash, 'contract_hash'),
      diff_hash: hash(packet.diff_hash, 'diff_hash'),
      tree_hash: hash(packet.tree_hash, 'tree_hash'),
      capability_snapshot_hash: hash(packet.capability_snapshot_hash, 'capability_snapshot_hash'),
      changed_files: envelope.changed_files,
      validation_results: envelope.validation_manifest.map((item) => ({ validation_id: item.validation_id, exit_code: item.passed ? 0 : 1, result_hash: item.result_hash })),
    } as unknown as RuntimeResultV4,
    envelope,
  });
  if (normalized.packet_hash !== hash(packet.packet_hash, 'packet_hash') || normalized.request_id !== requestId(packet.request_id) || normalized.run_id !== runId(packet.run_id)
    || normalized.capability_snapshot_hash !== hash(packet.capability_snapshot_hash, 'capability_snapshot_hash')
    || normalized.validation_manifest_hash !== hash(packet.validation_manifest_hash, 'validation_manifest_hash') || normalized.base_sha !== packet.base_sha) {
    invalid('review packet hash binding is invalid');
  }
  return normalized;
}

export function createBrokerVerdictRecord(input: BrokerVerdictInputV4, packet: BrokerReviewPacketV4): BrokerVerdictRecordV4 {
  if (input.run_id !== packet.run_id || input.packet_hash !== packet.packet_hash) invalid('verdict is bound to a different review packet');
  if (input.verdict !== 'APPROVED' && input.verdict !== 'REJECTED') invalid('verdict is invalid');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.length > 4_000 || input.reason.includes('\u0000')) invalid('verdict reason is invalid');
  const body = {
    schema_version: 4 as const,
    run_id: packet.run_id,
    review_packet_hash: packet.packet_hash,
    contract_hash: packet.contract_hash,
    diff_hash: packet.diff_hash,
    tree_hash: packet.tree_hash,
    capability_snapshot_hash: packet.capability_snapshot_hash,
    verdict: input.verdict,
    reason: input.reason,
  };
  return freeze({ ...body, verdict_hash: hashCanonicalV4(body) });
}
