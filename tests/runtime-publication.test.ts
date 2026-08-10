import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import type { FinalizedRunV4 } from '../src/runtime/finalize.js';
import { loadRuntimeRepositoryPolicyV4 } from '../src/runtime/load.js';
import { publishFinalizedRunV4, skipFinalizedRunPublicationV4, type PublicationAdapterV4, type PublicationProgressEventV4, type PullRequestV4 } from '../src/runtime/publication.js';
import { validRepositoryPolicy, validWorkContract } from './runtime-contracts.test.js';

const commitSha = '9'.repeat(40);
const mergeSha = '8'.repeat(40);

function fixture(existing: PullRequestV4 | null = null) {
  const policy = loadRuntimeRepositoryPolicyV4(validRepositoryPolicy());
  const policyHash = hashCanonicalV4(policy);
  const source = validWorkContract();
  const body = { ...source, policy_hash: policyHash, prohibited_actions: ['deploy'] } as Record<string, unknown>;
  delete body.contract_hash;
  const contract = { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
  const finalized: FinalizedRunV4 = { run_id: contract.run_id, task_ref: `refs/heads/codex/auto/${contract.run_id}`, commit_sha: commitSha, git_tree_sha: '7'.repeat(40), evidence_tree_hash: contract.route_decision_hash, diff_hash: '6'.repeat(64), review_attestation_hash: '5'.repeat(64) };
  const branch = `codex/auto/${contract.run_id}`;
  const open: PullRequestV4 = { number: 17, url: 'https://github.com/acme/repo/pull/17', state: 'OPEN', head_sha: commitSha, head_branch: branch, base_branch: 'main', merge_commit_sha: null };
  const merged: PullRequestV4 = { ...open, state: 'MERGED', merge_commit_sha: mergeSha };
  const calls: string[] = [];
  const events: PublicationProgressEventV4[] = [];
  const adapter: PublicationAdapterV4 = {
    pushExact: async (input) => { calls.push(`push:${input.commit_sha}:${input.branch}:${input.remote}`); return { remote_sha: input.commit_sha }; },
    findPullRequest: async () => { calls.push('find'); return existing; },
    createPullRequest: async () => { calls.push('create'); return open; },
    waitForRequiredChecks: async () => { calls.push('checks'); },
    mergePullRequest: async () => { calls.push('merge'); return merged; },
  };
  const releases: string[] = [];
  return { calls, events, releases, contract, policy, policyHash, finalized, open, merged, input: {
    contract, policy, finalized, expected_policy_hash: policyHash, title: 'Automated accepted change', body: 'Validated and independently reviewed.', adapter,
    acquire_run_lock: async () => ({ release: async () => { releases.push('run'); } }),
    acquire_repository_lock: async () => ({ release: async () => { releases.push('repository'); } }),
    append_publication_event: async (event: PublicationProgressEventV4) => { events.push(event); },
  } };
}

test('pushes the accepted commit, creates an exact PR, waits for required checks, merges, and journals', async () => {
  const value = fixture();
  const result = await publishFinalizedRunV4(value.input);
  assert.deepEqual(value.calls, [`push:${commitSha}:codex/auto/${value.contract.run_id}:origin`, 'find', 'create', 'checks', 'merge']);
  assert.equal(result.merge_commit_sha, mergeSha);
  assert.deepEqual(value.releases, ['repository', 'run']);
  assert.deepEqual(value.events.map((event) => event.type), ['BRANCH_PUSHED', 'PULL_REQUEST_RECORDED', 'REQUIRED_CHECKS_PASSED', 'RUN_MERGED']);
  assert.deepEqual(value.events.at(-1), { type: 'RUN_MERGED', command_id: `run-merged:${value.contract.run_id}`, run_id: value.contract.run_id, commit_sha: commitSha, pull_request: 17, pull_request_url: value.merged.url, merge_commit_sha: mergeSha, publication_policy_hash: value.policyHash });
});

test('recovers idempotently from an already merged exact PR', async () => {
  const prior = fixture().merged;
  const value = fixture(prior);
  await publishFinalizedRunV4(value.input);
  assert.deepEqual(value.calls, [`push:${commitSha}:codex/auto/${value.contract.run_id}:origin`, 'find']);
  assert.deepEqual(value.events.map((event) => event.type), ['BRANCH_PUSHED', 'PULL_REQUEST_RECORDED', 'RUN_MERGED']);
});

test('fails closed on disabled or stale policy, prohibited publication, and stale PR identity', async () => {
  const disabled = fixture();
  await assert.rejects(publishFinalizedRunV4({ ...disabled.input, policy: { ...disabled.policy, publication: { ...disabled.policy.publication, enabled: false } } }), /PUBLICATION_POLICY_DENIED/);
  const stale = fixture();
  await assert.rejects(publishFinalizedRunV4({ ...stale.input, expected_policy_hash: '0'.repeat(64) }), /PUBLICATION_POLICY_DENIED/);
  const prohibited = fixture();
  const body = { ...prohibited.contract, prohibited_actions: ['push'] } as Record<string, unknown>;
  delete body.contract_hash;
  await assert.rejects(publishFinalizedRunV4({ ...prohibited.input, contract: { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4 }), /PUBLICATION_POLICY_DENIED/);
  const wrong = fixture({ ...fixture().open, head_sha: '1'.repeat(40) });
  await assert.rejects(publishFinalizedRunV4(wrong.input), /PUBLICATION_FAILED/);
});

test('releases both locks when publication fails', async () => {
  const value = fixture();
  value.input.adapter.pushExact = async () => { throw new Error('PUBLICATION_FAILED: offline'); };
  await assert.rejects(publishFinalizedRunV4(value.input), /PUBLICATION_FAILED/);
  assert.deepEqual(value.releases, ['repository', 'run']);
});

test('records an explicit terminal skip only when policy or contract prohibits publication', async () => {
  const disabled = fixture();
  const policy = loadRuntimeRepositoryPolicyV4({ ...validRepositoryPolicy(), publication: { ...validRepositoryPolicy().publication, enabled: false } });
  const policyHash = hashCanonicalV4(policy);
  const body = { ...disabled.contract, policy_hash: policyHash } as Record<string, unknown>;
  delete body.contract_hash;
  const contract = { ...body, contract_hash: hashCanonicalV4(body) } as unknown as RuntimeWorkContractV4;
  await skipFinalizedRunPublicationV4({ ...disabled.input, contract, finalized: { ...disabled.finalized, run_id: contract.run_id, task_ref: `refs/heads/codex/auto/${contract.run_id}` }, policy, expected_policy_hash: policyHash });
  assert.equal(disabled.events.at(-1)?.type, 'PUBLICATION_SKIPPED');
  const required = fixture();
  await assert.rejects(skipFinalizedRunPublicationV4(required.input), /PUBLICATION_POLICY_DENIED/);
});
