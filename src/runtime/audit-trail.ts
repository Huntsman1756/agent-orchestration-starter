import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';

export const AUDIT_TRAIL_FILE_V4 = 'audit-trail.v4.ndjson';

const HASH = /^[a-f0-9]{64}$/u;
const RUN_ID = /^run_[A-Za-z0-9_-]{16,96}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_COMPLETION_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export type AuditTrailStatusV4 = string;

export interface AuditTrailGateInputV4 {
  readonly validation_id: string;
  readonly exit_code: number;
  readonly result_hash: string;
  readonly output?: string;
}

export interface AuditTrailGateResultV4 {
  readonly validation_id: string;
  readonly exit_code: number;
  readonly result_hash: string;
  readonly output: string;
}

export interface AuditTrailEntryInputV4 {
  readonly event_id: string;
  readonly event_type: string;
  readonly story_id: string;
  readonly run_id: string;
  readonly started_at?: string;
  readonly finished_at?: string | null;
  readonly contract_hash: string;
  readonly capability_snapshot_hash?: string | null;
  readonly prompt?: string;
  readonly raw_completion?: string;
  readonly diff?: string | unknown;
  readonly validation_results?: readonly AuditTrailGateInputV4[];
  readonly status: AuditTrailStatusV4;
}

export interface AuditTrailEvidenceV4 {
  readonly event_id?: string;
  readonly event_type?: string;
  readonly story_id?: string;
  readonly started_at?: string;
  readonly finished_at?: string | null;
  readonly contract_hash?: string;
  readonly capability_snapshot_hash?: string | null;
  readonly prompt?: string;
  readonly raw_completion?: string;
  readonly diff?: string | unknown;
  readonly validation_results?: readonly AuditTrailGateInputV4[];
  readonly status?: AuditTrailStatusV4;
}

export interface AuditTrailEntryV4 {
  readonly schema_version: 4;
  readonly event_id: string;
  readonly event_type: string;
  readonly story_id: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly contract_hash: string;
  readonly capability_snapshot_hash: string | null;
  readonly prompt: string;
  readonly raw_completion: string;
  readonly diff: string;
  readonly validation_results: readonly AuditTrailGateResultV4[];
  readonly status: AuditTrailStatusV4;
}

export interface AuditTrailRecordV4 {
  readonly schema_version: 4;
  readonly sequence: number;
  readonly prev_hash: string | null;
  readonly entry: AuditTrailEntryV4;
  readonly record_hash: string;
}

export interface AuditTrailV4 {
  readonly records: readonly AuditTrailRecordV4[];
  append(entry: AuditTrailEntryInputV4): Promise<AuditTrailRecordV4>;
  close(): Promise<void>;
}

export interface AuditTrailVerificationV4 {
  readonly status: 'OK' | 'INTEGRITY_BREACH';
  readonly record_count: number;
  readonly last_hash: string | null;
  readonly error?: string;
}

