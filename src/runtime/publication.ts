import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeRepositoryPolicyV4, RuntimeWorkContractV4 } from './contracts.js';
import type { FinalizationLockV4, FinalizedRunV4 } from './finalize.js';

const SHA1 = /^[a-f0-9]{40}$/;
const RUN_ID = /^run_[A-Za-z0-9_-]{16,96}$/;

export interface PullRequestV4 {
  readonly number: number;
  readonly url: string;
  readonly state: 'OPEN' | 'MERGED';
  readonly head_sha: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly merge_commit_sha: string | null;
}

export interface PublicationAdapterV4 {
  pushExact(input: { commit_sha: string; branch: string; remote: string }): Promise<{ remote_sha: string }>;
  findPullRequest(input: { head_branch: string; base_branch: string }): Promise<PullRequestV4 | null>;
  createPullRequest(input: { head_branch: string; base_branch: string; title: string; body: string }): Promise<PullRequestV4>;
  waitForRequiredChecks(input: { pull_request: number; timeout_seconds: number }): Promise<void>;
  mergePullRequest(input: { pull_request: number; head_sha: string; method: 'squash' | 'merge' | 'rebase'; timeout_seconds: number }): Promise<PullRequestV4>;
}

export interface RunMergedEventV4 {
  readonly type: 'RUN_MERGED';
  readonly command_id: string;
  readonly run_id: string;
  readonly commit_sha: string;
  readonly pull_request: number;
  readonly pull_request_url: string;
  readonly merge_commit_sha: string;
  readonly publication_policy_hash: string;
}

export interface PublishFinalizedRunInputV4 {
  readonly contract: RuntimeWorkContractV4;
  readonly finalized: FinalizedRunV4;
  readonly policy: RuntimeRepositoryPolicyV4;
  readonly expected_policy_hash: string;
  readonly title: string;
  readonly body: string;
  readonly adapter: PublicationAdapterV4;
  readonly acquire_run_lock: () => Promise<FinalizationLockV4>;
  readonly acquire_repository_lock: () => Promise<FinalizationLockV4>;
  readonly append_run_merged: (event: RunMergedEventV4) => Promise<void>;
}

export interface PublishedRunV4 extends PullRequestV4 { readonly run_id: string; readonly local_commit_sha: string; }

function denied(message: string): never { throw new Error(`PUBLICATION_POLICY_DENIED: ${message}`); }
function failed(message: string): never { throw new Error(`PUBLICATION_FAILED: ${message}`); }

function verify(input: PublishFinalizedRunInputV4): { branch: string; policyHash: string } {
  const policyHash = hashCanonicalV4(input.policy);
  if (policyHash !== input.expected_policy_hash || input.contract.policy_hash !== policyHash) denied('repository policy identity is stale');
  const { contract_hash: supplied, ...contractBody } = input.contract;
  if (supplied !== hashCanonicalV4(contractBody)) denied('work contract identity is invalid');
  if (!input.policy.publication.enabled) denied('publication is disabled');
  if (!input.policy.base.allowedBranches.includes(input.policy.publication.baseBranch)) denied('publication base is not allowed');
  const prohibited = new Set(input.contract.prohibited_actions.map((value) => value.toLocaleLowerCase('en-US')));
  if (prohibited.has('push') || prohibited.has('merge') || prohibited.has('publish')) denied('task contract prohibits publication');
  if (!RUN_ID.test(input.finalized.run_id) || input.finalized.run_id !== input.contract.run_id
    || !SHA1.test(input.finalized.commit_sha) || input.finalized.task_ref !== `refs/heads/codex/auto/${input.contract.run_id}`) denied('finalized run identity is invalid');
  if (input.title.length < 1 || input.title.length > 256 || input.body.length > 16_384 || /[\u0000-\u001f\u007f]/.test(input.title)) denied('pull request metadata is invalid');
  return { branch: `codex/auto/${input.contract.run_id}`, policyHash };
}

export async function publishFinalizedRunV4(input: PublishFinalizedRunInputV4): Promise<PublishedRunV4> {
  const { branch, policyHash } = verify(input);
  const runLock = await input.acquire_run_lock();
  let repositoryLock: FinalizationLockV4 | undefined;
  try {
    repositoryLock = await input.acquire_repository_lock();
    const pushed = await input.adapter.pushExact({ commit_sha: input.finalized.commit_sha, branch, remote: input.policy.publication.remote });
    if (pushed.remote_sha !== input.finalized.commit_sha) failed('remote branch does not resolve to the accepted commit');
    let pullRequest = await input.adapter.findPullRequest({ head_branch: branch, base_branch: input.policy.publication.baseBranch });
    if (pullRequest === null) pullRequest = await input.adapter.createPullRequest({ head_branch: branch, base_branch: input.policy.publication.baseBranch, title: input.title, body: input.body });
    if (pullRequest.head_sha !== input.finalized.commit_sha || pullRequest.head_branch !== branch || pullRequest.base_branch !== input.policy.publication.baseBranch) failed('pull request identity differs from the accepted commit');
    if (pullRequest.state !== 'MERGED') {
      if (input.policy.publication.requireRequiredChecks) await input.adapter.waitForRequiredChecks({ pull_request: pullRequest.number, timeout_seconds: input.policy.publication.timeoutSeconds });
      pullRequest = await input.adapter.mergePullRequest({ pull_request: pullRequest.number, head_sha: input.finalized.commit_sha, method: input.policy.publication.mergeMethod, timeout_seconds: input.policy.publication.timeoutSeconds });
    }
    if (pullRequest.state !== 'MERGED' || pullRequest.head_sha !== input.finalized.commit_sha || pullRequest.merge_commit_sha === null || !SHA1.test(pullRequest.merge_commit_sha)) failed('merge result is missing or stale');
    await input.append_run_merged({ type: 'RUN_MERGED', command_id: `run-merged:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, pull_request: pullRequest.number, pull_request_url: pullRequest.url, merge_commit_sha: pullRequest.merge_commit_sha, publication_policy_hash: policyHash });
    return Object.freeze({ ...pullRequest, run_id: input.contract.run_id, local_commit_sha: input.finalized.commit_sha });
  } finally {
    await repositoryLock?.release().catch(() => undefined);
    await runLock.release().catch(() => undefined);
  }
}
