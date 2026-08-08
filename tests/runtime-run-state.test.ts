import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
  const waiting = reduceBrokerStateV4(ready, {
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
