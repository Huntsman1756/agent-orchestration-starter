import { runBoundedProcessV4, type BoundedProcessResultV4 } from './bounded-process.js';
import type { PublicationAdapterV4, PullRequestV4 } from './publication.js';
import { isAbsolute } from 'node:path';

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA1 = /^[a-f0-9]{40}$/;

export interface GithubPublicationDependenciesV4 {
  readonly repository_root: string;
  readonly repository: string;
  readonly remote: string;
  readonly empty_hooks_directory: string;
  readonly empty_global_config: string;
  readonly run?: (executable: string, argv: readonly string[], timeout_ms: number) => Promise<BoundedProcessResultV4>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function failure(message: string): never {
  throw new Error(`PUBLICATION_FAILED: ${message}`);
}
function environment(emptyGlobalConfig: string): NodeJS.ProcessEnv {
  const names = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'GH_CONFIG_DIR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ] as const;
  const env: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    LC_ALL: 'C',
  };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function parsePullRequest(stdout: string, repository: string): PullRequestV4 {
  let value: any;
  try {
    value = JSON.parse(stdout);
  } catch {
    return failure('GitHub returned invalid JSON');
  }
  const state = value.state === 'MERGED' ? 'MERGED' : value.state === 'OPEN' ? 'OPEN' : null;
  const merge = value.mergeCommit?.oid ?? null;
  if (
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    value.url !== `https://github.com/${repository}/pull/${String(value.number)}` ||
    state === null ||
    !SHA1.test(value.headRefOid) ||
    typeof value.headRefName !== 'string' ||
    typeof value.baseRefName !== 'string' ||
    (merge !== null && !SHA1.test(merge))
  )
    failure('GitHub pull request identity is invalid');
  return Object.freeze({
    number: value.number,
    url: value.url,
    state,
    head_sha: value.headRefOid,
    head_branch: value.headRefName,
    base_branch: value.baseRefName,
    merge_commit_sha: merge,
  });
}

export function createGithubPublicationAdapterV4(deps: GithubPublicationDependenciesV4): PublicationAdapterV4 {
  if (
    !REPOSITORY.test(deps.repository) ||
    deps.repository.includes('..') ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(deps.remote) ||
    deps.remote.includes('..') ||
    !isAbsolute(deps.repository_root) ||
    !isAbsolute(deps.empty_hooks_directory) ||
    !isAbsolute(deps.empty_global_config) ||
    [deps.repository_root, deps.empty_hooks_directory, deps.empty_global_config].some((value) => value.includes('\0'))
  )
    failure('GitHub adapter configuration is invalid');
  const execute =
    deps.run ??
    (async (executable, argv, timeout) =>
      await runBoundedProcessV4({
        executable,
        argv,
        environment: environment(deps.empty_global_config),
        deadline_ms: timeout,
        max_output_bytes: 2 * 1024 * 1024,
      }));
  const run = async (executable: string, argv: readonly string[], timeout = 120_000): Promise<string> => {
    const result = await execute(executable, argv, timeout);
    if (result.exit_code !== 0 || result.termination !== null || result.stdout_truncated || result.stderr_truncated)
      failure(`${executable} command failed`);
    return result.stdout.trim();
  };
  const git = async (argv: readonly string[], timeout?: number) =>
    await run(
      'git',
      [
        '-c',
        `core.hooksPath=${deps.empty_hooks_directory}`,
        '-c',
        `include.path=${deps.empty_global_config}`,
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'submodule.recurse=false',
        ...argv,
      ],
      timeout,
    );
  const fields = 'number,url,state,headRefOid,headRefName,baseRefName,mergeCommit';
  const view = async (number: number, timeout?: number) =>
    parsePullRequest(
      await run('gh', ['pr', 'view', String(number), '--repo', deps.repository, '--json', fields], timeout),
      deps.repository,
    );
  return Object.freeze({
    pushExact: async ({ commit_sha, branch, remote }: { commit_sha: string; branch: string; remote: string }) => {
      if (!SHA1.test(commit_sha) || !/^codex\/auto\/run_[A-Za-z0-9_-]{16,96}$/.test(branch) || remote !== deps.remote)
        failure('push identity is invalid');
      const url = `https://github.com/${deps.repository}.git`;
      await git(['-C', deps.repository_root, 'push', '--porcelain', '--no-verify', url, `${commit_sha}:refs/heads/${branch}`]);
      const remoteSha = await git(['-C', deps.repository_root, 'ls-remote', '--exit-code', url, `refs/heads/${branch}`]);
      const sha = remoteSha.split(/\s+/)[0] ?? '';
      if (sha !== commit_sha) failure('pushed branch verification failed');
      return Object.freeze({ remote_sha: sha });
    },
    findPullRequest: async ({ head_branch, base_branch }: { head_branch: string; base_branch: string }) => {
      const output = await run('gh', [
        'pr',
        'list',
        '--repo',
        deps.repository,
        '--head',
        head_branch,
        '--base',
        base_branch,
        '--state',
        'all',
        '--limit',
        '2',
        '--json',
        fields,
      ]);
      let values: unknown;
      try {
        values = JSON.parse(output);
      } catch {
        return failure('GitHub returned invalid pull request list');
      }
      if (!Array.isArray(values) || values.length > 1) failure('pull request identity is ambiguous');
      return values.length === 0 ? null : parsePullRequest(JSON.stringify(values[0]), deps.repository);
    },
    createPullRequest: async ({
      head_branch,
      base_branch,
      title,
      body,
    }: {
      head_branch: string;
      base_branch: string;
      title: string;
      body: string;
    }) => {
      const url = await run('gh', [
        'pr',
        'create',
        '--repo',
        deps.repository,
        '--head',
        head_branch,
        '--base',
        base_branch,
        '--title',
        title,
        '--body',
        body,
        '--no-maintainer-edit',
      ]);
      const match = /\/pull\/(\d+)$/.exec(url);
      if (match === null) failure('GitHub did not return a pull request URL');
      return await view(Number(match[1]));
    },
    waitForRequiredChecks: async ({ pull_request, timeout_seconds }: { pull_request: number; timeout_seconds: number }) => {
      await run(
        'gh',
        ['pr', 'checks', String(pull_request), '--repo', deps.repository, '--required', '--watch', '--fail-fast', '--interval', '10'],
        timeout_seconds * 1_000,
      );
    },
    mergePullRequest: async ({
      pull_request,
      head_sha,
      method,
      timeout_seconds,
    }: {
      pull_request: number;
      head_sha: string;
      method: 'squash' | 'merge' | 'rebase';
      timeout_seconds: number;
    }) => {
      await run('gh', ['pr', 'merge', String(pull_request), '--repo', deps.repository, `--${method}`, '--match-head-commit', head_sha]);
      const deadline = Date.now() + timeout_seconds * 1_000;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining < 1) failure('merge did not reach a verified terminal state before the deadline');
        const current = await view(pull_request, Math.min(120_000, remaining));
        if (current.state === 'MERGED') return current;
        await (deps.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(
          Math.min(2_000, Math.max(1, deadline - Date.now())),
        );
      }
    },
  });
}
