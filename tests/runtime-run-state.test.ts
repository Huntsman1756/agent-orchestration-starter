import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { createJournalV4 } from '../src/runtime/journal.js';
import {
  initialBrokerStateV4,
  recoverBrokerStateV4,
  reduceBrokerStateV4,
  writeBrokerStateCacheV4,
  type BrokerCommandV4,
} from '../src/runtime/run-state.js';
import { validRuntimeResult, validWorkContract } from './runtime-contracts.test.js';

function accepted(): Extract<BrokerCommandV4, { type: 'RUN_ACCEPTED' }> {
  return {
    type: 'RUN_ACCEPTED',
    command_id: 'command-accepted',
    request_hash: 'a'.repeat(64),
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    contract: validWorkContract(),
    result: { ...validRuntimeResult(), state: 'READY_FOR_EXECUTOR', attempts: [], validation_results: [], head_sha: null, review_attestation_hash: null, commit_sha: null },
    inspection_epoch: 1,
  } as Extract<BrokerCommandV4, { type: 'RUN_ACCEPTED' }>;
}

test('pure replay requires reinspection after an executor attempt', () => {
  const acceptedCommand = accepted();
  const ready = reduceBrokerStateV4(initialBrokerStateV4(), acceptedCommand);
  const executing = reduceBrokerStateV4(ready, {
    type: 'EXTERNAL_PROCESS_STARTED',
    command_id: 'command-started',
    run_id: acceptedCommand.run_id,
    process: { pid: 4242, boot_nonce: 'process-boot' },
  });
  const waiting = reduceBrokerStateV4(executing, {
    type: 'ATTEMPT_RECORDED',
    command_id: 'command-attempt',
    run_id: acceptedCommand.run_id,
    attempt: { attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: 'b'.repeat(64) },
  });

  assert.equal(waiting.runs[acceptedCommand.run_id].result.state, 'AWAITING_REINSPECTION');
  assert.equal(waiting.runs[acceptedCommand.run_id].inspection_required, true);

  const readyAgain = reduceBrokerStateV4(waiting, {
    type: 'PATHS_REINSPECTED',
    command_id: 'command-reinspected',
    run_id: acceptedCommand.run_id,
    inspection_epoch: 2,
  });
  assert.equal(readyAgain.runs[acceptedCommand.run_id].result.state, 'READY_FOR_EXECUTOR');
  assert.equal(readyAgain.runs[acceptedCommand.run_id].inspection_required, false);
});

test('durably reaches review acceptance only from exact post-reinspection evidence', () => {
  const acceptedCommand = accepted();
  const ready = reduceBrokerStateV4(initialBrokerStateV4(), acceptedCommand);
  const executing = reduceBrokerStateV4(ready, { type: 'EXTERNAL_PROCESS_STARTED', command_id: 'started', run_id: acceptedCommand.run_id, process: { pid: 42, boot_nonce: 'process-boot' } });
  const waiting = reduceBrokerStateV4(executing, { type: 'ATTEMPT_RECORDED', command_id: 'attempt', run_id: acceptedCommand.run_id, attempt: { attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: 'b'.repeat(64) } });
  const reinspected = reduceBrokerStateV4(waiting, { type: 'PATHS_REINSPECTED', command_id: 'reinspect', run_id: acceptedCommand.run_id, inspection_epoch: 2 });
  const evidence = {
    type: 'CANDIDATE_ACCEPTED' as const,
    command_id: 'candidate-accepted',
    run_id: acceptedCommand.run_id,
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: 'c'.repeat(64) }],
    diff_hash: 'd'.repeat(64),
    tree_hash: 'e'.repeat(64),
    changed_files: ['src/greeting.ts'],
    review_attestation_hash: 'f'.repeat(64),
  };
  const reviewed = reduceBrokerStateV4(reinspected, evidence);
  assert.equal(reviewed.runs[acceptedCommand.run_id].result.state, 'REVIEW_ACCEPTED');
  assert.deepEqual(reviewed.runs[acceptedCommand.run_id].result.validation_results, evidence.validation_results);
  assert.throws(() => reduceBrokerStateV4(ready, evidence), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(reinspected, { ...evidence, validation_results: [] }), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(reinspected, { ...evidence, changed_files: ['outside.ts'] }), /BROKER_STATE_CORRUPT/);
});

