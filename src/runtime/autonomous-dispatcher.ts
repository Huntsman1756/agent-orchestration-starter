import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { RuntimeResultV4, RuntimeTaskRequestV4 } from './contracts.js';
import { loadRuntimeResultV4, loadRuntimeTaskRequestV4 } from './load.js';

const STATE_FILE = 'autonomous-dispatch-v4.json';
const HASH = /^[a-f0-9]{64}$/;
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const LEASE_ID = /^lease_[A-Za-z0-9_-]{16,96}$/;

export type AutonomousTaskSourceKindV4 = 'GITHUB_ISSUE' | 'CI_FAILURE' | 'SCHEDULED';

export interface AutonomousTaskCandidateV4 {
  readonly source: AutonomousTaskSourceKindV4;
  readonly candidate_id: string;
  readonly revision: string;
  readonly repository_id: string;
  readonly authorization_labels: readonly string[];
  readonly request: RuntimeTaskRequestV4;
}

export interface AutonomousDispatchPolicyV4 {
  readonly allowed_sources: readonly AutonomousTaskSourceKindV4[];
  readonly allowed_repository_ids: readonly string[];
  readonly required_labels: readonly string[];
  readonly max_active_tasks: number;
  readonly max_claims_per_cycle: number;
  readonly lease_seconds: number;
  readonly max_consecutive_failures: number;
  readonly require_merged_publication: boolean;
}

export interface AutonomousTaskSourceV4 {
  listCandidates(input: { readonly cursor: string | null; readonly limit: number }): Promise<{
    readonly candidates: readonly AutonomousTaskCandidateV4[];
    readonly next_cursor: string | null;
  }>;
  loadCandidate(input: { readonly candidate_id: string; readonly revision: string }): Promise<AutonomousTaskCandidateV4 | null>;
  claim(input: {
    readonly candidate_id: string;
    readonly revision: string;
    readonly lease_id: string;
    readonly expires_at: string;
  }): Promise<'CLAIMED' | 'BUSY' | 'STALE'>;
  renew(input: {
    readonly candidate_id: string;
    readonly revision: string;
    readonly lease_id: string;
    readonly expires_at: string;
  }): Promise<'RENEWED' | 'LOST'>;
  complete(input: {
    readonly candidate_id: string;
    readonly revision: string;
    readonly run_id: string;
    readonly merge_commit_sha: string;
    readonly evidence_hash: string;
  }): Promise<void>;
  reopen(input: {
    readonly candidate_id: string;
    readonly revision: string;
    readonly run_id: string;
    readonly merge_commit_sha: string;
    readonly finding_id: string;
    readonly evidence_hash: string;
  }): Promise<void>;
  fail(input: {
    readonly candidate_id: string;
    readonly revision: string;
    readonly run_id: string | null;
    readonly failure_code: string;
    readonly evidence_hashes: readonly string[];
  }): Promise<void>;
}

export interface AutonomousRuntimePortV4 {
  start(request: RuntimeTaskRequestV4): Promise<RuntimeResultV4>;
  resume(runId: string): Promise<RuntimeResultV4>;
}

export interface AutonomousPostMergeVerifierV4 {
  verify(input: {
    readonly repository_id: string;
    readonly run_id: string;
    readonly merge_commit_sha: string;
  }): Promise<
    | { readonly outcome: 'PASS'; readonly evidence_hash: string }
    | { readonly outcome: 'FAIL'; readonly finding_id: string; readonly evidence_hash: string }
  >;
}

type TaskStatus = 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'REOPENED' | 'FAILED';
export type AutonomousDispatcherModeV4 = 'RUNNING' | 'DRAINING' | 'PAUSED';

interface StoredTaskV4 {
  readonly candidate_id: string;
  readonly revision: string;
  readonly repository_id: string;
  readonly request_id: string;
  readonly request_hash: string;
  readonly run_id: string | null;
  readonly status: TaskStatus;
  readonly consecutive_failures: number;
  readonly lease_id: string;
  readonly lease_expires_at: string;
  readonly last_evidence_hash: string | null;
}

