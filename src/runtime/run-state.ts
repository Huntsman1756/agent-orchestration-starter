import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { RuntimeAttemptV4, RuntimeResultV4, RuntimeTaskRequestV4, RuntimeWorkContractV4 } from './contracts.js';
import { RUNTIME_FAILURE_CODES_V4, type RuntimeFailureV4 } from './failures.js';
import { reopenJournalV4 } from './journal.js';
import { loadRuntimeResultV4, loadRuntimeWorkContractV4 } from './load.js';
import type { RequestIndexV4 } from './request-idempotency.js';
import { registerRequestV4 } from './request-idempotency.js';

export const STATE_CACHE_FILE_V4 = 'current-state.v4.json';

export type ExternalProcessIdentityV4 = Readonly<{ pid: number; boot_nonce: string }>;

export type BrokerCommandV4 =
  | Readonly<{ type: 'RUN_CODING_TASK'; command_id: string; request: RuntimeTaskRequestV4 }>
  | Readonly<{ type: 'RUN_ACCEPTED'; command_id: string; request_hash: string; run_id: string; contract: RuntimeWorkContractV4; result: RuntimeResultV4; inspection_epoch: number }>
  | Readonly<{ type: 'ATTEMPT_RECORDED'; command_id: string; run_id: string; attempt: RuntimeAttemptV4 }>
  | Readonly<{ type: 'PATHS_REINSPECTED'; command_id: string; run_id: string; inspection_epoch: number }>
  | Readonly<{ type: 'EXTERNAL_PROCESS_STARTED'; command_id: string; run_id: string; process: ExternalProcessIdentityV4 }>
  | Readonly<{ type: 'RUN_FAILED'; command_id: string; run_id: string; failure: RuntimeFailureV4 }>;

export interface BrokerRunStateV4 {
  contract: RuntimeWorkContractV4;
  result: RuntimeResultV4;
  request_hash: string;
  inspection_epoch: number;
  inspection_required: boolean;
  external_process: ExternalProcessIdentityV4 | null;
}

export interface BrokerStateV4 {
  runs: Readonly<Record<string, BrokerRunStateV4>>;
  requests: RequestIndexV4;
}

function corrupt(message: string): never {
  throw new Error(`BROKER_STATE_CORRUPT: ${message}`);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) corrupt(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) corrupt(`${name} has unknown or missing properties`);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) corrupt(`${name} is invalid`);
  return value;
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^run_[A-Za-z0-9_-]{16,96}$/.test(value)) corrupt('run_id is invalid');
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) corrupt(`${name} is invalid`);
  return value;
}

