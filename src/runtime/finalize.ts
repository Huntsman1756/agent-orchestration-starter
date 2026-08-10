import { createHash } from 'node:crypto';

import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeWorkContractV4, ReviewAttestationV4 } from './contracts.js';
import type { DiffPolicyResultV4 } from './diff-policy.js';
import type { AcceptedTreeEntryV4, GitObjectWriterV4 } from './git-object-writer.js';
import { verifyReviewAttestation } from './review-attestation.js';
import type { ValidationResultV4 } from './validation.js';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface FinalizationLockV4 { release(): Promise<void>; }
export interface ValidationManifestV4 { readonly results: readonly ValidationResultV4[]; readonly manifest_hash: string; }
export interface CommitCreatedEventV4 {
  readonly type: 'COMMIT_CREATED';
  readonly command_id: string;
  readonly run_id: string;
  readonly task_ref: string;
  readonly base_sha: string;
  readonly git_tree_sha: string;
  readonly evidence_tree_hash: string;
  readonly commit_sha: string;
  readonly contract_hash: string;
  readonly diff_hash: string;
  readonly validation_manifest_hash: string;
  readonly review_attestation_hash: string;
}

export interface FinalizeRunInputV4 {
  readonly contract: RuntimeWorkContractV4;
  readonly expected_policy_hash: string;
  readonly expected_profile_hash: string;
  readonly accepted_diff: DiffPolicyResultV4;
  readonly validation_manifest: ValidationManifestV4;
  readonly review_attestation: ReviewAttestationV4;
  readonly reviewer_session_id: string;
  readonly prior_session_ids: readonly string[];
  readonly task_ref: string;
  readonly expected_old_sha: string;
  readonly commit_message: string;
  readonly author: Readonly<{ name: string; email: string; timestamp: string }>;
  readonly writer: GitObjectWriterV4;
  readonly acquire_run_lock: () => Promise<FinalizationLockV4>;
  readonly acquire_repository_lock: () => Promise<FinalizationLockV4>;
  readonly reinspect_diff: () => Promise<DiffPolicyResultV4>;
  readonly snapshot_accepted_tree: () => Promise<readonly AcceptedTreeEntryV4[]>;
  readonly read_task_ref: (taskRef: string) => Promise<string | null>;
  readonly append_commit_created: (event: CommitCreatedEventV4) => Promise<void>;
}

export interface FinalizedRunV4 {
  readonly run_id: string;
  readonly task_ref: string;
  readonly commit_sha: string;
  readonly git_tree_sha: string;
  readonly evidence_tree_hash: string;
  readonly diff_hash: string;
  readonly review_attestation_hash: string;
}

function evidenceFailure(message: string): never { throw new Error(`EVIDENCE_HASH_MISMATCH: ${message}`); }
function finalizationFailure(message: string): never { throw new Error(`FINALIZATION_FAILED: ${message}`); }

function exactCanonical(left: unknown, right: unknown, label: string): void {
  if (hashCanonicalV4(left) !== hashCanonicalV4(right)) evidenceFailure(`${label} changed after acceptance`);
}

function verifyContract(input: FinalizeRunInputV4): void {
  const { contract_hash: supplied, ...body } = input.contract;
  if (supplied !== hashCanonicalV4(body)) evidenceFailure('work contract self-hash is invalid');
  if (input.contract.policy_hash !== input.expected_policy_hash || input.contract.profile_hash !== input.expected_profile_hash) evidenceFailure('policy or profile hash is stale');
  if (input.contract.base_sha !== input.expected_old_sha || !SHA1.test(input.expected_old_sha)) evidenceFailure('finalization base does not match the contract');
  if (input.task_ref !== `refs/heads/codex/auto/${input.contract.run_id}`) evidenceFailure('task ref is not bound to this run');
}

function verifyValidation(input: FinalizeRunInputV4): void {
  const expectedManifestHash = hashCanonicalV4({
    schema_version: 4,
    results: input.validation_manifest.results.map((result) => ({
      validation_id: result.validation_id,
      passed: result.passed,
      result_hash: result.result_hash,
      validated_tree_hash: result.validated_tree_hash,
    })),
  });
  if (input.validation_manifest.manifest_hash !== expectedManifestHash) evidenceFailure('validation manifest hash is invalid');
  if (input.validation_manifest.results.length < 1) evidenceFailure('validation manifest is empty');
  for (const result of input.validation_manifest.results) {
    const { result_hash: supplied, ...body } = result;
    if (supplied !== hashCanonicalV4(body) || !result.passed || result.validated_tree_hash !== input.accepted_diff.tree_hash || result.policy_hash !== input.expected_policy_hash) {
      evidenceFailure(`validation ${result.validation_id} is failed, forged, or stale`);
    }
  }
}