function invalid(message: string): never {
  throw new Error(`AUDIT_TRAIL_INTEGRITY_BREACH: ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    invalid(`${name} has unknown or missing properties`);
}

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > maxBytes)
    invalid(`${name} is invalid or exceeds its byte policy`);
  return value;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) invalid(`${name} is invalid`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalid(`${name} is invalid`);
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(`${name} is invalid`);
  return value;
}

function redactSecretsInText(value: string): string {
  let redacted = value;
  redacted = redacted.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED]');
  redacted = redacted.replace(
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|jdbc:[a-z]+):\/\/[^\s"'<>]+/giu,
    '[REDACTED]',
  );
  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]{12,}/giu, 'Bearer [REDACTED]');
  redacted = redacted.replace(
    /([?&](?:access[_-]?token|api[_-]?key|client[_-]?secret|refresh[_-]?token|token|secret)=)[^&\s]+/giu,
    '$1[REDACTED]',
  );
  redacted = redacted.replace(
    /\b((?:(?:[A-Z][A-Z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|DSN|CONNECTION)[A-Z0-9_]*)|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret)))\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    '$1$2[REDACTED]',
  );
  redacted = redacted.replace(/\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  redacted = redacted.replace(/\b(?:gh[pousr]_|xox[baprs]-|AIza|AKIA|npm_)[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]');
  return redacted;
}

export function redactSecretsV4(value: string): string {
  return redactSecretsInText(value);
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretsInText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function serializedDiff(value: string | unknown): string {
  const redacted = typeof value === 'string' ? redactSecretsInText(value) : canonicalJsonV4(redactValue(value));
  return boundedString(redacted, 'diff', MAX_DIFF_BYTES);
}

function loadGate(value: unknown, index: number): AuditTrailGateResultV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`validation result ${index + 1} is invalid`);
  const candidate = value as Record<string, unknown>;
  exactKeys(candidate, ['validation_id', 'exit_code', 'result_hash', 'output'], `validation result ${index + 1}`);
  const validation_id = identifier(candidate.validation_id, 'validation_id');
  if (!Number.isSafeInteger(candidate.exit_code) || (candidate.exit_code as number) < -255 || (candidate.exit_code as number) > 255)
    invalid('validation exit code is invalid');
  const result_hash = hash(candidate.result_hash, 'validation result_hash');
  const output = boundedString(candidate.output, 'validation output', MAX_DIFF_BYTES);
  return Object.freeze({ validation_id, exit_code: candidate.exit_code as number, result_hash, output });
}

export function loadAuditTrailEntryV4(value: unknown): AuditTrailEntryV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('audit entry is not an object');
  const candidate = value as Record<string, unknown>;
  exactKeys(
    candidate,
    [
      'schema_version',
      'event_id',
      'event_type',
      'story_id',
      'run_id',
      'started_at',
      'finished_at',
      'contract_hash',
      'capability_snapshot_hash',
      'prompt',
      'raw_completion',
      'diff',
      'validation_results',
      'status',
    ],
    'audit entry',
  );
  if (candidate.schema_version !== 4) invalid('audit entry schema version is invalid');
  const event_id = identifier(candidate.event_id, 'event_id');
  const event_type = identifier(candidate.event_type, 'event_type');
  const story_id = identifier(candidate.story_id, 'story_id');
  if (typeof candidate.run_id !== 'string' || !RUN_ID.test(candidate.run_id)) invalid('run_id is invalid');
  const run_id = candidate.run_id;
  const started_at = timestamp(candidate.started_at, 'started_at');
  const finished_at = candidate.finished_at === null ? null : timestamp(candidate.finished_at, 'finished_at');
  const contract_hash = hash(candidate.contract_hash, 'contract_hash');
  const capability_snapshot_hash =
    candidate.capability_snapshot_hash === null ? null : hash(candidate.capability_snapshot_hash, 'capability_snapshot_hash');
  const prompt = boundedString(candidate.prompt, 'prompt', MAX_PROMPT_BYTES);
  const raw_completion = boundedString(candidate.raw_completion, 'raw_completion', MAX_COMPLETION_BYTES);
  const diff = boundedString(candidate.diff, 'diff', MAX_DIFF_BYTES);
  if (!Array.isArray(candidate.validation_results) || candidate.validation_results.length > 128) invalid('validation_results is invalid');
  const validation_results = candidate.validation_results.map(loadGate);
  if (new Set(validation_results.map((item) => item.validation_id)).size !== validation_results.length)
    invalid('validation_results contains duplicates');
  const status = identifier(candidate.status, 'status');
  return Object.freeze({
    schema_version: 4,
    event_id,
    event_type,
    story_id,
    run_id,
    started_at,
    finished_at,
    contract_hash,
    capability_snapshot_hash,
    prompt,
    raw_completion,
    diff,
    validation_results: Object.freeze(validation_results),
    status,
  });
}

export function createAuditTrailEntryV4(input: AuditTrailEntryInputV4, now = new Date().toISOString()): AuditTrailEntryV4 {
  const prompt = redactSecretsInText(input.prompt ?? '');
  const raw_completion = redactSecretsInText(input.raw_completion ?? '');
  const validation_results = (input.validation_results ?? []).map((result) => ({
    validation_id: result.validation_id,
    exit_code: result.exit_code,
    result_hash: result.result_hash,
    output: redactSecretsInText(result.output ?? ''),
  }));
  return loadAuditTrailEntryV4({
    schema_version: 4,
    event_id: input.event_id,
    event_type: input.event_type,
    story_id: input.story_id,
    run_id: input.run_id,
    started_at: input.started_at ?? now,
    finished_at: input.finished_at ?? null,
    contract_hash: input.contract_hash,
    capability_snapshot_hash: input.capability_snapshot_hash ?? null,
    prompt,
    raw_completion,
    diff: serializedDiff(input.diff ?? ''),
    validation_results,
    status: input.status,
  });
}

export function auditTrailDirectoryV4(stateDirectory: string): string {
  return join(stateDirectory, 'logs');
}

function recordDraft(record: AuditTrailRecordV4): Omit<AuditTrailRecordV4, 'record_hash'> {
  return { schema_version: 4, sequence: record.sequence, prev_hash: record.prev_hash, entry: record.entry };
}

export function loadAuditTrailRecordV4(value: unknown): AuditTrailRecordV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('audit record is not an object');
  const candidate = value as Record<string, unknown>;
  exactKeys(candidate, ['schema_version', 'sequence', 'prev_hash', 'entry', 'record_hash'], 'audit record');
  if (candidate.schema_version !== 4 || !Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1)
    invalid('audit record identity is invalid');
  const prev_hash = candidate.prev_hash === null ? null : hash(candidate.prev_hash, 'prev_hash');
  const entry = loadAuditTrailEntryV4(candidate.entry);
  const record_hash = hash(candidate.record_hash, 'record_hash');
  const record = { schema_version: 4 as const, sequence: candidate.sequence as number, prev_hash, entry, record_hash };
  if (hashCanonicalV4(recordDraft(record)) !== record_hash) invalid(`audit record hash is broken at sequence ${record.sequence}`);
  return Object.freeze(record);
}

function parseRecords(bytes: string): AuditTrailRecordV4[] {
  if (bytes.length === 0) return [];
  if (!bytes.endsWith('\n')) invalid('audit trail has a partial trailing record');
  const records: AuditTrailRecordV4[] = [];
  const eventBytes = new Map<string, string>();
  for (const [index, line] of bytes.slice(0, -1).split('\n').entries()) {
    if (line.length === 0) invalid(`audit record ${index + 1} is empty`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid(`audit record ${index + 1} is not valid JSON`);
    }
    if (canonicalJsonV4(value) !== line) invalid(`audit record ${index + 1} is not canonical JSON`);
    const record = loadAuditTrailRecordV4(value);
    if (record.sequence !== index + 1 || record.prev_hash !== (records.at(-1)?.record_hash ?? null))
      invalid(`audit chain is broken at sequence ${record.sequence}`);
    const bytesForEvent = canonicalJsonV4(record.entry);
    const prior = eventBytes.get(record.entry.event_id);
    if (prior !== undefined && prior !== bytesForEvent) invalid(`event_id ${record.entry.event_id} has conflicting canonical bytes`);
    eventBytes.set(record.entry.event_id, bytesForEvent);
    records.push(record);
  }
  return records;
}

export async function appendAuditTrailRecordV4(file: FileHandle, record: AuditTrailRecordV4): Promise<void> {
  const bytes = Buffer.from(`${canonicalJsonV4(record)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten <= 0 || bytesWritten > bytes.length - offset)
      throw new Error('AUDIT_TRAIL_INTEGRITY_BREACH: audit write did not make valid forward progress');
    offset += bytesWritten;
  }
  await file.sync();
}

