import assert from 'node:assert/strict';
import test from 'node:test';

import type { BoundedProcessResultV4 } from '../src/runtime/bounded-process.js';
import { createGithubPublicationAdapterV4 } from '../src/runtime/github-publication.js';

const commitSha = '9'.repeat(40);
const mergeSha = '8'.repeat(40);
const branch = 'codex/auto/run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const pr = (state: 'OPEN' | 'MERGED' = 'OPEN') =>
  JSON.stringify({
    number: 17,
    url: 'https://github.com/acme/repo/pull/17',
    state,
    headRefOid: commitSha,
    headRefName: branch,
    baseRefName: 'main',
    mergeCommit: state === 'MERGED' ? { oid: mergeSha } : null,
  });
const ok = (stdout = ''): BoundedProcessResultV4 => ({
  exit_code: 0,
  signal: null,
  stdout,
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  termination: null,
});

function fixture(outputs: BoundedProcessResultV4[], sleep?: (milliseconds: number) => Promise<void>) {
  const calls: Array<{ executable: string; argv: readonly string[]; timeout: number }> = [];
  const adapter = createGithubPublicationAdapterV4({
    repository_root: '/trusted/repo',
    repository: 'acme/repo',
    remote: 'origin',
    empty_hooks_directory: '/trusted/empty-hooks',
    empty_global_config: '/trusted/empty.gitconfig',
    sleep,
    run: async (executable, argv, timeout) => {
      calls.push({ executable, argv, timeout });
      const output = outputs.shift();
      if (output === undefined) throw new Error('unexpected command');
      return output;
    },
  });
  return { adapter, calls };
}

test('uses sterile Git arguments, an exact SHA refspec, and verifies the remote SHA', async () => {
  const value = fixture([ok('pushed'), ok(`${commitSha}\trefs/heads/${branch}\n`)]);
  await value.adapter.pushExact({ commit_sha: commitSha, branch, remote: 'origin' });
  assert.equal(value.calls.length, 2);
  const push = value.calls[0]!;
  assert.equal(push.executable, 'git');
  assert.ok(push.argv.includes('core.hooksPath=/trusted/empty-hooks'));
  assert.ok(push.argv.includes('credential.helper='));
  assert.ok(push.argv.includes('protocol.ext.allow=never'));
  assert.deepEqual(push.argv.slice(-5), [
    'push',
    '--porcelain',
    '--no-verify',
    'https://github.com/acme/repo.git',
    `${commitSha}:refs/heads/${branch}`,
  ]);
  assert.equal(push.argv.includes('--force'), false);
});

test('creates an exact head/base PR, checks required gates, and binds merge to the head SHA', async () => {
  const value = fixture([ok('https://github.com/acme/repo/pull/17'), ok(pr()), ok(), ok(), ok(pr('MERGED'))]);
  await value.adapter.createPullRequest({ head_branch: branch, base_branch: 'main', title: 'title', body: 'body' });
  await value.adapter.waitForRequiredChecks({ pull_request: 17, timeout_seconds: 90 });
  const merged = await value.adapter.mergePullRequest({ pull_request: 17, head_sha: commitSha, method: 'squash', timeout_seconds: 90 });
  assert.equal(merged.merge_commit_sha, mergeSha);
  assert.deepEqual(value.calls[0]!.argv.slice(0, 12), [
    'pr',
    'create',
    '--repo',
    'acme/repo',
    '--head',
    branch,
    '--base',
    'main',
    '--title',
    'title',
    '--body',
    'body',
  ]);
  assert.ok(value.calls[0]!.argv.includes('--no-maintainer-edit'));
  assert.deepEqual(value.calls[2]!.argv, [
    'pr',
    'checks',
    '17',
    '--repo',
    'acme/repo',
    '--required',
    '--watch',
    '--fail-fast',
    '--interval',
    '10',
  ]);
  assert.deepEqual(value.calls[3]!.argv, ['pr', 'merge', '17', '--repo', 'acme/repo', '--squash', '--match-head-commit', commitSha]);
});

test('rejects ambiguous lists, foreign PR URLs, failed commands, and remote SHA drift', async () => {
  const ambiguous = fixture([ok(`[${pr()},${pr()}]`)]);
  await assert.rejects(ambiguous.adapter.findPullRequest({ head_branch: branch, base_branch: 'main' }), /PUBLICATION_FAILED/);
  const foreign = fixture([ok(JSON.stringify([{ ...JSON.parse(pr()), url: 'https://github.com/other/repo/pull/17' }]))]);
  await assert.rejects(foreign.adapter.findPullRequest({ head_branch: branch, base_branch: 'main' }), /PUBLICATION_FAILED/);
  const failed = fixture([{ ...ok(), exit_code: 1 }]);
  await assert.rejects(failed.adapter.findPullRequest({ head_branch: branch, base_branch: 'main' }), /PUBLICATION_FAILED/);
  const drift = fixture([ok(), ok(`${'1'.repeat(40)}\trefs/heads/${branch}`)]);
  await assert.rejects(drift.adapter.pushExact({ commit_sha: commitSha, branch, remote: 'origin' }), /PUBLICATION_FAILED/);
});

test('waits for a merge queue to produce a verified merge commit', async () => {
  const sleeps: number[] = [];
  const value = fixture([ok(), ok(pr()), ok(pr('MERGED'))], async (milliseconds) => {
    sleeps.push(milliseconds);
  });
  const merged = await value.adapter.mergePullRequest({ pull_request: 17, head_sha: commitSha, method: 'squash', timeout_seconds: 90 });
  assert.equal(merged.state, 'MERGED');
  assert.deepEqual(sleeps, [2_000]);
});
