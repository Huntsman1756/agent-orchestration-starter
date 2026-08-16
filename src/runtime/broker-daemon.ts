import { randomBytes } from 'node:crypto';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeResultV4 } from './contracts.js';
import { RUNTIME_FAILURE_CODES_V4, type RuntimeFailureV4 } from './failures.js';
import { createJournalV4, type JournalV4 } from './journal.js';
import { loadRuntimeTaskRequestV4 } from './load.js';
import { inspectAllowedChanges, type InspectedChangeV4, type PathInspectionInputV4 } from './path-policy.js';
import { acquireRepositoryLockV4, acquireRunLockV4, type LockOwnerStatusV4, type ReclamationCoordinatorV4, type RepositoryLockOwnerV4, type RepositoryLockV4, type RunLockV4 } from './repository-lock.js';
import { freezeRepositoryPolicy, type FrozenRepositoryPolicyV4 } from './repository-policy.js';
import { loadRepositoryRegistration, type RegisteredRepositoryV4, type RepositoryRegistryV4 } from './repository-registry.js';
import { deriveWorkContract } from './routing.js';
import {
  recoverBrokerStateV4,
  reduceBrokerStateV4,
  writeBrokerStateCacheV4,
  type BrokerCommandV4,
  type BrokerReviewVerdictV4,
  type BrokerStateV4,
  type ExternalProcessIdentityV4,
} from './run-state.js';

export interface BrokerReplyV4 {
  request_id: string;
  run_id: string;
  state: string;
  status_token: string;
}

export interface BrokerDaemonV4 {
  submit(command: BrokerCommandV4): Promise<BrokerReplyV4>;
  status(runId: string): Promise<RuntimeResultV4>;
  recover(): Promise<void>;
  close(): Promise<void>;
  recordAttempt(runId: string, attempt: { attempt: number; executor_binding_ref: string; result_hash: string }): Promise<void>;
  reinspect(runId: string): Promise<void>;
  recordExternalProcessStarted(runId: string, process: ExternalProcessIdentityV4): Promise<void>;
  recordAcceptedCandidate?(event: Extract<BrokerCommandV4, { type: 'CANDIDATE_ACCEPTED' }>): Promise<void>;
  recordReviewVerdict?(runId: string, verdict: BrokerReviewVerdictV4): Promise<void>;
  recordFailure?(runId: string, failure: RuntimeFailureV4, commandId?: string): Promise<void>;
  recordAbort?(runId: string, commandId?: string): Promise<void>;
  recordCommitCreated?(event: Extract<BrokerCommandV4, { type: 'COMMIT_CREATED' }>): Promise<void>;
  recordPublication?(event: Extract<BrokerCommandV4, { type: 'BRANCH_PUSHED' | 'PULL_REQUEST_RECORDED' | 'REQUIRED_CHECKS_PASSED' | 'RUN_MERGED' | 'PUBLICATION_SKIPPED' }>): Promise<void>;
}

export interface BrokerDaemonDependenciesV4 {
  stateDirectory: string;
  registry: RepositoryRegistryV4;
  loadPolicy(registration: RegisteredRepositoryV4): Promise<FrozenRepositoryPolicyV4 | RuntimeRepositoryPolicyV4>;
  loadProfile(registration: RegisteredRepositoryV4): Promise<RuntimeProfileV4>;
  resolveBaseSha(registration: RegisteredRepositoryV4, policy: FrozenRepositoryPolicyV4): Promise<string>;
  sandboxProfiles: Readonly<Record<string, unknown>>;
  inspectChanges?: (input: PathInspectionInputV4) => Promise<readonly InspectedChangeV4[]>;
  generateRunId?: () => string;
  now?: () => string;
  lockOwnerStatus?: (owner: RepositoryLockOwnerV4) => Promise<LockOwnerStatusV4>;
  reconcileExternalProcess?: (runId: string, process: ExternalProcessIdentityV4) => Promise<'running' | 'terminated' | 'unknown'>;
  writeStateCache?: typeof writeBrokerStateCacheV4;
  reclamationCoordinator: ReclamationCoordinatorV4;
  allowInProcessCoordinatorForTests?: boolean;
}

const terminalStates = new Set(['FAILED', 'ABORTED', 'FINALIZED']);

function defaultRunId(): string {
  return `run_${randomBytes(18).toString('base64url')}`;
}