test('records a hash-bound frontier verdict without turning approval into publication', () => {
  const acceptedCommand = accepted();
  const ready = reduceBrokerStateV4(initialBrokerStateV4(), acceptedCommand);
  const executing = reduceBrokerStateV4(ready, { type: 'EXTERNAL_PROCESS_STARTED', command_id: 'started-for-verdict', run_id: acceptedCommand.run_id, process: { pid: 43, boot_nonce: 'process-boot' } });
  const waiting = reduceBrokerStateV4(executing, { type: 'ATTEMPT_RECORDED', command_id: 'attempt-for-verdict', run_id: acceptedCommand.run_id, attempt: { attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: 'b'.repeat(64) } });
  const reinspected = reduceBrokerStateV4(waiting, { type: 'PATHS_REINSPECTED', command_id: 'reinspect-for-verdict', run_id: acceptedCommand.run_id, inspection_epoch: 2 });
  const reviewed = reduceBrokerStateV4(reinspected, {
    type: 'CANDIDATE_ACCEPTED',
    command_id: 'candidate-accepted',
    run_id: acceptedCommand.run_id,
    validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: 'c'.repeat(64) }],
    diff_hash: 'd'.repeat(64),
    tree_hash: 'e'.repeat(64),
    changed_files: ['src/greeting.ts'],
    review_attestation_hash: 'f'.repeat(64),
  });
  const verdictBody = { schema_version: 4, run_id: acceptedCommand.run_id, review_packet_hash: '1'.repeat(64), contract_hash: acceptedCommand.contract.contract_hash, diff_hash: reviewed.runs[acceptedCommand.run_id].result.diff_hash, tree_hash: reviewed.runs[acceptedCommand.run_id].result.tree_hash, capability_snapshot_hash: 'a'.repeat(64), verdict: 'APPROVED' as const, reason: 'Independent review passed.' };
  const verdict: Extract<BrokerCommandV4, { type: 'REVIEW_VERDICT_RECORDED' }> = {
    type: 'REVIEW_VERDICT_RECORDED',
    command_id: 'verdict-approved',
    run_id: acceptedCommand.run_id,
    review_packet_hash: verdictBody.review_packet_hash,
    contract_hash: verdictBody.contract_hash,
    diff_hash: verdictBody.diff_hash,
    tree_hash: verdictBody.tree_hash,
    capability_snapshot_hash: verdictBody.capability_snapshot_hash,
    verdict: verdictBody.verdict,
    reason: verdictBody.reason,
    verdict_hash: hashCanonicalV4(verdictBody),
  };
  const approved = reduceBrokerStateV4(reviewed, verdict);
  assert.equal(approved.runs[acceptedCommand.run_id].result.state, 'REVIEW_ACCEPTED');
  assert.equal(approved.runs[acceptedCommand.run_id].review_verdict?.verdict, 'APPROVED');
  assert.equal(approved.runs[acceptedCommand.run_id].review_verdict?.capability_snapshot_hash, verdictBody.capability_snapshot_hash);
  assert.throws(() => reduceBrokerStateV4(approved, { ...verdict, command_id: 'verdict-replayed', verdict: 'REJECTED', verdict_hash: hashCanonicalV4({ ...verdictBody, verdict: 'REJECTED' }) }), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(reviewed, { ...verdict, command_id: 'verdict-forged', diff_hash: '4'.repeat(64) }), /BROKER_STATE_CORRUPT/);
});

test('records authenticated abort as a distinct terminal transition', () => {
  const acceptedCommand = accepted();
  const ready = reduceBrokerStateV4(initialBrokerStateV4(), acceptedCommand);
  const aborted = reduceBrokerStateV4(ready, { type: 'RUN_ABORTED', command_id: 'abort', run_id: acceptedCommand.run_id, failure: { code: 'ABORTED', message: 'ABORTED: authenticated control', retryable: false, evidence_hashes: [] } });
  assert.equal(aborted.runs[acceptedCommand.run_id].result.state, 'ABORTED');
  assert.equal(aborted.runs[acceptedCommand.run_id].result.failure?.code, 'ABORTED');
  assert.throws(() => reduceBrokerStateV4(ready, { type: 'RUN_ABORTED', command_id: 'abort', run_id: acceptedCommand.run_id, failure: { code: 'UNKNOWN_FAILURE', message: 'wrong', retryable: false, evidence_hashes: [] } }), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(aborted, { type: 'RUN_ABORTED', command_id: 'abort-again', run_id: acceptedCommand.run_id, failure: { code: 'ABORTED', message: 'ABORTED: again', retryable: false, evidence_hashes: [] } }), /BROKER_STATE_CORRUPT/);
});

