import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { type BrokerDaemonV4 } from '../src/runtime/broker-daemon.js';
import { composeRuntimeHostControlV4, type RuntimeHostOperationsV4 } from '../src/runtime/host-composition.js';
import { buildReviewEnvelope } from '../src/runtime/review-envelope.js';
import { buildBrokerReviewPacket } from '../src/runtime/review-packet.js';
import { validRuntimeResult, validWorkContract } from './runtime-contracts.test.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';

function fixture() {
  const { contract_hash: _ignored, ...contractBody } = validWorkContract();
  const contract = { ...contractBody, contract_hash: hashCanonicalV4(contractBody) } as any;
  const result = {
    ...validRuntimeResult(),
    run_id: runId,
    state: 'REVIEW_ACCEPTED',
    contract_hash: contract.contract_hash,
    diff_hash: 'c'.repeat(64),
    tree_hash: 'd'.repeat(64),
    changed_files: ['src/greeting.ts'],
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: 'e'.repeat(64) }],
  } as any;
  const envelope = buildReviewEnvelope({
    contract,
    complete_diff: 'diff --git a/src/greeting.ts b/src/greeting.ts\n',
    changed_files: result.changed_files,
    capability_snapshot_hash: 'a'.repeat(64),
    diff_hash: result.diff_hash,
    tree_hash: result.tree_hash,
    validation_results: [{ validation_id: 'test', passed: true, result_hash: 'e'.repeat(64), validated_tree_hash: result.tree_hash }],
    unresolved_findings: [],
  });
  const packet = buildBrokerReviewPacket({ result, envelope });
  const verdicts: unknown[] = [];
  const daemon: BrokerDaemonV4 = {
    submit: async () => ({
      request_id: result.request_id,
      run_id: runId,
      state: result.state,
      status_token: hashCanonicalV4({ run_id: runId, state: result.state, artifact_manifest_hash: result.artifact_manifest_hash }),
    }),
    status: async () => result,
    recover: async () => undefined,
    close: async () => undefined,
    recordAttempt: async () => undefined,
    reinspect: async () => undefined,
    recordExternalProcessStarted: async () => undefined,
    recordAcceptedCandidate: async () => undefined,
    recordFailure: async () => undefined,
    recordAbort: async () => undefined,
    recordReviewVerdict: async (_id, verdict) => {
      verdicts.push(verdict);
    },
  };
  return { daemon, packet, verdicts };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('APPROVED records only the bound verdict while REJECTED enters the existing repair operation', async () => {
  for (const verdict of ['APPROVED', 'REJECTED'] as const) {
    const state = fixture();
    const calls: string[] = [];
    const operations: RuntimeHostOperationsV4 = {
      advance: async () => {
        calls.push('advance');
      },
      prepareRepair: async (input) => {
        calls.push(`repair:${input.findings[0]!.evidence_hash}`);
      },
      finalize: async () => {
        calls.push('finalize');
      },
      stopExternal: async () => undefined,
      getReviewPacket: async () => state.packet,
    };
    const host = composeRuntimeHostControlV4(state.daemon, operations);
    await host.controlPlane.submitVerdict!({
      command_id: `verdict-${verdict.toLowerCase()}`,
      run_id: runId,
      packet_hash: state.packet.packet_hash,
      verdict,
      reason: `review ${verdict.toLowerCase()}`,
    });
    await settle();
    assert.equal(state.verdicts.length, 1);
    assert.equal(
      calls.some((call) => call.startsWith('repair:')),
      verdict === 'REJECTED',
    );
    assert.equal(calls.includes('finalize'), false);
    await host.close();
  }
});