function commandId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

function normalizePublicError(error: unknown): Error {
  if (error instanceof Error) {
    const match = /^([A-Z_]+):\s*(.*)$/s.exec(error.message);
    if (match !== null && RUNTIME_FAILURE_CODES_V4.includes(match[1] as typeof RUNTIME_FAILURE_CODES_V4[number])) {
      return new Error(`${match[1]}: broker operation failed`);
    }
  }
  return new Error('UNKNOWN_FAILURE: broker operation failed');
}

function asFrozenPolicy(value: FrozenRepositoryPolicyV4 | RuntimeRepositoryPolicyV4): FrozenRepositoryPolicyV4 {
  if ('policy' in value && 'hash' in value) return value;
  return freezeRepositoryPolicy(value);
}

function initialResult(runId: string, contract: ReturnType<typeof deriveWorkContract>): RuntimeResultV4 {
  return {
    run_id: runId,
    request_id: contract.request_id,
    state: 'READY_FOR_EXECUTOR',
    effective_route: contract.effective_route,
    route_decision_hash: contract.route_decision_hash,
    effective_data_scope: contract.effective_data_scope,
    effective_source_sensitivity: contract.effective_source_sensitivity,
    branch: `codex/auto/${runId}`,
    base_sha: contract.base_sha,
    head_sha: null,
    contract_hash: contract.contract_hash,
    policy_hash: contract.policy_hash,
    profile_hash: contract.profile_hash,
    attempts: [],
    validation_results: [],
    diff_hash: hashCanonicalV4({ files: [] }),
    tree_hash: hashCanonicalV4({ base_sha: contract.base_sha, state: 'not-materialized' }),
    changed_files: [],
    review_attestation_hash: null,
    commit_sha: null,
    publication: { state: 'NOT_STARTED', remote: null, base_branch: null, pull_request: null, pull_request_url: null, merge_commit_sha: null },
    failure: null,
    artifact_manifest_hash: hashCanonicalV4({ run_id: runId, artifacts: [] }),
  };
}

