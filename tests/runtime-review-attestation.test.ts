import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { verifyReviewAttestation } from '../src/runtime/review-attestation.js';

function attestation() {
  const body = {
    review_id: 'review-01',
    reviewer_binding_ref: 'reviewer-binding',
    reviewer_session_id: 'fresh-session',
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    contract_hash: 'a'.repeat(64),
    base_sha: 'b'.repeat(40),
    reviewed_tree_hash: 'c'.repeat(64),
    reviewed_diff_hash: 'd'.repeat(64),
    validation_manifest_hash: 'e'.repeat(64),
    decision: 'ACCEPT' as const,
    findings: [],
    requested_context_hashes: [],
    unresolved_finding_ids: [],
    created_at: '2026-08-10T10:00:00.000Z',
  };
  return { ...body, attestation_hash: hashCanonicalV4(body) };
}

test('accepts only a fresh hash-correct attestation for the exact evidence', () => {
  const current = {
    contract_hash: 'a'.repeat(64),
    base_sha: 'b'.repeat(40),
    tree_hash: 'c'.repeat(64),
    diff_hash: 'd'.repeat(64),
    validation_manifest_hash: 'e'.repeat(64),
    allowed_session_id: 'fresh-session',
    prior_session_ids: ['executor-session'],
  };
  assert.equal(verifyReviewAttestation({ attestation: attestation(), current }).decision, 'ACCEPT');
  assert.throws(
    () => verifyReviewAttestation({ attestation: { ...attestation(), reviewed_tree_hash: 'f'.repeat(64) }, current }),
    /REVIEW_ATTESTATION_INVALID/,
  );
  assert.throws(
    () =>
      verifyReviewAttestation({
        attestation: { ...attestation(), reviewer_session_id: 'executor-session' },
        current: { ...current, allowed_session_id: 'executor-session' },
      }),
    /REVIEW_ATTESTATION_INVALID/,
  );
});
