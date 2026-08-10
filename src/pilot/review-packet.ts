export type ReviewContextRequestV3 = 'VALIDATION_EVIDENCE' | 'BOUNDARY_HASH' | 'USAGE_RECORD';

export interface ReviewPacketInputV3 {
  pilot_id: string;
  block_id: string;
  review_id: string;
  reviewed_attempt_id: string;
  contract_hash: string;
  case_fingerprint: string;
  review_boundary_from_revision: string;
  review_boundary_to_revision: string;
  review_input_diff_hash: string;
  previous_review_boundary_hash: string | null;
  unresolved_finding_ids: readonly string[];
  validation_evidence_hashes: readonly string[];
  bounded_context_requests: readonly { request_type: ReviewContextRequestV3; evidence_hash: string }[];
}

export interface ReviewPacketV3 extends ReviewPacketInputV3 {
  review_boundary_hash: string;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const requestTypes = new Set<ReviewContextRequestV3>(['VALIDATION_EVIDENCE', 'BOUNDARY_HASH', 'USAGE_RECORD']);

function assertIdentifier(value: string, field: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${field} must be a bounded identifier`);
}

function assertHash(value: string, field: string): void {
  if (!hashPattern.test(value)) throw new Error(`${field} must be a SHA-256 hash`);
}

function boundedUnique(values: readonly string[], field: string, validator: (value: string, field: string) => void): string[] {
  if (values.length > 128) throw new Error(`${field} exceeds 128 items`);
  const copy = [...values];
  copy.forEach(value => validator(value, field));
  if (new Set(copy).size !== copy.length) throw new Error(`${field} contains duplicates`);
  return copy;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildReviewPacket(input: ReviewPacketInputV3): ReviewPacketV3 {
  for (const [field, value] of Object.entries({
    pilot_id: input.pilot_id, block_id: input.block_id, review_id: input.review_id,
    reviewed_attempt_id: input.reviewed_attempt_id,
  })) assertIdentifier(value, field);
  for (const [field, value] of Object.entries({
    contract_hash: input.contract_hash, case_fingerprint: input.case_fingerprint,
    review_boundary_from_revision: input.review_boundary_from_revision,
    review_boundary_to_revision: input.review_boundary_to_revision,
    review_input_diff_hash: input.review_input_diff_hash,
  })) assertHash(value, field);
  if (input.previous_review_boundary_hash !== null) assertHash(input.previous_review_boundary_hash, 'previous_review_boundary_hash');
  const unresolved_finding_ids = boundedUnique(input.unresolved_finding_ids, 'unresolved_finding_ids', assertIdentifier);
  const validation_evidence_hashes = boundedUnique(input.validation_evidence_hashes, 'validation_evidence_hashes', assertHash);
  if (input.bounded_context_requests.length > 128) throw new Error('bounded_context_requests exceeds 128 items');
  const bounded_context_requests = input.bounded_context_requests.map((request, index) => {
    if (!requestTypes.has(request.request_type)) throw new Error(`Unsupported bounded context request at ${index}`);
    assertHash(request.evidence_hash, `bounded_context_requests[${index}].evidence_hash`);
    return { request_type: request.request_type, evidence_hash: request.evidence_hash };
  });
  const review_boundary_hash = hashCanonical({
    pilot_id: input.pilot_id, block_id: input.block_id, review_id: input.review_id,
    reviewed_attempt_id: input.reviewed_attempt_id,
    review_boundary_from_revision: input.review_boundary_from_revision,
    review_boundary_to_revision: input.review_boundary_to_revision,
    review_input_diff_hash: input.review_input_diff_hash,
    unresolved_finding_ids, validation_evidence_hashes,
  });
  return deepFreeze({
    pilot_id: input.pilot_id, block_id: input.block_id, review_id: input.review_id,
    reviewed_attempt_id: input.reviewed_attempt_id, contract_hash: input.contract_hash,
    case_fingerprint: input.case_fingerprint, review_boundary_from_revision: input.review_boundary_from_revision,
    review_boundary_to_revision: input.review_boundary_to_revision, review_input_diff_hash: input.review_input_diff_hash,
    previous_review_boundary_hash: input.previous_review_boundary_hash, unresolved_finding_ids,
    validation_evidence_hashes, bounded_context_requests, review_boundary_hash,
  });
}
import { hashCanonical } from './canonical-json.js';