export function loadJournalCommandV4(value: unknown): Exclude<BrokerCommandV4, { type: 'RUN_CODING_TASK' }> {
  const command = objectValue(value, 'journal command');
  const type = command.type;
  const command_id = identifier(command.command_id, 'command_id');
  try {
    if (type === 'RUN_ACCEPTED') {
      exactKeys(command, ['type', 'command_id', 'request_hash', 'run_id', 'contract', 'result', 'inspection_epoch'], 'RUN_ACCEPTED');
      if (!Number.isSafeInteger(command.inspection_epoch) || (command.inspection_epoch as number) < 1) corrupt('inspection_epoch is invalid');
      return {
        type,
        command_id,
        request_hash: hash(command.request_hash, 'request_hash'),
        run_id: runId(command.run_id),
        contract: loadRuntimeWorkContractV4(command.contract),
        result: loadRuntimeResultV4(command.result),
        inspection_epoch: command.inspection_epoch as number,
      };
    }
    if (type === 'ATTEMPT_RECORDED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'attempt'], 'ATTEMPT_RECORDED');
      const attempt = objectValue(command.attempt, 'attempt');
      exactKeys(attempt, ['attempt', 'executor_binding_ref', 'result_hash'], 'attempt');
      if (!Number.isSafeInteger(attempt.attempt) || (attempt.attempt as number) < 1) corrupt('attempt number is invalid');
      return { type, command_id, run_id: runId(command.run_id), attempt: { attempt: attempt.attempt as number, executor_binding_ref: identifier(attempt.executor_binding_ref, 'executor_binding_ref'), result_hash: hash(attempt.result_hash, 'result_hash') } };
    }
    if (type === 'PATHS_REINSPECTED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'inspection_epoch'], 'PATHS_REINSPECTED');
      if (!Number.isSafeInteger(command.inspection_epoch) || (command.inspection_epoch as number) < 1) corrupt('inspection_epoch is invalid');
      return { type, command_id, run_id: runId(command.run_id), inspection_epoch: command.inspection_epoch as number };
    }
    if (type === 'EXTERNAL_PROCESS_STARTED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'process'], 'EXTERNAL_PROCESS_STARTED');
      const processIdentity = objectValue(command.process, 'process');
      exactKeys(processIdentity, ['pid', 'boot_nonce'], 'process');
      if (!Number.isSafeInteger(processIdentity.pid) || (processIdentity.pid as number) < 1) corrupt('process pid is invalid');
      return { type, command_id, run_id: runId(command.run_id), process: { pid: processIdentity.pid as number, boot_nonce: identifier(processIdentity.boot_nonce, 'boot_nonce') } };
    }
    if (type === 'RUN_FAILED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'failure'], 'RUN_FAILED');
      const failure = objectValue(command.failure, 'failure');
      exactKeys(failure, ['code', 'message', 'retryable', 'evidence_hashes'], 'failure');
      if (!RUNTIME_FAILURE_CODES_V4.includes(failure.code as typeof RUNTIME_FAILURE_CODES_V4[number])) corrupt('failure code is invalid');
      if (typeof failure.message !== 'string' || failure.message.length < 1 || failure.message.length > 2_000) corrupt('failure message is invalid');
      if (typeof failure.retryable !== 'boolean') corrupt('failure retryable is invalid');
      if (!Array.isArray(failure.evidence_hashes) || failure.evidence_hashes.length > 64) corrupt('failure evidence_hashes is invalid');
      const evidence = failure.evidence_hashes.map((item) => hash(item, 'evidence hash'));
      if (new Set(evidence).size !== evidence.length) corrupt('failure evidence_hashes contains duplicates');
      return { type, command_id, run_id: runId(command.run_id), failure: { code: failure.code as RuntimeFailureV4['code'], message: failure.message, retryable: failure.retryable, evidence_hashes: evidence } };
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BROKER_STATE_CORRUPT:')) throw error;
    corrupt(`journal command contract is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  corrupt(`unknown journal command ${String(type)}`);
}

function freezeState(state: BrokerStateV4): BrokerStateV4 {
  return Object.freeze({
    requests: Object.freeze({ ...state.requests }),
    runs: Object.freeze(Object.fromEntries(Object.entries(state.runs).map(([runId, run]) => [runId, Object.freeze({
      ...run,
      contract: Object.freeze({ ...run.contract }),
      result: Object.freeze({ ...run.result, attempts: Object.freeze([...run.result.attempts]), validation_results: Object.freeze([...run.result.validation_results]), changed_files: Object.freeze([...run.result.changed_files]) }),
      external_process: run.external_process === null ? null : Object.freeze({ ...run.external_process }),
    })]))),
  });
}

export function initialBrokerStateV4(): BrokerStateV4 {
  return freezeState({ runs: {}, requests: {} });
}

function requireRun(state: BrokerStateV4, runId: string): BrokerRunStateV4 {
  const run = state.runs[runId];
  if (run === undefined) corrupt(`command references unknown run ${runId}`);
  return run;
}

export function reduceBrokerStateV4(state: BrokerStateV4, command: BrokerCommandV4): BrokerStateV4 {
  if (command.type === 'RUN_CODING_TASK') corrupt('unaccepted caller command cannot enter the journal');
  if (command.type === 'RUN_ACCEPTED') {
    if (state.runs[command.run_id] !== undefined) corrupt(`run_id ${command.run_id} was accepted twice`);
    if (command.contract.run_id !== command.run_id || command.result.run_id !== command.run_id || command.contract.request_id !== command.result.request_id) {
      corrupt(`accepted run ${command.run_id} has inconsistent identities`);
    }
    const registration = registerRequestV4(state.requests, command.contract.request_id, command.request_hash, command.run_id);
    if (!registration.created) corrupt(`request_id ${command.contract.request_id} was accepted twice`);
    return freezeState({
      requests: registration.index,
      runs: {
        ...state.runs,
        [command.run_id]: {
          contract: command.contract,
          result: command.result,
          request_hash: command.request_hash,
          inspection_epoch: command.inspection_epoch,
          inspection_required: false,
          external_process: null,
        },
      },
    });
  }

  const run = requireRun(state, command.run_id);
  if (new Set(['FAILED', 'ABORTED', 'FINALIZED']).has(run.result.state)) corrupt(`terminal run ${command.run_id} cannot transition`);
  let nextRun: BrokerRunStateV4;
  if (command.type === 'ATTEMPT_RECORDED') {
    if (run.result.state !== 'EXECUTION_STARTED' || run.external_process === null) corrupt(`attempt can only complete active execution for ${command.run_id}`);
    if (command.attempt.attempt !== run.result.attempts.length + 1) corrupt(`attempt sequence is invalid for ${command.run_id}`);
    nextRun = {
      ...run,
      result: { ...run.result, state: 'AWAITING_REINSPECTION', attempts: [...run.result.attempts, command.attempt] },
      inspection_required: true,
      external_process: null,
    };
  } else if (command.type === 'PATHS_REINSPECTED') {
    if (run.result.state !== 'AWAITING_REINSPECTION' || !run.inspection_required || run.external_process !== null) corrupt(`reinspection is not pending for ${command.run_id}`);
    if (command.inspection_epoch <= run.inspection_epoch) corrupt(`inspection epoch did not advance for ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'READY_FOR_EXECUTOR' }, inspection_epoch: command.inspection_epoch, inspection_required: false };
  } else if (command.type === 'EXTERNAL_PROCESS_STARTED') {
    if (run.result.state !== 'READY_FOR_EXECUTOR' || run.inspection_required || run.external_process !== null) corrupt(`executor launch is not allowed for ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'EXECUTION_STARTED' }, external_process: command.process };
  } else {
    nextRun = { ...run, result: { ...run.result, state: 'FAILED', failure: command.failure }, external_process: null };
  }
  return freezeState({ ...state, runs: { ...state.runs, [command.run_id]: nextRun } });
}

export function replayBrokerStateV4(commands: readonly BrokerCommandV4[]): BrokerStateV4 {
  return commands.reduce(reduceBrokerStateV4, initialBrokerStateV4());
}

interface StateCacheV4 { sequence: number; state_hash: string; state: BrokerStateV4 }

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Node on Windows reports EPERM for directory fsync; the temp file itself was
    // fsynced before the atomic MoveFileEx-backed rename. No other error is ignored.
    if (!(process.platform === 'win32' && code === 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

export interface StateCacheDurabilityV4 { syncDirectory?: (directory: string) => Promise<void> }

export async function writeBrokerStateCacheV4(directory: string, state: BrokerStateV4, sequence: number, durability: StateCacheDurabilityV4 = {}): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, STATE_CACHE_FILE_V4);
  const temporary = join(directory, `${STATE_CACHE_FILE_V4}.${process.pid}.${Date.now()}.tmp`);
  const cache: StateCacheV4 = { sequence, state_hash: hashCanonicalV4(state), state };
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJsonV4(cache)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await (durability.syncDirectory ?? syncDirectory)(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function recoverBrokerStateV4(directory: string): Promise<{ state: BrokerStateV4; sequence: number }> {
  const journal = await reopenJournalV4(directory);
  try {
    const state = replayBrokerStateV4(journal.records.map((record) => record.command));
    const sequence = journal.records.length;
    const path = join(directory, STATE_CACHE_FILE_V4);
    const bytes = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bytes === null) {
      await writeBrokerStateCacheV4(directory, state, sequence);
      return { state, sequence };
    }
    let cache: StateCacheV4;
    try { cache = JSON.parse(bytes) as StateCacheV4; } catch { corrupt('current-state cache is invalid JSON'); }
    if (!Number.isSafeInteger(cache.sequence) || cache.sequence < 0 || cache.sequence > sequence) corrupt('current-state cache sequence is outside the journal');
    const prefixState = replayBrokerStateV4(journal.records.slice(0, cache.sequence).map((record) => record.command));
    if (cache.state_hash !== hashCanonicalV4(prefixState) || cache.state_hash !== hashCanonicalV4(cache.state)) corrupt('current-state cache disagrees with journal replay');
    if (cache.sequence < sequence) await writeBrokerStateCacheV4(directory, state, sequence);
    return { state, sequence };
  } finally {
    await journal.close();
  }
}