test('rejects every lifecycle transition that bypasses execution, reinspection, or terminal gates', () => {
  const acceptedCommand = accepted();
  const ready = reduceBrokerStateV4(initialBrokerStateV4(), acceptedCommand);
  const startedCommand: BrokerCommandV4 = { type: 'EXTERNAL_PROCESS_STARTED', command_id: 'started', run_id: acceptedCommand.run_id, process: { pid: 42, boot_nonce: 'process-boot' } };
  const attemptCommand: BrokerCommandV4 = { type: 'ATTEMPT_RECORDED', command_id: 'attempt', run_id: acceptedCommand.run_id, attempt: { attempt: 1, executor_binding_ref: 'fixture-executor', result_hash: 'b'.repeat(64) } };
  const reinspectCommand: BrokerCommandV4 = { type: 'PATHS_REINSPECTED', command_id: 'reinspect', run_id: acceptedCommand.run_id, inspection_epoch: 2 };

  assert.throws(() => reduceBrokerStateV4(ready, attemptCommand), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(ready, reinspectCommand), /BROKER_STATE_CORRUPT/);
  const executing = reduceBrokerStateV4(ready, startedCommand);
  assert.throws(() => reduceBrokerStateV4(executing, startedCommand), /BROKER_STATE_CORRUPT/);
  const waiting = reduceBrokerStateV4(executing, attemptCommand);
  assert.throws(() => reduceBrokerStateV4(waiting, startedCommand), /BROKER_STATE_CORRUPT/);
  const failed = reduceBrokerStateV4(executing, { type: 'RUN_FAILED', command_id: 'failed', run_id: acceptedCommand.run_id, failure: { code: 'UNKNOWN_FAILURE', message: 'indeterminate', retryable: false, evidence_hashes: [] } });
  for (const command of [startedCommand, attemptCommand, reinspectCommand, { type: 'RUN_FAILED', command_id: 'failed-again', run_id: acceptedCommand.run_id, failure: { code: 'UNKNOWN_FAILURE', message: 'again', retryable: false, evidence_hashes: [] } } as const]) {
    assert.throws(() => reduceBrokerStateV4(failed, command), /BROKER_STATE_CORRUPT/);
  }
});

test('publication is durable from the accepted commit through the verified merge', () => {
  const acceptedCommand = accepted();
  const reviewedCommand: Extract<BrokerCommandV4, { type: 'RUN_ACCEPTED' }> = { ...acceptedCommand, result: {
    ...validRuntimeResult(),
    state: 'REVIEW_ACCEPTED',
    branch: `codex/auto/${acceptedCommand.run_id}`,
    head_sha: null,
    commit_sha: null,
  } as typeof acceptedCommand.result };
  const reviewed = reduceBrokerStateV4(initialBrokerStateV4(), reviewedCommand);
  const command: Extract<BrokerCommandV4, { type: 'COMMIT_CREATED' }> = {
    type: 'COMMIT_CREATED', command_id: 'commit-created', run_id: acceptedCommand.run_id,
    task_ref: `refs/heads/codex/auto/${reviewedCommand.run_id}`,
    base_sha: reviewedCommand.contract.base_sha,
    git_tree_sha: 'c'.repeat(40), evidence_tree_hash: reviewedCommand.result.tree_hash,
    commit_sha: 'd'.repeat(40), contract_hash: reviewedCommand.contract.contract_hash,
    diff_hash: reviewedCommand.result.diff_hash, validation_manifest_hash: 'e'.repeat(64),
    review_attestation_hash: reviewedCommand.result.review_attestation_hash!,
  };
  const committed = reduceBrokerStateV4(reviewed, command);
  assert.equal(committed.runs[reviewedCommand.run_id].result.state, 'READY_FOR_PUBLICATION');
  assert.equal(committed.runs[reviewedCommand.run_id].result.commit_sha, command.commit_sha);
  const pushed = reduceBrokerStateV4(committed, { type: 'BRANCH_PUSHED', command_id: 'branch-pushed', run_id: command.run_id, commit_sha: command.commit_sha, branch: reviewedCommand.result.branch, remote: 'origin', publication_policy_hash: reviewedCommand.contract.policy_hash });
  assert.equal(pushed.runs[command.run_id].result.state, 'PUBLICATION_PUSHED');
  const prUrl = 'https://github.com/acme/repo/pull/17';
  const opened = reduceBrokerStateV4(pushed, { type: 'PULL_REQUEST_RECORDED', command_id: 'pr-recorded', run_id: command.run_id, commit_sha: command.commit_sha, pull_request: 17, pull_request_url: prUrl, base_branch: 'main', publication_policy_hash: reviewedCommand.contract.policy_hash });
  assert.equal(opened.runs[command.run_id].result.publication.pull_request, 17);
  const checked = reduceBrokerStateV4(opened, { type: 'REQUIRED_CHECKS_PASSED', command_id: 'checks-passed', run_id: command.run_id, commit_sha: command.commit_sha, pull_request: 17, publication_policy_hash: reviewedCommand.contract.policy_hash });
  const merged = reduceBrokerStateV4(checked, { type: 'RUN_MERGED', command_id: 'run-merged', run_id: command.run_id, commit_sha: command.commit_sha, pull_request: 17, pull_request_url: prUrl, merge_commit_sha: 'f'.repeat(40), publication_policy_hash: reviewedCommand.contract.policy_hash });
  assert.equal(merged.runs[command.run_id].result.state, 'FINALIZED');
  assert.equal(merged.runs[command.run_id].result.publication.state, 'MERGED');
  assert.equal(merged.runs[command.run_id].result.head_sha, 'f'.repeat(40));
  assert.throws(() => reduceBrokerStateV4(reviewed, { ...command, evidence_tree_hash: '0'.repeat(64) }), /BROKER_STATE_CORRUPT/);
  assert.throws(() => reduceBrokerStateV4(pushed, { type: 'RUN_MERGED', command_id: 'early-merge', run_id: command.run_id, commit_sha: command.commit_sha, pull_request: 17, pull_request_url: prUrl, merge_commit_sha: 'f'.repeat(40), publication_policy_hash: reviewedCommand.contract.policy_hash }), /BROKER_STATE_CORRUPT/);
});