export function createBrokerDaemon(deps: BrokerDaemonDependenciesV4): BrokerDaemonV4 {
  if (deps.reclamationCoordinator === undefined
    || (deps.reclamationCoordinator.certification.kind !== 'native-cross-process' && !deps.allowInProcessCoordinatorForTests)
    || deps.reclamationCoordinator.certification.identity.length === 0) {
    throw new Error('BROKER_STATE_CORRUPT: certified native reclamation coordinator is required');
  }
  let state: BrokerStateV4 | null = null;
  let journal: JournalV4 | null = null;
  let recovering: Promise<void> | null = null;
  let closed = false;
  const locks = new Map<string, RepositoryLockV4>();
  const runLocks = new Map<string, RunLockV4>();
  let mutationTail: Promise<void> = Promise.resolve();

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } catch (error) { throw normalizePublicError(error); } finally { release(); }
  };

  const requireOpen = (): void => {
    if (closed) throw new Error('BROKER_STATE_CORRUPT: broker daemon is closed');
  };

  const acquireFor = async (repositoryId: string): Promise<RepositoryLockV4> => {
    const current = locks.get(repositoryId);
    if (current !== undefined) return current;
    const lock = await acquireRepositoryLockV4({
      directory: deps.stateDirectory,
      repositoryId,
      ownerStatus: deps.lockOwnerStatus,
      reclamationCoordinator: deps.reclamationCoordinator,
    });
    locks.set(repositoryId, lock);
    return lock;
  };

  const acquireForRun = async (runId: string): Promise<RunLockV4> => {
    const current = runLocks.get(runId);
    if (current !== undefined) return current;
    const lock = await acquireRunLockV4({ directory: deps.stateDirectory, runId, ownerStatus: deps.lockOwnerStatus, reclamationCoordinator: deps.reclamationCoordinator });
    runLocks.set(runId, lock);
    return lock;
  };

  const persist = async (command: BrokerCommandV4): Promise<void> => {
    if (state === null || journal === null) throw new Error('BROKER_STATE_CORRUPT: daemon was not recovered');
    const prior = journal.records.find((record) => record.command.command_id === command.command_id);
    if (prior !== undefined) {
      if (canonicalJsonV4(prior.command) !== canonicalJsonV4(command)) throw new Error(`BROKER_STATE_CORRUPT: command_id ${command.command_id} has conflicting canonical bytes`);
      return;
    }
    const next = reduceBrokerStateV4(state, command);
    try {
      await journal.append(command);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BROKER_STATE_CORRUPT:')) throw error;
      throw new Error('BROKER_STATE_CORRUPT: durable journal append failed');
    }
    try {
      await (deps.writeStateCache ?? writeBrokerStateCacheV4)(deps.stateDirectory, next, journal.records.length);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BROKER_STATE_CORRUPT:')) throw error;
      throw new Error('BROKER_STATE_CORRUPT: durable state cache replacement failed');
    }
    state = next;
  };

  const doRecover = async (): Promise<void> => {
    requireOpen();
    if (state !== null && journal !== null) return;
    const recovered = await recoverBrokerStateV4(deps.stateDirectory);
    state = recovered.state;
    journal = await createJournalV4(deps.stateDirectory);

    for (const run of Object.values(state.runs)) {
      if (!terminalStates.has(run.result.state)) {
        await acquireFor(run.contract.repository_id);
        await acquireForRun(run.contract.run_id);
      }
    }
    for (const [runId, run] of Object.entries(state.runs)) {
      if (run.external_process === null || terminalStates.has(run.result.state)) continue;
      const reconciliation = await deps.reconcileExternalProcess?.(runId, run.external_process).catch(() => 'unknown' as const) ?? 'unknown';
      if (reconciliation !== 'running') {
        await persist({
          type: 'RUN_FAILED',
          command_id: commandId('reconcile-failed'),
          run_id: runId,
          failure: {
            code: 'UNKNOWN_FAILURE',
            message: `external process state after restart is ${reconciliation}`,
            retryable: false,
            evidence_hashes: [hashCanonicalV4(run.external_process)],
          },
        });
        const lock = locks.get(run.contract.repository_id);
        if (lock !== undefined) {
          await lock.release();
          locks.delete(run.contract.repository_id);
        }
        const runLock = runLocks.get(runId);
        if (runLock !== undefined) {
          await runLock.release();
          runLocks.delete(runId);
        }
      }
    }
  };

  const ensureRecovered = async (): Promise<void> => {
    if (state !== null && journal !== null) return;
    recovering ??= doRecover().finally(() => { recovering = null; });
    await recovering;
  };

  const resultFor = (runId: string): RuntimeResultV4 => {
    const run = state?.runs[runId];
    if (run === undefined) throw new Error(`INVALID_CONTRACT: unknown run_id ${runId}`);
    return run.result;
  };

  const releaseForRun = async (runId: string): Promise<void> => {
    const run = state?.runs[runId];
    if (run === undefined) return;
    const repositoryLock = locks.get(run.contract.repository_id);
    if (repositoryLock !== undefined) {
      await repositoryLock.release();
      locks.delete(run.contract.repository_id);
    }
    const runLock = runLocks.get(runId);
    if (runLock !== undefined) {
      await runLock.release();
      runLocks.delete(runId);
    }
  };

  const replyFor = (runId: string): BrokerReplyV4 => {
    const result = resultFor(runId);
    return {
      request_id: result.request_id,
      run_id: runId,
      state: result.state,
      status_token: hashCanonicalV4({ run_id: runId, state: result.state, artifact_manifest_hash: result.artifact_manifest_hash }),
    };
  };

  return {
    recover: () => serialize(ensureRecovered),
    submit: (callerCommand) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      if (callerCommand.type !== 'RUN_CODING_TASK') throw new Error(`INVALID_CONTRACT: unsupported submitted command ${callerCommand.type}`);
      const request = loadRuntimeTaskRequestV4(callerCommand.request);
      const requestHash = hashCanonicalV4(request);
      const existing = state?.requests[request.request_id];
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) throw new Error(`INVALID_CONTRACT: request_id ${request.request_id} was already used for different canonical bytes`);
        return replyFor(existing.run_id);
      }

      const registration = loadRepositoryRegistration(request.repository_id, deps.registry);
      const lock = await acquireFor(registration.repository_id);
      let runLock: RunLockV4 | null = null;
      let accepted = false;
      try {
        const [policyValue, profile] = await Promise.all([deps.loadPolicy(registration), deps.loadProfile(registration)]);
        const policy = asFrozenPolicy(policyValue);
        const baseSha = await deps.resolveBaseSha(registration, policy);
        await (deps.inspectChanges ?? inspectAllowedChanges)({
          repositoryRoot: registration.canonical_root,
          changes: request.allowed_changes,
          platform: process.platform,
        });
        const runId = (deps.generateRunId ?? defaultRunId)();
        if (!/^run_[A-Za-z0-9_-]{16,96}$/.test(runId) || state?.runs[runId] !== undefined) throw new Error('BROKER_STATE_CORRUPT: generated run_id is invalid or duplicated');
        runLock = await acquireForRun(runId);
        const contract = deriveWorkContract({
          request,
          run_id: runId,
          registration,
          policy,
          profile,
          base_sha: baseSha,
          sandbox_profiles: deps.sandboxProfiles,
        });
        await persist({
          type: 'RUN_ACCEPTED',
          command_id: callerCommand.command_id,
          request_hash: requestHash,
          run_id: runId,
          contract,
          result: initialResult(runId, contract),
          inspection_epoch: 1,
        });
        accepted = true;
        return replyFor(runId);
      } finally {
        if (!accepted) {
          if (runLock !== null) {
            await runLock.release();
            runLocks.delete(runLock.run_id);
          }
          await lock.release();
          locks.delete(registration.repository_id);
        }
      }
    }),
    status: (runId) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      return resultFor(runId);
    }),
    recordAttempt: (runId, attempt) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist({ type: 'ATTEMPT_RECORDED', command_id: commandId('attempt'), run_id: runId, attempt });
    }),
    reinspect: (runId) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      const run = state?.runs[runId];
      if (run === undefined) throw new Error(`INVALID_CONTRACT: unknown run_id ${runId}`);
      const registration = loadRepositoryRegistration(run.contract.repository_id, deps.registry);
      await (deps.inspectChanges ?? inspectAllowedChanges)({ repositoryRoot: registration.canonical_root, changes: run.contract.allowed_changes, platform: process.platform });
      await persist({ type: 'PATHS_REINSPECTED', command_id: commandId('reinspect'), run_id: runId, inspection_epoch: run.inspection_epoch + 1 });
    }),
    recordExternalProcessStarted: (runId, process) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist({ type: 'EXTERNAL_PROCESS_STARTED', command_id: commandId('external-started'), run_id: runId, process });
    }),
    recordAcceptedCandidate: (event) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist(event);
    }),
    recordReviewVerdict: (runId, verdict) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist({
        type: 'REVIEW_VERDICT_RECORDED',
        command_id: `review-verdict:${runId}:${verdict.verdict_hash.slice(0, 32)}`,
        run_id: runId,
        review_packet_hash: verdict.review_packet_hash,
        contract_hash: verdict.contract_hash,
        diff_hash: verdict.diff_hash,
        tree_hash: verdict.tree_hash,
        verdict: verdict.verdict,
        reason: verdict.reason,
        verdict_hash: verdict.verdict_hash,
      });
    }),
    recordFailure: (runId, failure, suppliedCommandId) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist({ type: 'RUN_FAILED', command_id: suppliedCommandId ?? `run-failed:${runId}:${hashCanonicalV4(failure)}`, run_id: runId, failure });
      await releaseForRun(runId);
    }),
    recordAbort: (runId, suppliedCommandId) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      const failure: RuntimeFailureV4 = { code: 'ABORTED', message: 'ABORTED: run was aborted by authenticated control', retryable: false, evidence_hashes: [] };
      await persist({ type: 'RUN_ABORTED', command_id: suppliedCommandId ?? `run-aborted:${runId}`, run_id: runId, failure });
      await releaseForRun(runId);
    }),
    recordCommitCreated: (event) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist(event);
    }),
    recordPublication: (event) => serialize(async () => {
      requireOpen();
      await ensureRecovered();
      await persist(event);
      if (event.type === 'RUN_MERGED' || event.type === 'PUBLICATION_SKIPPED') await releaseForRun(event.run_id);
    }),
    close: () => serialize(async () => {
      if (closed) return;
      if (recovering !== null) await recovering;
      closed = true;
      await journal?.close();
      journal = null;
      for (const lock of locks.values()) await lock.release();
      locks.clear();
      for (const lock of runLocks.values()) await lock.release();
      runLocks.clear();
    }),
  };
}
