import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { RuntimeAttemptV4, RuntimeResultV4, RuntimeTaskRequestV4, RuntimeValidationResultV4, RuntimeWorkContractV4 } from './contracts.js';
import { RUNTIME_FAILURE_CODES_V4, type RuntimeFailureV4 } from './failures.js';
import { reopenJournalV4 } from './journal.js';
import { loadRuntimeResultV4, loadRuntimeWorkContractV4 } from './load.js';
import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
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
  | Readonly<{ type: 'CANDIDATE_ACCEPTED'; command_id: string; run_id: string; validation_results: readonly RuntimeValidationResultV4[]; diff_hash: string; tree_hash: string; changed_files: readonly string[]; review_attestation_hash: string }>
  | Readonly<{ type: 'COMMIT_CREATED'; command_id: string; run_id: string; task_ref: string; base_sha: string; git_tree_sha: string; evidence_tree_hash: string; commit_sha: string; contract_hash: string; diff_hash: string; validation_manifest_hash: string; review_attestation_hash: string }>
  | Readonly<{ type: 'BRANCH_PUSHED'; command_id: string; run_id: string; commit_sha: string; branch: string; remote: string; publication_policy_hash: string }>
  | Readonly<{ type: 'PULL_REQUEST_RECORDED'; command_id: string; run_id: string; commit_sha: string; pull_request: number; pull_request_url: string; base_branch: string; publication_policy_hash: string }>
  | Readonly<{ type: 'REQUIRED_CHECKS_PASSED'; command_id: string; run_id: string; commit_sha: string; pull_request: number; publication_policy_hash: string }>
  | Readonly<{ type: 'RUN_MERGED'; command_id: string; run_id: string; commit_sha: string; pull_request: number; pull_request_url: string; merge_commit_sha: string; publication_policy_hash: string }>
  | Readonly<{ type: 'PUBLICATION_SKIPPED'; command_id: string; run_id: string; commit_sha: string; publication_policy_hash: string; reason: 'POLICY_DISABLED' | 'CONTRACT_PROHIBITED' }>
  | Readonly<{ type: 'RUN_FAILED'; command_id: string; run_id: string; failure: RuntimeFailureV4 }>
  | Readonly<{ type: 'RUN_ABORTED'; command_id: string; run_id: string; failure: RuntimeFailureV4 }>;

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

function gitSha(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) corrupt(`${name} is invalid`);
  return value;
}

function pullRequest(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) corrupt('pull_request is invalid');
  return value as number;
}

function pullRequestUrl(value: unknown, pullRequestNumber: number): string {
  if (typeof value !== 'string' || value.length > 2_048 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(value)
    || !value.endsWith(`/pull/${pullRequestNumber}`)) corrupt('pull_request_url is invalid');
  return value;
}

