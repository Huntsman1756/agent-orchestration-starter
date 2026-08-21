import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';

import { appendJournalRecord, createJournalV4, reopenJournalV4, type JournalRecordV4 } from '../src/runtime/journal.js';
import type { FileHandle } from 'node:fs/promises';
import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { BrokerCommandV4 } from '../src/runtime/run-state.js';
import type { RuntimeResultV4, RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { validRuntimeResult, validWorkContract } from './runtime-contracts.test.js';

function accepted(commandId: string, runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1'): Extract<BrokerCommandV4, { type: 'RUN_ACCEPTED' }> {
  const contract = { ...validWorkContract(), run_id: runId } as RuntimeWorkContractV4;
  const result = {
    ...validRuntimeResult(),
    run_id: runId,
    state: 'READY_FOR_EXECUTOR',
    attempts: [],
    validation_results: [],
    head_sha: null,
    review_attestation_hash: null,
    commit_sha: null,
  } as RuntimeResultV4;
  return {
    type: 'RUN_ACCEPTED',
    command_id: commandId,
    request_hash: 'a'.repeat(64),
    run_id: runId,
    contract,
    result,
    inspection_epoch: 1,
  };
}

async function fixtureDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'runner-v4-journal-'));
}

test('reopens two fsynced commands in their original order', async () => {
  const directory = await fixtureDirectory();
  const commandA = accepted('command-a');
  const commandB: BrokerCommandV4 = { type: 'PATHS_REINSPECTED', command_id: 'command-b', run_id: commandA.run_id, inspection_epoch: 2 };
  const journal = await createJournalV4(directory);
  await journal.append(commandA);
  await journal.append(commandB);
  await journal.close();

  const recovered = await reopenJournalV4(directory);

  assert.deepEqual(
    recovered.records.map((record) => record.command),
    [commandA, commandB],
  );
  await recovered.close();
});

test('rejects a partial trailing record instead of repairing it', async () => {
  const directory = await fixtureDirectory();
  const journal = await createJournalV4(directory);
  await journal.append(accepted('command-a'));
  await journal.close();
  await writeFile(join(directory, 'journal.v4.ndjson'), '{"sequence":2', { flag: 'a' });

  await assert.rejects(() => reopenJournalV4(directory), /BROKER_STATE_CORRUPT/);
});

for (const [name, mutate] of [
  [
    'wrong sequence',
    (record: Record<string, unknown>) => {
      record.sequence = 9;
    },
  ],
  [
    'broken previous hash',
    (record: Record<string, unknown>) => {
      record.previous_hash = 'f'.repeat(64);
    },
  ],
  [
    'wrong record hash',
    (record: Record<string, unknown>) => {
      record.record_hash = 'e'.repeat(64);
    },
  ],
] as const) {
  test(`rejects ${name} as broker-state corruption`, async () => {
    const directory = await fixtureDirectory();
    const journal = await createJournalV4(directory);
    await journal.append(accepted('command-a'));
    await journal.append({
      type: 'PATHS_REINSPECTED',
      command_id: 'command-b',
      run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
      inspection_epoch: 2,
    });
    await journal.close();
    const path = join(directory, 'journal.v4.ndjson');
    const lines = (await readFile(path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    mutate(lines[1]);
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

    await assert.rejects(() => reopenJournalV4(directory), /BROKER_STATE_CORRUPT/);
  });
}

test('rejects a duplicate command ID whose canonical bytes differ', async () => {
  const directory = await fixtureDirectory();
  const journal = await createJournalV4(directory);
  await journal.append(accepted('same-command'));
  await journal.close();
  const path = join(directory, 'journal.v4.ndjson');
  const firstLine = (await readFile(path, 'utf8')).trimEnd();
  const first = JSON.parse(firstLine) as { record_hash: string };
  const draft = {
    sequence: 2,
    previous_hash: first.record_hash,
    command: { type: 'PATHS_REINSPECTED', command_id: 'same-command', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', inspection_epoch: 2 },
    recorded_at: '2026-08-08T12:00:00.000Z',
  };
  await writeFile(path, `${firstLine}\n${canonicalJsonV4({ ...draft, record_hash: hashCanonicalV4(draft) })}\n`);

  await assert.rejects(() => reopenJournalV4(directory), /BROKER_STATE_CORRUPT/);
});

test('rejects a correctly hashed but unknown journal command', async () => {
  const directory = await fixtureDirectory();
  const draft = {
    sequence: 1,
    previous_hash: null,
    command: { type: 'RUN_SHELL', command_id: 'unknown-command', argv: ['whoami'] },
    recorded_at: '2026-08-08T12:00:00.000Z',
  };
  await writeFile(join(directory, 'journal.v4.ndjson'), `${canonicalJsonV4({ ...draft, record_hash: hashCanonicalV4(draft) })}\n`);

  await assert.rejects(() => reopenJournalV4(directory), /BROKER_STATE_CORRUPT/);
});

test('refuses a caller command before it can corrupt the durable journal', async () => {
  const directory = await fixtureDirectory();
  const journal = await createJournalV4(directory);

  await assert.rejects(
    () => journal.append({ type: 'RUN_CODING_TASK', command_id: 'caller-command', request: {} as never }),
    /BROKER_STATE_CORRUPT/,
  );

  assert.equal(journal.records.length, 0);
  await journal.close();
});

test('loops over short writes before fsyncing a journal record', async () => {
  const command = accepted('short-write');
  const draft = { sequence: 1, previous_hash: null, command, recorded_at: '2026-08-08T12:00:00.000Z' };
  const record = { ...draft, record_hash: hashCanonicalV4(draft) } as JournalRecordV4;
  const expected = Buffer.from(`${canonicalJsonV4(record)}\n`, 'utf8');
  let written = Buffer.alloc(0);
  let synced = false;
  const file = {
    write: async (data: string | Uint8Array, offset = 0, length?: number) => {
      const source =
        typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : Buffer.from(data).subarray(offset, length === undefined ? undefined : offset + length);
      const chunk = source.subarray(0, Math.max(1, Math.floor(source.length / 2)));
      written = Buffer.concat([written, chunk]);
      return { bytesWritten: chunk.length, buffer: data };
    },
    sync: async () => {
      synced = true;
    },
  } as unknown as FileHandle;

  await appendJournalRecord(file, record);

  assert.deepEqual(written, expected);
  assert.equal(synced, true);
});
