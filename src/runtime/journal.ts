import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import { loadJournalCommandV4, type BrokerCommandV4 } from './run-state.js';

export const JOURNAL_FILE_V4 = 'journal.v4.ndjson';

export interface JournalRecordV4 {
  sequence: number;
  previous_hash: string | null;
  command: BrokerCommandV4;
  recorded_at: string;
  record_hash: string;
}

export interface JournalV4 {
  readonly records: readonly JournalRecordV4[];
  append(command: BrokerCommandV4): Promise<JournalRecordV4>;
  close(): Promise<void>;
}

function corrupt(message: string): never {
  throw new Error(`BROKER_STATE_CORRUPT: ${message}`);
}

function isRecord(value: unknown): value is JournalRecordV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'command,previous_hash,record_hash,recorded_at,sequence') return false;
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1) return false;
  if (candidate.previous_hash !== null && (typeof candidate.previous_hash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.previous_hash)))
    return false;
  if (typeof candidate.recorded_at !== 'string' || Number.isNaN(Date.parse(candidate.recorded_at))) return false;
  if (typeof candidate.record_hash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.record_hash)) return false;
  if (candidate.command === null || typeof candidate.command !== 'object' || Array.isArray(candidate.command)) return false;
  const command = candidate.command as Record<string, unknown>;
  return typeof command.type === 'string' && typeof command.command_id === 'string' && command.command_id.length > 0;
}

function recordDraft(record: JournalRecordV4): Omit<JournalRecordV4, 'record_hash'> {
  return {
    sequence: record.sequence,
    previous_hash: record.previous_hash,
    command: record.command,
    recorded_at: record.recorded_at,
  };
}

function parseRecords(bytes: string): JournalRecordV4[] {
  if (bytes.length === 0) return [];
  if (!bytes.endsWith('\n')) corrupt('journal has a partial trailing record');
  const records: JournalRecordV4[] = [];
  const commandBytes = new Map<string, string>();
  for (const [index, line] of bytes.slice(0, -1).split('\n').entries()) {
    if (line.length === 0) corrupt(`journal record ${index + 1} is empty`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt(`journal record ${index + 1} is not valid JSON`);
    }
    if (!isRecord(parsed)) corrupt(`journal record ${index + 1} has invalid bytes`);
    if (canonicalJsonV4(parsed) !== line) corrupt(`journal record ${index + 1} is not canonical JSON`);
    const record = parsed;
    loadJournalCommandV4(record.command);
    const expectedSequence = index + 1;
    const expectedPrevious = records.at(-1)?.record_hash ?? null;
    if (record.sequence !== expectedSequence) corrupt(`journal sequence ${record.sequence} does not follow ${index}`);
    if (record.previous_hash !== expectedPrevious) corrupt(`journal previous hash is broken at sequence ${record.sequence}`);
    if (hashCanonicalV4(recordDraft(record)) !== record.record_hash)
      corrupt(`journal record hash is broken at sequence ${record.sequence}`);
    const bytesForCommand = canonicalJsonV4(record.command);
    const previousCommand = commandBytes.get(record.command.command_id);
    if (previousCommand !== undefined && previousCommand !== bytesForCommand) {
      corrupt(`command_id ${record.command.command_id} has conflicting canonical bytes`);
    }
    commandBytes.set(record.command.command_id, bytesForCommand);
    records.push(Object.freeze(record));
  }
  return records;
}

export async function appendJournalRecord(file: FileHandle, record: JournalRecordV4): Promise<void> {
  const bytes = Buffer.from(`${canonicalJsonV4(record)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0 || bytesWritten > bytes.length - offset)
      throw new Error('BROKER_STATE_CORRUPT: journal write did not make valid forward progress');
    offset += bytesWritten;
  }
  await file.sync();
}

async function openJournal(directory: string): Promise<JournalV4> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, JOURNAL_FILE_V4);
  const existingBytes = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const mutableRecords = parseRecords(existingBytes);
  const commandBytes = new Map(mutableRecords.map((record) => [record.command.command_id, canonicalJsonV4(record.command)]));
  const file = await open(filePath, 'a+', 0o600);
  let closed = false;
  const records = mutableRecords as JournalRecordV4[];
  return {
    get records() {
      return Object.freeze([...records]);
    },
    append: async (command) => {
      if (closed) throw new Error('BROKER_STATE_CORRUPT: journal is closed');
      const durableCommand = loadJournalCommandV4(command);
      const commandBytesValue = canonicalJsonV4(durableCommand);
      const prior = commandBytes.get(durableCommand.command_id);
      if (prior !== undefined) {
        if (prior !== commandBytesValue) corrupt(`command_id ${durableCommand.command_id} has conflicting canonical bytes`);
        const existing = records.find((record) => record.command.command_id === durableCommand.command_id);
        if (existing === undefined) corrupt(`command_id ${durableCommand.command_id} index is inconsistent`);
        return existing;
      }
      const draft = {
        sequence: records.length + 1,
        previous_hash: records.at(-1)?.record_hash ?? null,
        command: durableCommand,
        recorded_at: new Date().toISOString(),
      };
      const record = Object.freeze({ ...draft, record_hash: hashCanonicalV4(draft) });
      await appendJournalRecord(file, record);
      records.push(record);
      commandBytes.set(durableCommand.command_id, commandBytesValue);
      return record;
    },
    close: async () => {
      if (!closed) {
        closed = true;
        await file.close();
      }
    },
  };
}

export function createJournalV4(directory: string): Promise<JournalV4> {
  return openJournal(directory);
}

export function reopenJournalV4(directory: string): Promise<JournalV4> {
  return openJournal(directory);
}