function failureContract(value: unknown): RuntimeFailureV4 {
  const failure = objectValue(value, 'failure');
  exactKeys(failure, ['code', 'message', 'retryable', 'evidence_hashes'], 'failure');
  if (!RUNTIME_FAILURE_CODES_V4.includes(failure.code as typeof RUNTIME_FAILURE_CODES_V4[number])) corrupt('failure code is invalid');
  if (typeof failure.message !== 'string' || failure.message.length < 1 || failure.message.length > 2_000) corrupt('failure message is invalid');
  if (typeof failure.retryable !== 'boolean') corrupt('failure retryable is invalid');
  if (!Array.isArray(failure.evidence_hashes) || failure.evidence_hashes.length > 64) corrupt('failure evidence_hashes is invalid');
  const evidence = failure.evidence_hashes.map((item) => hash(item, 'evidence hash'));
  if (new Set(evidence).size !== evidence.length) corrupt('failure evidence_hashes contains duplicates');
  return { code: failure.code as RuntimeFailureV4['code'], message: failure.message, retryable: failure.retryable, evidence_hashes: evidence };
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
    if (type === 'CANDIDATE_ACCEPTED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'validation_results', 'diff_hash', 'tree_hash', 'changed_files', 'review_attestation_hash'], 'CANDIDATE_ACCEPTED');
      if (!Array.isArray(command.validation_results) || command.validation_results.length < 1 || command.validation_results.length > 64) corrupt('validation_results is invalid');
      const validationIds = new Set<string>();
      const validation_results = command.validation_results.map((item) => {
        const result = objectValue(item, 'validation result');
        exactKeys(result, ['validation_id', 'exit_code', 'result_hash'], 'validation result');
        const validation_id = identifier(result.validation_id, 'validation_id');
        if (validationIds.has(validation_id) || !Number.isSafeInteger(result.exit_code) || result.exit_code !== 0) corrupt('validation result is failed or duplicated');
        validationIds.add(validation_id);
        return { validation_id, exit_code: 0, result_hash: hash(result.result_hash, 'validation result_hash') };
      });
      if (!Array.isArray(command.changed_files) || command.changed_files.length < 1 || command.changed_files.length > 256) corrupt('changed_files is invalid');
      const changed_files = command.changed_files.map((item) => {
        if (typeof item !== 'string' || item.length > 512 || !isNormalizedRepositoryRelativePathV4(item)) corrupt('changed file path is invalid');
        return item;
      });
      if (new Set(changed_files.map((item) => item.toLocaleLowerCase('en-US'))).size !== changed_files.length) corrupt('changed_files is ambiguous or duplicated');
      return { type, command_id, run_id: runId(command.run_id), validation_results, diff_hash: hash(command.diff_hash, 'diff_hash'), tree_hash: hash(command.tree_hash, 'tree_hash'), changed_files, review_attestation_hash: hash(command.review_attestation_hash, 'review_attestation_hash') };
    }
    if (type === 'COMMIT_CREATED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'task_ref', 'base_sha', 'git_tree_sha', 'evidence_tree_hash', 'commit_sha', 'contract_hash', 'diff_hash', 'validation_manifest_hash', 'review_attestation_hash'], 'COMMIT_CREATED');
      if (typeof command.task_ref !== 'string' || !/^refs\/heads\/codex\/auto\/[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/.test(command.task_ref)) corrupt('task_ref is invalid');
      return { type, command_id, run_id: runId(command.run_id), task_ref: command.task_ref, base_sha: gitSha(command.base_sha, 'base_sha'), git_tree_sha: gitSha(command.git_tree_sha, 'git_tree_sha'), evidence_tree_hash: hash(command.evidence_tree_hash, 'evidence_tree_hash'), commit_sha: gitSha(command.commit_sha, 'commit_sha'), contract_hash: hash(command.contract_hash, 'contract_hash'), diff_hash: hash(command.diff_hash, 'diff_hash'), validation_manifest_hash: hash(command.validation_manifest_hash, 'validation_manifest_hash'), review_attestation_hash: hash(command.review_attestation_hash, 'review_attestation_hash') };
    }
    if (type === 'BRANCH_PUSHED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'commit_sha', 'branch', 'remote', 'publication_policy_hash'], 'BRANCH_PUSHED');
      if (typeof command.branch !== 'string' || !/^codex\/auto\/run_[A-Za-z0-9_-]{16,96}$/.test(command.branch)) corrupt('publication branch is invalid');
      if (typeof command.remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command.remote)) corrupt('publication remote is invalid');
      return { type, command_id, run_id: runId(command.run_id), commit_sha: gitSha(command.commit_sha, 'commit_sha'), branch: command.branch, remote: command.remote, publication_policy_hash: hash(command.publication_policy_hash, 'publication_policy_hash') };
    }
    if (type === 'PULL_REQUEST_RECORDED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'commit_sha', 'pull_request', 'pull_request_url', 'base_branch', 'publication_policy_hash'], 'PULL_REQUEST_RECORDED');
      const number = pullRequest(command.pull_request);
      if (typeof command.base_branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/.test(command.base_branch) || command.base_branch.includes('..')) corrupt('publication base_branch is invalid');
      return { type, command_id, run_id: runId(command.run_id), commit_sha: gitSha(command.commit_sha, 'commit_sha'), pull_request: number, pull_request_url: pullRequestUrl(command.pull_request_url, number), base_branch: command.base_branch, publication_policy_hash: hash(command.publication_policy_hash, 'publication_policy_hash') };
    }
    if (type === 'REQUIRED_CHECKS_PASSED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'commit_sha', 'pull_request', 'publication_policy_hash'], 'REQUIRED_CHECKS_PASSED');
      return { type, command_id, run_id: runId(command.run_id), commit_sha: gitSha(command.commit_sha, 'commit_sha'), pull_request: pullRequest(command.pull_request), publication_policy_hash: hash(command.publication_policy_hash, 'publication_policy_hash') };
    }
    if (type === 'RUN_MERGED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'commit_sha', 'pull_request', 'pull_request_url', 'merge_commit_sha', 'publication_policy_hash'], 'RUN_MERGED');
      const number = pullRequest(command.pull_request);
      return { type, command_id, run_id: runId(command.run_id), commit_sha: gitSha(command.commit_sha, 'commit_sha'), pull_request: number, pull_request_url: pullRequestUrl(command.pull_request_url, number), merge_commit_sha: gitSha(command.merge_commit_sha, 'merge_commit_sha'), publication_policy_hash: hash(command.publication_policy_hash, 'publication_policy_hash') };
    }
    if (type === 'PUBLICATION_SKIPPED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'commit_sha', 'publication_policy_hash', 'reason'], 'PUBLICATION_SKIPPED');
      if (command.reason !== 'POLICY_DISABLED' && command.reason !== 'CONTRACT_PROHIBITED') corrupt('publication skip reason is invalid');
      return { type, command_id, run_id: runId(command.run_id), commit_sha: gitSha(command.commit_sha, 'commit_sha'), publication_policy_hash: hash(command.publication_policy_hash, 'publication_policy_hash'), reason: command.reason };
    }
    if (type === 'RUN_FAILED' || type === 'RUN_ABORTED') {
      exactKeys(command, ['type', 'command_id', 'run_id', 'failure'], type);
      const failure = failureContract(command.failure);
      if (type === 'RUN_ABORTED' && failure.code !== 'ABORTED') corrupt('RUN_ABORTED requires the ABORTED failure code');
      return { type, command_id, run_id: runId(command.run_id), failure };
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
      result: Object.freeze({ ...run.result, attempts: Object.freeze([...run.result.attempts]), validation_results: Object.freeze([...run.result.validation_results]), changed_files: Object.freeze([...run.result.changed_files]), publication: Object.freeze({ ...run.result.publication }) }),
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
  } else if (command.type === 'CANDIDATE_ACCEPTED') {
    const allowedValidationIds = new Set(run.contract.allowed_validation_ids);
    const allowedChangePaths = new Set(run.contract.allowed_changes.map((change) => change.path.toLocaleLowerCase('en-US')));
    if (run.result.state !== 'READY_FOR_EXECUTOR' || run.result.attempts.length < 1 || run.inspection_required || run.external_process !== null
      || command.validation_results.length !== run.contract.allowed_validation_ids.length
      || command.validation_results.some((result, index) => result.validation_id !== run.contract.allowed_validation_ids[index] || !allowedValidationIds.has(result.validation_id))
      || command.changed_files.some((path) => !allowedChangePaths.has(path.toLocaleLowerCase('en-US')))
      || command.changed_files.length > run.contract.max_files_changed) corrupt(`accepted candidate evidence is not authorized for ${command.run_id}`);
    nextRun = {
      ...run,
      result: {
        ...run.result,
        state: 'REVIEW_ACCEPTED',
        validation_results: command.validation_results,
        diff_hash: command.diff_hash,
        tree_hash: command.tree_hash,
        changed_files: command.changed_files,
        review_attestation_hash: command.review_attestation_hash,
      },
    };
  } else if (command.type === 'COMMIT_CREATED') {
    if (run.result.state !== 'REVIEW_ACCEPTED' || run.inspection_required || run.external_process !== null
      || command.task_ref !== `refs/heads/${run.result.branch}` || command.base_sha !== run.contract.base_sha
      || command.contract_hash !== run.contract.contract_hash || command.diff_hash !== run.result.diff_hash
      || command.evidence_tree_hash !== run.result.tree_hash || command.review_attestation_hash !== run.result.review_attestation_hash) {
      corrupt(`commit evidence does not match accepted run ${command.run_id}`);
    }
    nextRun = { ...run, result: { ...run.result, state: 'READY_FOR_PUBLICATION', head_sha: command.commit_sha, commit_sha: command.commit_sha }, external_process: null };
  } else if (command.type === 'BRANCH_PUSHED') {
    if (run.result.state !== 'READY_FOR_PUBLICATION' || command.commit_sha !== run.result.commit_sha || command.branch !== run.result.branch
      || command.publication_policy_hash !== run.contract.policy_hash) corrupt(`pushed branch does not match finalized run ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'PUBLICATION_PUSHED', publication: { ...run.result.publication, state: 'PUSHED', remote: command.remote } } };
  } else if (command.type === 'PULL_REQUEST_RECORDED') {
    if (run.result.state !== 'PUBLICATION_PUSHED' || command.commit_sha !== run.result.commit_sha
      || command.publication_policy_hash !== run.contract.policy_hash) corrupt(`pull request does not match pushed run ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'PULL_REQUEST_OPEN', publication: { ...run.result.publication, state: 'PR_OPEN', base_branch: command.base_branch, pull_request: command.pull_request, pull_request_url: command.pull_request_url } } };
  } else if (command.type === 'REQUIRED_CHECKS_PASSED') {
    if (run.result.state !== 'PULL_REQUEST_OPEN' || command.commit_sha !== run.result.commit_sha || command.pull_request !== run.result.publication.pull_request
      || command.publication_policy_hash !== run.contract.policy_hash) corrupt(`required checks do not match pull request ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'REQUIRED_CHECKS_PASSED', publication: { ...run.result.publication, state: 'CHECKS_PASSED' } } };
  } else if (command.type === 'RUN_MERGED') {
    if (!new Set(['PULL_REQUEST_OPEN', 'REQUIRED_CHECKS_PASSED']).has(run.result.state) || command.commit_sha !== run.result.commit_sha
      || command.pull_request !== run.result.publication.pull_request || command.pull_request_url !== run.result.publication.pull_request_url
      || command.publication_policy_hash !== run.contract.policy_hash) corrupt(`merge does not match pull request ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'FINALIZED', head_sha: command.merge_commit_sha, publication: { ...run.result.publication, state: 'MERGED', merge_commit_sha: command.merge_commit_sha } } };
  } else if (command.type === 'PUBLICATION_SKIPPED') {
    if (run.result.state !== 'READY_FOR_PUBLICATION' || command.commit_sha !== run.result.commit_sha || command.publication_policy_hash !== run.contract.policy_hash) corrupt(`publication skip does not match finalized run ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'FINALIZED', publication: { ...run.result.publication, state: 'SKIPPED' } } };
  } else if (command.type === 'RUN_ABORTED') {
    if (command.failure.code !== 'ABORTED' || ['FAILED', 'ABORTED', 'FINALIZED'].includes(run.result.state)) corrupt(`abort evidence is invalid for ${command.run_id}`);
    nextRun = { ...run, result: { ...run.result, state: 'ABORTED', failure: command.failure }, external_process: null };
  } else {
    if (['FAILED', 'ABORTED', 'FINALIZED'].includes(run.result.state)) corrupt(`failure evidence is invalid for terminal run ${command.run_id}`);
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