async function openAuditTrail(directory: string): Promise<AuditTrailV4> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, AUDIT_TRAIL_FILE_V4);
  const bytes = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const mutableRecords = parseRecords(bytes);
  const eventBytes = new Map(mutableRecords.map((record) => [record.entry.event_id, canonicalJsonV4(record.entry)]));
  const file = await open(path, 'a+', 0o600);
  let closed = false;
  const records = mutableRecords as AuditTrailRecordV4[];
  return {
    get records() {
      return Object.freeze([...records]);
    },
    append: async (input) => {
      if (closed) throw new Error('AUDIT_TRAIL_INTEGRITY_BREACH: audit trail is closed');
      const entry = createAuditTrailEntryV4(input);
      const entryBytes = canonicalJsonV4(entry);
      const prior = eventBytes.get(entry.event_id);
      if (prior !== undefined) {
        if (prior !== entryBytes) invalid(`event_id ${entry.event_id} has conflicting canonical bytes`);
        return records.find((record) => record.entry.event_id === entry.event_id)!;
      }
      const draft = { schema_version: 4 as const, sequence: records.length + 1, prev_hash: records.at(-1)?.record_hash ?? null, entry };
      const record = Object.freeze({ ...draft, record_hash: hashCanonicalV4(draft) });
      await appendAuditTrailRecordV4(file, record);
      records.push(record);
      eventBytes.set(entry.event_id, entryBytes);
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

export function createAuditTrailV4(directory: string): Promise<AuditTrailV4> {
  return openAuditTrail(directory);
}

export async function verifyAuditTrailV4(directory: string): Promise<AuditTrailVerificationV4> {
  try {
    const bytes = await readFile(join(directory, AUDIT_TRAIL_FILE_V4), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const records = parseRecords(bytes);
    return Object.freeze({ status: 'OK', record_count: records.length, last_hash: records.at(-1)?.record_hash ?? null });
  } catch (error) {
    return Object.freeze({
      status: 'INTEGRITY_BREACH',
      record_count: 0,
      last_hash: null,
      error: error instanceof Error ? error.message : 'audit trail could not be verified',
    });
  }
}