interface DispatchStateV4 {
  readonly schema_version: 4;
  readonly mode: AutonomousDispatcherModeV4;
  readonly cursor: string | null;
  readonly circuit_open: boolean;
  readonly consecutive_failures: number;
  readonly tasks: readonly StoredTaskV4[];
}

interface StateEnvelopeV4 {
  readonly state: DispatchStateV4;
  readonly state_hash: string;
}

export interface AutonomousDispatcherStatusV4 {
  readonly mode: AutonomousDispatcherModeV4;
  readonly cursor: string | null;
  readonly circuit_open: boolean;
  readonly consecutive_failures: number;
  readonly tasks: readonly Omit<StoredTaskV4, 'request_hash' | 'lease_id'>[];
  readonly state_hash: string;
}

export interface AutonomousDispatchCycleReportV4 {
  readonly scanned: number;
  readonly claimed: number;
  readonly started: number;
  readonly resumed: number;
  readonly completed: number;
  readonly reopened: number;
  readonly failed: number;
  readonly skipped: number;
  readonly circuit_open: boolean;
  readonly state_hash: string;
}

export interface AutonomousDispatcherV4 {
  runCycle(): Promise<AutonomousDispatchCycleReportV4>;
  status(): Promise<AutonomousDispatcherStatusV4>;
  setMode(mode: AutonomousDispatcherModeV4): Promise<AutonomousDispatcherStatusV4>;
  resetCircuit(): Promise<AutonomousDispatcherStatusV4>;
}

export interface AutonomousDispatcherDependenciesV4 {
  readonly state_directory: string;
  readonly policy: AutonomousDispatchPolicyV4;
  readonly source: AutonomousTaskSourceV4;
  readonly runtime: AutonomousRuntimePortV4;
  readonly post_merge: AutonomousPostMergeVerifierV4;
  readonly now?: () => string;
  readonly lease_id?: () => string;
}

export interface AutonomousDispatcherLoopOptionsV4 {
  readonly dispatcher: AutonomousDispatcherV4;
  readonly interval_ms: number;
  readonly signal?: AbortSignal;
  readonly on_cycle?: (report: AutonomousDispatchCycleReportV4) => Promise<void> | void;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
}
function corrupt(message: string): never {
  throw new Error(`BROKER_STATE_CORRUPT: ${message}`);
}

function uniqueStrings(values: readonly string[], name: string): void {
  if (
    values.length === 0 ||
    values.length > 128 ||
    new Set(values).size !== values.length ||
    values.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 128)
  )
    invalid(`${name} is invalid`);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validatePolicy(policy: AutonomousDispatchPolicyV4): void {
  uniqueStrings(policy.allowed_sources, 'allowed_sources');
  uniqueStrings(policy.allowed_repository_ids, 'allowed_repository_ids');
  uniqueStrings(policy.required_labels, 'required_labels');
  if (!Number.isSafeInteger(policy.max_active_tasks) || policy.max_active_tasks < 1 || policy.max_active_tasks > 32)
    invalid('max_active_tasks is invalid');
  if (
    !Number.isSafeInteger(policy.max_claims_per_cycle) ||
    policy.max_claims_per_cycle < 1 ||
    policy.max_claims_per_cycle > policy.max_active_tasks
  )
    invalid('max_claims_per_cycle is invalid');
  if (!Number.isSafeInteger(policy.lease_seconds) || policy.lease_seconds < 30 || policy.lease_seconds > 3_600)
    invalid('lease_seconds is invalid');
  if (!Number.isSafeInteger(policy.max_consecutive_failures) || policy.max_consecutive_failures < 1 || policy.max_consecutive_failures > 32)
    invalid('max_consecutive_failures is invalid');
  if (policy.require_merged_publication !== true) invalid('autonomous dispatch requires merged publication');
}

