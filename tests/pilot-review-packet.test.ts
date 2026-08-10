import assert from 'node:assert/strict';
import test from 'node:test';

import { buildReviewPacket, type ReviewPacketInputV3 } from '../src/pilot/review-packet.js';

const hash = (character: string) => character.repeat(64);

function input(): ReviewPacketInputV3 {
  return {
    pilot_id: 'pilot-v3', block_id: 'block-a', review_id: 'review-2', reviewed_attempt_id: 'attempt-2',
    contract_hash: hash('a'), case_fingerprint: hash('b'), review_boundary_from_revision: hash('c'),
    review_boundary_to_revision: hash('d'), review_input_diff_hash: hash('e'), previous_review_boundary_hash: hash('f'),
    unresolved_finding_ids: ['finding-1'], validation_evidence_hashes: [hash('1')],
    bounded_context_requests: [{ request_type: 'VALIDATION_EVIDENCE', evidence_hash: hash('2') }],
  };
}

test('buildReviewPacket emits only the bounded incremental evidence envelope and a canonical boundary hash', () => {
  const packet = buildReviewPacket({ ...input(), unexpected_raw_content: 'must-not-leak' } as ReviewPacketInputV3);
  assert.deepEqual(Object.keys(packet).sort(), [
    'block_id', 'bounded_context_requests', 'case_fingerprint', 'contract_hash', 'pilot_id',
    'previous_review_boundary_hash', 'review_boundary_from_revision', 'review_boundary_hash',
    'review_boundary_to_revision', 'review_id', 'review_input_diff_hash', 'reviewed_attempt_id',
    'unresolved_finding_ids', 'validation_evidence_hashes',
  ]);
  assert.equal(packet.review_boundary_hash, '85a79f8a441960d3894f5e69c96b9229d97bfef3516bb134dfedeae9072002ec');
  assert.deepEqual(packet.unresolved_finding_ids, ['finding-1']);
  assert.deepEqual(packet.validation_evidence_hashes, [hash('1')]);
  assert.deepEqual(packet.bounded_context_requests, [{ request_type: 'VALIDATION_EVIDENCE', evidence_hash: hash('2') }]);
});

test('buildReviewPacket rejects malformed hashes, unbounded collections, duplicate findings, and unsupported context requests', () => {
  const cases: Array<[string, ReviewPacketInputV3]> = [
    ['malformed hash', { ...input(), contract_hash: 'not-a-hash' }],
    ['too many findings', { ...input(), unresolved_finding_ids: Array.from({ length: 129 }, (_, index) => `finding-${index}`) }],
    ['duplicate finding', { ...input(), unresolved_finding_ids: ['finding-1', 'finding-1'] }],
    ['unsupported request', { ...input(), bounded_context_requests: [{ request_type: 'RAW_DIFF' as 'VALIDATION_EVIDENCE', evidence_hash: hash('2') }] }],
  ];
  for (const [name, value] of cases) assert.throws(() => buildReviewPacket(value), name);
});

test('buildReviewPacket owns immutable copies of caller arrays', () => {
  const source = input();
  const packet = buildReviewPacket(source);
  (source.unresolved_finding_ids as string[]).push('finding-2');
  assert.deepEqual(packet.unresolved_finding_ids, ['finding-1']);
  assert.ok(Object.isFrozen(packet));
});
