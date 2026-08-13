import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeRepositoryPolicyV4, RuntimeWorkContractV4 } from './contracts.js';
import type { FinalizationLockV4, FinalizedRunV4 } from './finalize.js';
import type { BrokerCommandV4 } from './run-state.js';
import { verifyDelegationProvenanceV4, type DelegationProvenanceV4 } from './delegation-provenance.js';

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

export type PublicationProgressEventV4 = Extract<BrokerCommandV4, { type: 'BRANCH_PUSHED' | 'PULL_REQUEST_RECORDED' | 'REQUIRED_CHECKS_PASSED' | 'RUN_MERGED' | 'PUBLICATION_SKIPPED' }>;

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
  readonly append_publication_event: (event: PublicationProgressEventV4) => Promise<void>;
  readonly delegation_provenance_gate?: Readonly<
    | { enforcement: 'DISABLED' }
    | { enforcement: 'REQUIRED'; evidence: DelegationProvenanceV4 | null; trusted_public_key: string | Uint8Array }
  >;
}

export interface PublishedRunV4 extends PullRequestV4 { readonly run_id: string; readonly local_commit_sha: string; }

function denied(message: string): never { throw new Error(`PUBLICATION_POLICY_DENIED: ${message}`); }
function failed(message: string): never { throw new Error(`PUBLICATION_FAILED: ${message}`); }
function provenanceRequired(message: string): never { throw new Error(`DELEGATION_PROVENANCE_REQUIRED: ${message}`); }

function publicationIdentity(contract: RuntimeWorkContractV4, finalized: FinalizedRunV4, policy: RuntimeRepositoryPolicyV4, expectedPolicyHash: string): string {
  const policyHash = hashCanonicalV4(policy);
  const { contract_hash: supplied, ...contractBody } = contract;
  if (policyHash !== expectedPolicyHash || contract.policy_hash !== policyHash) denied('repository policy identity is stale');
  if (supplied !== hashCanonicalV4(contractBody)) denied('work contract identity is invalid');
  if (!RUN_ID.test(finalized.run_id) || finalized.run_id !== contract.run_id || !SHA1.test(finalized.commit_sha)
    || finalized.task_ref !== `refs/heads/codex/auto/${contract.run_id}`) denied('finalized run identity is invalid');
  return policyHash;
}

function verify(input: PublishFinalizedRunInputV4): { branch: string; policyHash: string } {
  const policyHash = publicationIdentity(input.contract, input.finalized, input.policy, input.expected_policy_hash);
  if (input.delegation_provenance_gate?.enforcement === 'REQUIRED') {
    if (input.delegation_provenance_gate.evidence === null) provenanceRequired('signed evidence is missing');
    try {
      const evidence = verifyDelegationProvenanceV4(input.delegation_provenance_gate.evidence, {
        commit_sha: input.finalized.commit_sha,
        git_tree_sha: input.finalized.git_tree_sha,
        policy_hash: policyHash,
        profile_hash: input.contract.profile_hash,
      }, input.delegation_provenance_gate.trusted_public_key);
      if (evidence.run_id !== input.contract.run_id || evidence.contract_hash !== input.contract.contract_hash
        || evidence.diff_hash !== input.finalized.diff_hash || evidence.evidence_tree_hash !== input.finalized.evidence_tree_hash
        || evidence.review_attestation_hash !== input.finalized.review_attestation_hash) provenanceRequired('evidence does not describe the finalized run');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('DELEGATION_PROVENANCE_REQUIRED:')) throw error;
      provenanceRequired('signed evidence is invalid or stale');
    }
  }
  if (!input.policy.publication.enabled) denied('publication is disabled');
  if (!input.policy.base.allowedBranches.includes(input.policy.publication.baseBranch)) denied('publication base is not allowed');
  const prohibited = new Set(input.contract.prohibited_actions.map((value) => value.toLocaleLowerCase('en-US')));
  if (prohibited.has('push') || prohibited.has('merge') || prohibited.has('publish')) denied('task contract prohibits publication');
  if (input.title.length < 1 || input.title.length > 256 || input.body.length > 16_384 || /[\u0000-\u001f\u007f]/.test(input.title)) denied('pull request metadata is invalid');
  return { branch: `codex/auto/${input.contract.run_id}`, policyHash };
}

