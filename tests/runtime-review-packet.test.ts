import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { buildReviewEnvelope } from '../src/runtime/review-envelope.js';
import { buildBrokerReviewPacket, createBrokerVerdictRecord, loadBrokerReviewPacketV4 } from '../src/runtime/review-packet.js';
import { validRuntimeResult, validWorkContract } from './runtime-contracts.test.js';

function contract() {
  const { contract_hash: _ignored, ...body } = validWorkContract();
  return { ...body, contract_hash: hashCanonicalV4(body) };
}

test('builds and reloads a review packet bound to deterministic evidence', () => {
  const workContract = contract();
  const result = {
    ...validRuntimeResult(),
    state: 'REVIEW_ACCEPTED',
    contract_hash: workContract.contract_hash,
    diff_hash: 'c'.repeat(64),
    tree_hash: 'd'.repeat(64),
    changed_files: ['src/greeting.ts'],
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: 'e'.repeat(64) }],
  } as any;
  const envelope = buildReviewEnvelope({
    contract: workContract as any,
    complete_diff: 'diff --git a/src/greeting.ts b/src/greeting.ts\n',
    changed_files: ['src/greeting.ts'],
    capability_snapshot_hash: 'a'.repeat(64),
    diff_hash: result.diff_hash,
    tree_hash: result.tree_hash,
    validation_results: [{ validation_id: 'test', passed: true, result_hash: 'e'.repeat(64), validated_tree_hash: result.tree_hash }],
    unresolved_findings: [],
  });
  const packet = buildBrokerReviewPacket({ result, envelope });
  assert.equal(packet.packet_hash.length, 64);
  assert.equal(packet.capability_snapshot_hash, 'a'.repeat(64));
  assert.deepEqual(loadBrokerReviewPacketV4(packet), packet);
  const verdict = createBrokerVerdictRecord(
    { run_id: packet.run_id, packet_hash: packet.packet_hash, verdict: 'APPROVED', reason: 'The deterministic evidence is complete.' },
    packet,
  );
  assert.equal(verdict.review_packet_hash, packet.packet_hash);
  assert.equal(verdict.capability_snapshot_hash, packet.capability_snapshot_hash);
  assert.equal(verdict.verdict_hash.length, 64);
});

test('refuses packets with unresolved findings or forged evidence bindings', () => {
  const workContract = contract();
  const result = {
    ...validRuntimeResult(),
    state: 'REVIEW_ACCEPTED',
    contract_hash: workContract.contract_hash,
    diff_hash: 'c'.repeat(64),
    tree_hash: 'd'.repeat(64),
    changed_files: ['src/greeting.ts'],
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: 'e'.repeat(64) }],
  } as any;
  const envelope = buildReviewEnvelope({
    contract: workContract as any,
    complete_diff: 'diff',
    changed_files: ['src/greeting.ts'],
    capability_snapshot_hash: 'a'.repeat(64),
    diff_hash: result.diff_hash,
    tree_hash: result.tree_hash,
    validation_results: [{ validation_id: 'test', passed: true, result_hash: 'e'.repeat(64), validated_tree_hash: result.tree_hash }],
    unresolved_findings: [{ id: 'finding-1', severity: 'high', message: 'repair required' }],
  });
  assert.throws(() => buildBrokerReviewPacket({ result, envelope }), /REVIEW_PACKET_UNAVAILABLE/);
  const cleanEnvelope = buildReviewEnvelope({
    contract: workContract as any,
    complete_diff: 'diff',
    changed_files: ['src/greeting.ts'],
    capability_snapshot_hash: 'a'.repeat(64),
    diff_hash: result.diff_hash,
    tree_hash: result.tree_hash,
    validation_results: [{ validation_id: 'test', passed: true, result_hash: 'e'.repeat(64), validated_tree_hash: result.tree_hash }],
    unresolved_findings: [],
  });
  assert.throws(
    () => buildBrokerReviewPacket({ result: { ...result, tree_hash: 'f'.repeat(64) }, envelope: cleanEnvelope }),
    /REVIEW_PACKET_INVALID/,
  );
  assert.throws(
    () =>
      buildBrokerReviewPacket({
        result: { ...result, validation_results: [{ validation_id: 'lint', exit_code: 1, result_hash: 'e'.repeat(64) }] },
        envelope: cleanEnvelope,
      }),
    /REVIEW_PACKET_INVALID/,
  );
});