function verifySnapshot(entries: readonly AcceptedTreeEntryV4[], diff: DiffPolicyResultV4): void {
  const byPath = new Map<string, AcceptedTreeEntryV4>();
  for (const entry of entries) {
    const folded = entry.path.toLocaleLowerCase('en-US');
    if (byPath.has(folded)) evidenceFailure(`accepted snapshot has ambiguous path ${entry.path}`);
    byPath.set(folded, entry);
  }
  for (const change of diff.changes) {
    const entry = byPath.get(change.path.toLocaleLowerCase('en-US'));
    if (change.operation === 'DELETE') {
      if (entry !== undefined) evidenceFailure(`deleted path remains in accepted snapshot: ${change.path}`);
      continue;
    }
    if (entry === undefined || entry.path !== change.path || change.content_hash === null) evidenceFailure(`changed path is absent from accepted snapshot: ${change.path}`);
    const actual = createHash('sha256').update(entry.bytes).digest('hex');
    if (actual !== change.content_hash) evidenceFailure(`accepted bytes changed after review: ${change.path}`);
  }
}

export async function finalizeRun(input: FinalizeRunInputV4): Promise<FinalizedRunV4> {
  verifyContract(input);
  if (!SHA256.test(input.accepted_diff.tree_hash) || !SHA256.test(input.accepted_diff.diff_hash)) evidenceFailure('accepted diff identity is invalid');
  verifyValidation(input);
  const attestation = verifyReviewAttestation({
    attestation: input.review_attestation,
    current: {
      contract_hash: input.contract.contract_hash,
      base_sha: input.contract.base_sha,
      tree_hash: input.accepted_diff.tree_hash,
      diff_hash: input.accepted_diff.diff_hash,
      validation_manifest_hash: input.validation_manifest.manifest_hash,
      allowed_session_id: input.reviewer_session_id,
      prior_session_ids: input.prior_session_ids,
    },
  });
  if (attestation.decision !== 'ACCEPT' || attestation.run_id !== input.contract.run_id) evidenceFailure('review did not accept this run');

  const runLock = await input.acquire_run_lock();
  let repositoryLock: FinalizationLockV4 | undefined;
  try {
    repositoryLock = await input.acquire_repository_lock();
    const beforeSnapshot = await input.reinspect_diff();
    exactCanonical(beforeSnapshot, input.accepted_diff, 'diff evidence');
    const entries = await input.snapshot_accepted_tree();
    verifySnapshot(entries, input.accepted_diff);
    const afterSnapshot = await input.reinspect_diff();
    exactCanonical(afterSnapshot, input.accepted_diff, 'tree snapshot');

    const tree = await input.writer.writeAcceptedTree({ entries });
    const commit = await input.writer.createCommit({
      tree_sha: tree.tree_sha,
      base_sha: input.contract.base_sha,
      message: input.commit_message,
      author_name: input.author.name,
      author_email: input.author.email,
      authored_at: input.author.timestamp,
    });
    const currentRef = await input.read_task_ref(input.task_ref);
    if (currentRef !== commit.commit_sha) {
      if (currentRef !== input.expected_old_sha) finalizationFailure('task ref changed concurrently');
      await input.writer.updateTaskRef({ task_ref: input.task_ref, new_commit_sha: commit.commit_sha, expected_old_sha: input.expected_old_sha });
    }
    const verifiedRef = await input.read_task_ref(input.task_ref);
    if (verifiedRef !== commit.commit_sha) finalizationFailure('task ref does not resolve to intended commit');
    await input.append_commit_created({
      type: 'COMMIT_CREATED',
      command_id: `commit-created:${input.contract.run_id}`,
      run_id: input.contract.run_id,
      task_ref: input.task_ref,
      base_sha: input.contract.base_sha,
      git_tree_sha: tree.tree_sha,
      evidence_tree_hash: input.accepted_diff.tree_hash,
      commit_sha: commit.commit_sha,
      contract_hash: input.contract.contract_hash,
      diff_hash: input.accepted_diff.diff_hash,
      validation_manifest_hash: input.validation_manifest.manifest_hash,
      review_attestation_hash: attestation.attestation_hash,
    });
    return Object.freeze({
      run_id: input.contract.run_id,
      task_ref: input.task_ref,
      commit_sha: commit.commit_sha,
      git_tree_sha: tree.tree_sha,
      evidence_tree_hash: input.accepted_diff.tree_hash,
      diff_hash: input.accepted_diff.diff_hash,
      review_attestation_hash: attestation.attestation_hash,
    });
  } finally {
    await repositoryLock?.release().catch(() => undefined);
    await runLock.release().catch(() => undefined);
  }
}