test('rejects an atomic cache snapshot that disagrees with journal replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-state-'));
  const journal = await createJournalV4(directory);
  await journal.append(accepted());
  await journal.close();
  await writeFile(join(directory, 'current-state.v4.json'), JSON.stringify({ sequence: 1, state_hash: '0'.repeat(64), state: initialBrokerStateV4() }));

  await assert.rejects(() => recoverBrokerStateV4(directory), /BROKER_STATE_CORRUPT/);
});

test('rebuilds a missing cache from the journal and then verifies it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-state-'));
  const journal = await createJournalV4(directory);
  await journal.append(accepted());
  await journal.close();

  const first = await recoverBrokerStateV4(directory);
  await writeBrokerStateCacheV4(directory, first.state, first.sequence);
  const second = await recoverBrokerStateV4(directory);

  assert.deepEqual(second, first);
});

test('accepts and atomically rebuilds a cache that is a verified journal prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-state-prefix-'));
  await writeBrokerStateCacheV4(directory, initialBrokerStateV4(), 0);
  const journal = await createJournalV4(directory);
  await journal.append(accepted());
  await journal.close();

  const recovered = await recoverBrokerStateV4(directory);

  assert.equal(recovered.sequence, 1);
  assert.equal(recovered.state.runs['run_01HZX3YH8C7Y9QJ4J6M2G5K8N1'].result.state, 'READY_FOR_EXECUTOR');
  const verified = await recoverBrokerStateV4(directory);
  assert.deepEqual(verified, recovered);
});

test('rejects a cache sequence ahead of the durable journal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-state-ahead-'));
  const journal = await createJournalV4(directory);
  await journal.append(accepted());
  await journal.close();
  await writeBrokerStateCacheV4(directory, reduceBrokerStateV4(initialBrokerStateV4(), accepted()), 2);

  await assert.rejects(() => recoverBrokerStateV4(directory), /BROKER_STATE_CORRUPT/);
});

test('propagates a directory fsync failure after atomic cache rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-state-fsync-'));
  const writeWithDurability = writeBrokerStateCacheV4 as unknown as (
    directory: string,
    state: ReturnType<typeof initialBrokerStateV4>,
    sequence: number,
    durability: { syncDirectory: (directory: string) => Promise<void> },
  ) => Promise<void>;
  const fsyncError = Object.assign(new Error('directory fsync denied'), { code: 'EIO' });

  await assert.rejects(
    () => writeWithDurability(directory, initialBrokerStateV4(), 0, { syncDirectory: async () => { throw fsyncError; } }),
    /directory fsync denied/,
  );
});