function validateCandidate(candidate: AutonomousTaskCandidateV4, policy: AutonomousDispatchPolicyV4): AutonomousTaskCandidateV4 {
  if (!policy.allowed_sources.includes(candidate.source)) invalid('candidate source is not allowed');
  if (!CANDIDATE_ID.test(candidate.candidate_id)) invalid('candidate_id is invalid');
  if (!HASH.test(candidate.revision)) invalid('candidate revision is invalid');
  if (!policy.allowed_repository_ids.includes(candidate.repository_id)) invalid('candidate repository is not allowed');
  if (
    new Set(candidate.authorization_labels).size !== candidate.authorization_labels.length ||
    candidate.authorization_labels.some((label) => typeof label !== 'string' || label.length < 1 || label.length > 128)
  )
    invalid('authorization labels are invalid');
  if (!policy.required_labels.every((label) => candidate.authorization_labels.includes(label)))
    invalid('candidate authorization is incomplete');
  const request = loadRuntimeTaskRequestV4(structuredClone(candidate.request));
  if (request.repository_id !== candidate.repository_id) invalid('candidate repository differs from request');
  return Object.freeze({ ...candidate, authorization_labels: Object.freeze([...candidate.authorization_labels]), request });
}

function initialState(): DispatchStateV4 {
  return Object.freeze({
    schema_version: 4,
    mode: 'PAUSED',
    cursor: null,
    circuit_open: false,
    consecutive_failures: 0,
    tasks: Object.freeze([]),
  });
}

function envelope(state: DispatchStateV4): StateEnvelopeV4 {
  return Object.freeze({ state, state_hash: hashCanonicalV4(state) });
}

function parseState(value: unknown): StateEnvelopeV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) corrupt('dispatcher state is invalid');
  const supplied = value as Record<string, unknown>;
  if (
    Object.keys(supplied).sort().join(',') !== 'state,state_hash' ||
    typeof supplied.state_hash !== 'string' ||
    !HASH.test(supplied.state_hash)
  )
    corrupt('dispatcher envelope is invalid');
  if (supplied.state === null || typeof supplied.state !== 'object' || Array.isArray(supplied.state))
    corrupt('dispatcher state is invalid');
  const stateRecord = supplied.state as Record<string, unknown>;
  if (!hasExactKeys(stateRecord, ['schema_version', 'mode', 'cursor', 'circuit_open', 'consecutive_failures', 'tasks']))
    corrupt('dispatcher state fields are invalid');
  const state = stateRecord as unknown as DispatchStateV4;
  if (
    state.schema_version !== 4 ||
    !['RUNNING', 'DRAINING', 'PAUSED'].includes(state.mode) ||
    !Array.isArray(state.tasks) ||
    typeof state.circuit_open !== 'boolean' ||
    !Number.isSafeInteger(state.consecutive_failures) ||
    state.consecutive_failures < 0 ||
    (state.cursor !== null && typeof state.cursor !== 'string')
  )
    corrupt('dispatcher state fields are invalid');
  const identities = new Set<string>();
  for (const task of state.tasks) {
    if (
      task === null ||
      typeof task !== 'object' ||
      Array.isArray(task) ||
      !hasExactKeys(task as unknown as Record<string, unknown>, [
        'candidate_id',
        'revision',
        'repository_id',
        'request_id',
        'request_hash',
        'run_id',
        'status',
        'consecutive_failures',
        'lease_id',
        'lease_expires_at',
        'last_evidence_hash',
      ]) ||
      !CANDIDATE_ID.test(task.candidate_id) ||
      !HASH.test(task.revision) ||
      typeof task.repository_id !== 'string' ||
      task.repository_id.length < 1 ||
      task.repository_id.length > 128 ||
      typeof task.request_id !== 'string' ||
      task.request_id.length < 1 ||
      task.request_id.length > 128 ||
      !HASH.test(task.request_hash) ||
      (task.run_id !== null && (typeof task.run_id !== 'string' || task.run_id.length < 1 || task.run_id.length > 128)) ||
      !['CLAIMED', 'RUNNING', 'COMPLETED', 'REOPENED', 'FAILED'].includes(task.status) ||
      !Number.isSafeInteger(task.consecutive_failures) ||
      task.consecutive_failures < 0 ||
      !LEASE_ID.test(task.lease_id) ||
      !validTimestamp(task.lease_expires_at) ||
      (task.last_evidence_hash !== null && !HASH.test(task.last_evidence_hash))
    )
      corrupt('dispatcher task fields are invalid');
    if ((task.status === 'CLAIMED' && task.run_id !== null) || (task.status !== 'CLAIMED' && task.run_id === null))
      corrupt('dispatcher task lifecycle is invalid');
    const identity = `${task.candidate_id}\0${task.revision}`;
    if (identities.has(identity)) corrupt('dispatcher task identity is duplicated');
    identities.add(identity);
  }
  if (supplied.state_hash !== hashCanonicalV4(state)) corrupt('dispatcher state hash is invalid');
  return Object.freeze({ state: Object.freeze({ ...state, tasks: Object.freeze([...state.tasks]) }), state_hash: supplied.state_hash });
}