export async function skipFinalizedRunPublicationV4(input: Pick<PublishFinalizedRunInputV4, 'contract' | 'finalized' | 'policy' | 'expected_policy_hash' | 'append_publication_event'>): Promise<void> {
  const policyHash = publicationIdentity(input.contract, input.finalized, input.policy, input.expected_policy_hash);
  const prohibited = new Set(input.contract.prohibited_actions.map((value) => value.toLocaleLowerCase('en-US')));
  const reason = !input.policy.publication.enabled ? 'POLICY_DISABLED' : prohibited.has('push') || prohibited.has('merge') || prohibited.has('publish') ? 'CONTRACT_PROHIBITED' : null;
  if (reason === null) denied('publication is required by policy and contract');
  await input.append_publication_event({ type: 'PUBLICATION_SKIPPED', command_id: `publication-skipped:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, publication_policy_hash: policyHash, reason });
}

export async function publishFinalizedRunV4(input: PublishFinalizedRunInputV4): Promise<PublishedRunV4> {
  const { branch, policyHash } = verify(input);
  const runLock = await input.acquire_run_lock();
  let repositoryLock: FinalizationLockV4 | undefined;
  try {
    repositoryLock = await input.acquire_repository_lock();
    const pushed = await input.adapter.pushExact({ commit_sha: input.finalized.commit_sha, branch, remote: input.policy.publication.remote });
    if (pushed.remote_sha !== input.finalized.commit_sha) failed('remote branch does not resolve to the accepted commit');
    await input.append_publication_event({ type: 'BRANCH_PUSHED', command_id: `branch-pushed:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, branch, remote: input.policy.publication.remote, publication_policy_hash: policyHash });
    let pullRequest = await input.adapter.findPullRequest({ head_branch: branch, base_branch: input.policy.publication.baseBranch });
    if (pullRequest === null) pullRequest = await input.adapter.createPullRequest({ head_branch: branch, base_branch: input.policy.publication.baseBranch, title: input.title, body: input.body });
    if (pullRequest.head_sha !== input.finalized.commit_sha || pullRequest.head_branch !== branch || pullRequest.base_branch !== input.policy.publication.baseBranch) failed('pull request identity differs from the accepted commit');
    await input.append_publication_event({ type: 'PULL_REQUEST_RECORDED', command_id: `pull-request-recorded:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, pull_request: pullRequest.number, pull_request_url: pullRequest.url, base_branch: pullRequest.base_branch, publication_policy_hash: policyHash });
    if (pullRequest.state !== 'MERGED') {
      if (input.policy.publication.requireRequiredChecks) {
        await input.adapter.waitForRequiredChecks({ pull_request: pullRequest.number, timeout_seconds: input.policy.publication.timeoutSeconds });
        await input.append_publication_event({ type: 'REQUIRED_CHECKS_PASSED', command_id: `required-checks-passed:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, pull_request: pullRequest.number, publication_policy_hash: policyHash });
      }
      pullRequest = await input.adapter.mergePullRequest({ pull_request: pullRequest.number, head_sha: input.finalized.commit_sha, method: input.policy.publication.mergeMethod, timeout_seconds: input.policy.publication.timeoutSeconds });
    }
    if (pullRequest.state !== 'MERGED' || pullRequest.head_sha !== input.finalized.commit_sha || pullRequest.merge_commit_sha === null || !SHA1.test(pullRequest.merge_commit_sha)) failed('merge result is missing or stale');
    await input.append_publication_event({ type: 'RUN_MERGED', command_id: `run-merged:${input.contract.run_id}`, run_id: input.contract.run_id, commit_sha: input.finalized.commit_sha, pull_request: pullRequest.number, pull_request_url: pullRequest.url, merge_commit_sha: pullRequest.merge_commit_sha, publication_policy_hash: policyHash });
    return Object.freeze({ ...pullRequest, run_id: input.contract.run_id, local_commit_sha: input.finalized.commit_sha });
  } finally {
    await repositoryLock?.release().catch(() => undefined);
    await runLock.release().catch(() => undefined);
  }
}