async function readState(directory: string): Promise<StateEnvelopeV4> {
  const bytes = await readFile(join(directory, STATE_FILE), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (bytes === null) return envelope(initialState());
  if (!bytes.endsWith('\n')) corrupt('dispatcher state has a partial write');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    corrupt('dispatcher state is invalid JSON');
  }
  if (canonicalJsonV4(parsed) !== bytes.slice(0, -1)) corrupt('dispatcher state is not canonical JSON');
  return parseState(parsed);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error: unknown) {
    if (!(process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

async function writeState(directory: string, state: DispatchStateV4): Promise<StateEnvelopeV4> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const durable = envelope(state);
  const target = join(directory, STATE_FILE);
  const temporary = join(directory, `${STATE_FILE}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJsonV4(durable)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return durable;
}

function addSeconds(timestamp: string, seconds: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) invalid('clock returned an invalid timestamp');
  return new Date(date.getTime() + seconds * 1_000).toISOString();
}

function publicStatus(value: StateEnvelopeV4): AutonomousDispatcherStatusV4 {
  return Object.freeze({
    mode: value.state.mode,
    cursor: value.state.cursor,
    circuit_open: value.state.circuit_open,
    consecutive_failures: value.state.consecutive_failures,
    tasks: Object.freeze(value.state.tasks.map(({ request_hash: _requestHash, lease_id: _leaseId, ...task }) => Object.freeze(task))),
    state_hash: value.state_hash,
  });
}

function replaceTask(state: DispatchStateV4, replacement: StoredTaskV4): DispatchStateV4 {
  return Object.freeze({
    ...state,
    tasks: Object.freeze(
      state.tasks.map((task) =>
        task.candidate_id === replacement.candidate_id && task.revision === replacement.revision ? replacement : task,
      ),
    ),
  });
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolvePromise();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function runAutonomousDispatcherLoopV4(options: AutonomousDispatcherLoopOptionsV4): Promise<void> {
  if (!Number.isSafeInteger(options.interval_ms) || options.interval_ms < 100 || options.interval_ms > 60_000) {
    invalid('dispatcher loop interval is invalid');
  }
  const sleep = options.sleep ?? abortableDelay;
  while (!options.signal?.aborted) {
    const report = await options.dispatcher.runCycle();
    await options.on_cycle?.(report);
    if (options.signal?.aborted) break;
    await sleep(options.interval_ms, options.signal);
  }
}

export function createAutonomousDispatcherV4(deps: AutonomousDispatcherDependenciesV4): AutonomousDispatcherV4 {
  validatePolicy(deps.policy);
  if (typeof deps.state_directory !== 'string' || !isAbsolute(deps.state_directory) || deps.state_directory.includes('\0')) {
    invalid('state_directory must be absolute');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const nextLeaseId = deps.lease_id ?? (() => `lease_${crypto.randomUUID().replaceAll('-', '')}`);
  let running = false;

  return Object.freeze({
    status: async () => publicStatus(await readState(deps.state_directory)),
    resetCircuit: async () => {
      if (running) throw new Error('DISPATCHER_BUSY: a dispatch cycle is already running');
      running = true;
      try {
        const current = await readState(deps.state_directory);
        if (!current.state.circuit_open && current.state.consecutive_failures === 0) return publicStatus(current);
        if (current.state.mode !== 'PAUSED') throw new Error('INVALID_STATE: circuit reset requires PAUSED mode');
        return publicStatus(
          await writeState(
            deps.state_directory,
            Object.freeze({
              ...current.state,
              circuit_open: false,
              consecutive_failures: 0,
            }),
          ),
        );
      } finally {
        running = false;
      }
    },
    setMode: async (mode: AutonomousDispatcherModeV4) => {
      if (running) throw new Error('DISPATCHER_BUSY: a dispatch cycle is already running');
      if (!['RUNNING', 'DRAINING', 'PAUSED'].includes(mode)) invalid('dispatcher mode is invalid');
      running = true;
      try {
        const current = await readState(deps.state_directory);
        if (current.state.mode === mode) return publicStatus(current);
        return publicStatus(await writeState(deps.state_directory, Object.freeze({ ...current.state, mode })));
      } finally {
        running = false;
      }
    },
    runCycle: async () => {
      if (running) throw new Error('DISPATCHER_BUSY: a dispatch cycle is already running');
      running = true;
      try {
        let current = await readState(deps.state_directory);
        const counters = { scanned: 0, claimed: 0, started: 0, resumed: 0, completed: 0, reopened: 0, failed: 0, skipped: 0 };
        if (current.state.mode !== 'PAUSED') {
          const tasksAtCycleStart = current.state.tasks;
          for (const task of tasksAtCycleStart.filter((item) => item.status === 'CLAIMED')) {
            const supplied = await deps.source.loadCandidate({ candidate_id: task.candidate_id, revision: task.revision });
            if (supplied === null) corrupt('claimed candidate is no longer available');
            const candidate = validateCandidate(supplied, deps.policy);
            if (
              candidate.candidate_id !== task.candidate_id ||
              candidate.revision !== task.revision ||
              candidate.repository_id !== task.repository_id ||
              candidate.request.request_id !== task.request_id ||
              hashCanonicalV4(candidate.request) !== task.request_hash
            )
              corrupt('claimed candidate identity changed');
            const observedAt = now();
            const expiresAt = addSeconds(observedAt, deps.policy.lease_seconds);
            const renewed = await deps.source.renew({
              candidate_id: task.candidate_id,
              revision: task.revision,
              lease_id: task.lease_id,
              expires_at: expiresAt,
            });
            if (renewed !== 'RENEWED') {
              const evidenceHash = hashCanonicalV4({
                candidate_id: task.candidate_id,
                revision: task.revision,
                lease_id: task.lease_id,
                outcome: 'LOST_BEFORE_START',
              });
              const failures = current.state.consecutive_failures + 1;
              const failedTask: StoredTaskV4 = Object.freeze({
                ...task,
                status: 'FAILED',
                consecutive_failures: task.consecutive_failures + 1,
                last_evidence_hash: evidenceHash,
              });
              current = await writeState(
                deps.state_directory,
                replaceTask(
                  Object.freeze({
                    ...current.state,
                    consecutive_failures: failures,
                    circuit_open: failures >= deps.policy.max_consecutive_failures,
                  }),
                  failedTask,
                ),
              );
              counters.failed += 1;
              continue;
            }
            const runtimeResult = loadRuntimeResultV4(await deps.runtime.start(candidate.request));
            if (runtimeResult.request_id !== task.request_id) corrupt('runtime accepted a different request');
            const runningTask: StoredTaskV4 = Object.freeze({
              ...task,
              run_id: runtimeResult.run_id,
              status: 'RUNNING',
              lease_expires_at: expiresAt,
            });
            current = await writeState(deps.state_directory, replaceTask(current.state, runningTask));
            counters.started += 1;
          }
          for (const task of tasksAtCycleStart.filter((item) => item.status === 'RUNNING')) {
            if (task.run_id === null) corrupt('running dispatcher task has no run_id');
            const observedAt = now();
            const expiresAt = addSeconds(observedAt, deps.policy.lease_seconds);
            const renewed = await deps.source.renew({
              candidate_id: task.candidate_id,
              revision: task.revision,
              lease_id: task.lease_id,
              expires_at: expiresAt,
            });
            if (renewed !== 'RENEWED') {
              const evidenceHash = hashCanonicalV4({
                candidate_id: task.candidate_id,
                revision: task.revision,
                run_id: task.run_id,
                lease_id: task.lease_id,
                outcome: 'LOST_WHILE_RUNNING',
              });
              const failures = current.state.consecutive_failures + 1;
              const failedTask: StoredTaskV4 = Object.freeze({
                ...task,
                status: 'FAILED',
                consecutive_failures: task.consecutive_failures + 1,
                last_evidence_hash: evidenceHash,
              });
              current = await writeState(
                deps.state_directory,
                replaceTask(
                  Object.freeze({
                    ...current.state,
                    consecutive_failures: failures,
                    circuit_open: failures >= deps.policy.max_consecutive_failures,
                  }),
                  failedTask,
                ),
              );
              counters.failed += 1;
              continue;
            }
            const runtimeResult = loadRuntimeResultV4(await deps.runtime.resume(task.run_id));
            if (runtimeResult.run_id !== task.run_id || runtimeResult.request_id !== task.request_id)
              corrupt('runtime resumed a different request');
            counters.resumed += 1;
            if (runtimeResult.state === 'FAILED' || runtimeResult.state === 'ABORTED') {
              if (runtimeResult.failure === null) corrupt('terminal runtime failure lacks typed evidence');
              await deps.source.fail({
                candidate_id: task.candidate_id,
                revision: task.revision,
                run_id: task.run_id,
                failure_code: runtimeResult.failure.code,
                evidence_hashes: runtimeResult.failure.evidence_hashes,
              });
              const lastEvidence = runtimeResult.failure.evidence_hashes[0] ?? runtimeResult.artifact_manifest_hash;
              const failedTask: StoredTaskV4 = Object.freeze({
                ...task,
                status: 'FAILED',
                consecutive_failures: task.consecutive_failures + 1,
                lease_expires_at: expiresAt,
                last_evidence_hash: lastEvidence,
              });
              const failures = current.state.consecutive_failures + 1;
              current = await writeState(
                deps.state_directory,
                replaceTask(
                  Object.freeze({
                    ...current.state,
                    consecutive_failures: failures,
                    circuit_open: failures >= deps.policy.max_consecutive_failures,
                  }),
                  failedTask,
                ),
              );
              counters.failed += 1;
            } else if (runtimeResult.state === 'FINALIZED') {
              const mergeCommit = runtimeResult.publication.merge_commit_sha;
              if (runtimeResult.publication.state !== 'MERGED' || mergeCommit === null || !/^[a-f0-9]{40}$/.test(mergeCommit)) {
                corrupt('finalized run lacks required merged publication evidence');
              }
              const verification = await deps.post_merge.verify({
                repository_id: task.repository_id,
                run_id: task.run_id,
                merge_commit_sha: mergeCommit,
              });
              if (!HASH.test(verification.evidence_hash)) corrupt('post-merge verification evidence is invalid');
              if (verification.outcome === 'PASS') {
                await deps.source.complete({
                  candidate_id: task.candidate_id,
                  revision: task.revision,
                  run_id: task.run_id,
                  merge_commit_sha: mergeCommit,
                  evidence_hash: verification.evidence_hash,
                });
                const completed: StoredTaskV4 = Object.freeze({
                  ...task,
                  status: 'COMPLETED',
                  consecutive_failures: 0,
                  lease_expires_at: expiresAt,
                  last_evidence_hash: verification.evidence_hash,
                });
                current = await writeState(
                  deps.state_directory,
                  replaceTask(Object.freeze({ ...current.state, consecutive_failures: 0 }), completed),
                );
                counters.completed += 1;
              } else {
                if (
                  typeof verification.finding_id !== 'string' ||
                  verification.finding_id.length < 1 ||
                  verification.finding_id.length > 128
                )
                  corrupt('post-merge finding is invalid');
                await deps.source.reopen({
                  candidate_id: task.candidate_id,
                  revision: task.revision,
                  run_id: task.run_id,
                  merge_commit_sha: mergeCommit,
                  finding_id: verification.finding_id,
                  evidence_hash: verification.evidence_hash,
                });
                const reopened: StoredTaskV4 = Object.freeze({
                  ...task,
                  status: 'REOPENED',
                  consecutive_failures: task.consecutive_failures + 1,
                  lease_expires_at: expiresAt,
                  last_evidence_hash: verification.evidence_hash,
                });
                const failures = current.state.consecutive_failures + 1;
                current = await writeState(
                  deps.state_directory,
                  replaceTask(
                    Object.freeze({
                      ...current.state,
                      consecutive_failures: failures,
                      circuit_open: failures >= deps.policy.max_consecutive_failures,
                    }),
                    reopened,
                  ),
                );
                counters.reopened += 1;
              }
            } else {
              const resumedTask: StoredTaskV4 = Object.freeze({ ...task, lease_expires_at: expiresAt });
              current = await writeState(deps.state_directory, replaceTask(current.state, resumedTask));
            }
          }
          const active = current.state.tasks.filter((task) => task.status === 'CLAIMED' || task.status === 'RUNNING').length;
          const capacity =
            current.state.mode !== 'RUNNING' || current.state.circuit_open
              ? 0
              : Math.min(deps.policy.max_claims_per_cycle, deps.policy.max_active_tasks - active);
          if (capacity > 0) {
            const listed = await deps.source.listCandidates({ cursor: current.state.cursor, limit: capacity });
            if (
              !Array.isArray(listed.candidates) ||
              listed.candidates.length > capacity ||
              (listed.next_cursor !== null && typeof listed.next_cursor !== 'string')
            )
              invalid('candidate listing is invalid');
            counters.scanned = listed.candidates.length;
            for (const supplied of listed.candidates) {
              const candidate = validateCandidate(supplied, deps.policy);
              if (
                current.state.tasks.some((task) => task.candidate_id === candidate.candidate_id && task.revision === candidate.revision)
              ) {
                counters.skipped += 1;
                continue;
              }
              const leaseId = nextLeaseId();
              if (!LEASE_ID.test(leaseId)) invalid('lease_id is invalid');
              const observedAt = now();
              const expiresAt = addSeconds(observedAt, deps.policy.lease_seconds);
              const claimed = await deps.source.claim({
                candidate_id: candidate.candidate_id,
                revision: candidate.revision,
                lease_id: leaseId,
                expires_at: expiresAt,
              });
              if (claimed !== 'CLAIMED') {
                counters.skipped += 1;
                continue;
              }
              counters.claimed += 1;
              const requestHash = hashCanonicalV4(candidate.request);
              const pending: StoredTaskV4 = Object.freeze({
                candidate_id: candidate.candidate_id,
                revision: candidate.revision,
                repository_id: candidate.repository_id,
                request_id: candidate.request.request_id,
                request_hash: requestHash,
                run_id: null,
                status: 'CLAIMED',
                consecutive_failures: 0,
                lease_id: leaseId,
                lease_expires_at: expiresAt,
                last_evidence_hash: null,
              });
              current = await writeState(
                deps.state_directory,
                Object.freeze({ ...current.state, tasks: Object.freeze([...current.state.tasks, pending]) }),
              );
              const runtimeResult = loadRuntimeResultV4(await deps.runtime.start(candidate.request));
              if (runtimeResult.request_id !== candidate.request.request_id) corrupt('runtime accepted a different request');
              const runningTask: StoredTaskV4 = Object.freeze({ ...pending, run_id: runtimeResult.run_id, status: 'RUNNING' });
              current = await writeState(deps.state_directory, replaceTask(current.state, runningTask));
              counters.started += 1;
            }
            if (current.state.cursor !== listed.next_cursor) {
              current = await writeState(deps.state_directory, Object.freeze({ ...current.state, cursor: listed.next_cursor }));
            }
          }
        }
        return Object.freeze({ ...counters, circuit_open: current.state.circuit_open, state_hash: current.state_hash });
      } finally {
        running = false;
      }
    },
  });
}
