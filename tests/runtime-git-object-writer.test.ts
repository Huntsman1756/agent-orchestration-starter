import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createGitObjectWriter, type GitPlumbingInvocationV4 } from '../src/runtime/git-object-writer.js';

const exec = promisify(execFile);
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'git');

async function git(root: string, ...argv: string[]): Promise<string> {
  return (await exec('git', argv, { cwd: root, encoding: 'utf8', windowsHide: true })).stdout.trim();
}

async function fixtureRepository(): Promise<{ root: string; base: string; emptyConfig: string; emptyHooks: string; sentinels: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'runner-v4-git-writer-'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'base.txt'), 'base\n');
  await git(root, 'add', 'base.txt');
  await git(root, 'commit', '-m', 'base');
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'branch', 'do-not-touch', base);
  await git(root, 'branch', 'codex/auto/run-test', base);
  await git(root, 'branch', 'codex/auto/stale', base);

  const sentinels = [join(root, 'hook-sentinel'), join(root, 'filter-sentinel'), join(root, 'global-sentinel')];
  const hooks = join(root, '.hostile-hooks');
  await mkdir(hooks);
  await copyFile(join(fixtureRoot, 'hooks', 'pre-commit'), join(hooks, 'pre-commit'));
  await copyFile(join(fixtureRoot, 'hooks', 'commit-msg'), join(hooks, 'commit-msg'));
  await copyFile(join(fixtureRoot, 'hooks', 'reference-transaction'), join(hooks, 'reference-transaction'));
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await chmod(join(hooks, 'commit-msg'), 0o755);
  await chmod(join(hooks, 'reference-transaction'), 0o755);
  await git(root, 'config', 'core.hooksPath', hooks);
  await git(root, 'config', 'filter.hostile.clean', `node "${join(fixtureRoot, 'filters', 'hostile-filter.mjs')}" "${sentinels[1]}"`);
  await git(root, 'config', 'filter.hostile.smudge', `node "${join(fixtureRoot, 'filters', 'hostile-filter.mjs')}" "${sentinels[1]}"`);
  await git(root, 'config', 'commit.gpgSign', 'true');
  await git(root, 'config', 'credential.helper', `!node -e "require('fs').writeFileSync('${sentinels[2].replaceAll('\\', '\\\\')}','credential')"`);
  await git(root, 'config', 'alias.commit', `!node -e "require('fs').writeFileSync('${sentinels[0].replaceAll('\\', '\\\\')}','alias')"`);
  await writeFile(join(root, '.gitattributes'), '*.txt filter=hostile\n');
  const emptyConfig = join(root, 'empty-global-config');
  const emptyHooks = join(root, 'empty-hooks');
  await writeFile(emptyConfig, '');
  await mkdir(emptyHooks);
  return { root, base, emptyConfig, emptyHooks, sentinels };
}

test('writes and commits exact accepted bytes without invoking hooks, filters, aliases, signing, or the active worktree', async (context) => {
  const fixture = await fixtureRepository();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const writer = createGitObjectWriter({ repository_root: fixture.root, empty_global_config: fixture.emptyConfig, empty_hooks_directory: fixture.emptyHooks });
  const statusBefore = await git(fixture.root, 'status', '--porcelain=v1');
  const headBefore = await git(fixture.root, 'rev-parse', 'HEAD');
  const otherBefore = await git(fixture.root, 'rev-parse', 'refs/heads/do-not-touch');
  const configBefore = await readFile(join(fixture.root, '.git', 'config'));
  const indexBefore = await readFile(join(fixture.root, '.git', 'index'));
  const activeBytesBefore = await readFile(join(fixture.root, 'base.txt'));
  for (const sentinel of fixture.sentinels) await unlink(sentinel).catch(() => undefined);
  const entries = [
    { path: '.gitattributes', mode: '100644' as const, bytes: Buffer.from('*.txt filter=hostile\n') },
    { path: 'base.txt', mode: '100644' as const, bytes: Buffer.from('base\n') },
    { path: 'src/new.txt', mode: '100644' as const, bytes: Buffer.from('accepted bytes\n') },
  ];

  const tree = await writer.writeAcceptedTree({ entries });
  const commit = await writer.createCommit({ tree_sha: tree.tree_sha, base_sha: fixture.base, message: 'accepted result', author_name: 'Runner V4', author_email: 'runner@example.invalid', authored_at: '2026-08-10T12:00:00Z' });
  await writer.updateTaskRef({ task_ref: 'refs/heads/codex/auto/run-test', new_commit_sha: commit.commit_sha, expected_old_sha: fixture.base });

  for (const sentinel of fixture.sentinels) await assert.rejects(readFile(sentinel), /ENOENT/);
  assert.equal(await git(fixture.root, 'rev-parse', 'refs/heads/codex/auto/run-test'), commit.commit_sha);
  assert.equal(await git(fixture.root, 'rev-parse', `${commit.commit_sha}^{tree}`), tree.tree_sha);
  assert.equal((await exec('git', ['show', `${commit.commit_sha}:src/new.txt`], { cwd: fixture.root, encoding: 'utf8' })).stdout, 'accepted bytes\n');
  assert.equal(await git(fixture.root, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(statusBefore.includes('base.txt'), false);
  assert.deepEqual(await readFile(join(fixture.root, '.git', 'index')), indexBefore);
  assert.deepEqual(await readFile(join(fixture.root, 'base.txt')), activeBytesBefore);
  assert.equal(await git(fixture.root, 'rev-parse', 'refs/heads/do-not-touch'), otherBefore);
  assert.deepEqual(await readFile(join(fixture.root, '.git', 'config')), configBefore);
});

test('fails closed for stale refs, non-task refs, unsupported modes, and non-sha1 repositories', async (context) => {
  const fixture = await fixtureRepository();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const writer = createGitObjectWriter({ repository_root: fixture.root, empty_global_config: fixture.emptyConfig, empty_hooks_directory: fixture.emptyHooks });
  const tree = await writer.writeAcceptedTree({ entries: [{ path: 'base.txt', mode: '100644', bytes: Buffer.from('base\n') }] });
  const commit = await writer.createCommit({ tree_sha: tree.tree_sha, base_sha: fixture.base, message: 'accepted', author_name: 'Runner', author_email: 'runner@example.invalid', authored_at: '2026-08-10T12:00:00Z' });
  await assert.rejects(writer.updateTaskRef({ task_ref: 'refs/heads/main', new_commit_sha: commit.commit_sha, expected_old_sha: fixture.base }), /FINALIZATION_ISOLATION_FAILED/);
  await assert.rejects(writer.updateTaskRef({ task_ref: 'refs/heads/codex/auto/stale', new_commit_sha: commit.commit_sha, expected_old_sha: '0'.repeat(40) }), /FINALIZATION_FAILED/);
  await assert.rejects(writer.writeAcceptedTree({ entries: [{ path: 'device', mode: '120000' as '100644', bytes: Buffer.from('x') }] }), /FINALIZATION_ISOLATION_FAILED/);

  const invocations: GitPlumbingInvocationV4[] = [];
  const incompatible = createGitObjectWriter({
    repository_root: fixture.root,
    empty_global_config: fixture.emptyConfig,
    empty_hooks_directory: fixture.emptyHooks,
    run_git: async (input) => { invocations.push(input); return { stdout: Buffer.from('sha256\n'), stderr: Buffer.alloc(0), exit_code: 0 }; },
  });
  await assert.rejects(incompatible.writeAcceptedTree({ entries: [] }), /object format/);
  assert.deepEqual(invocations[0]?.argv, ['rev-parse', '--show-object-format']);
  assert.equal(invocations[0]?.environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(invocations[0]?.environment.GIT_CONFIG_GLOBAL, fixture.emptyConfig);
});

test('uses exact audited plumbing argv and stdin rather than a shell', async () => {
  const calls: GitPlumbingInvocationV4[] = [];
  const outputs = ['sha1\n', `${'1'.repeat(40)}\n`, `${'2'.repeat(40)}\n`, `${'3'.repeat(40)}\n`, `${'4'.repeat(40)}\n`, '', `${'4'.repeat(40)}\n`, `${'3'.repeat(40)}\n`];
  const writer = createGitObjectWriter({
    repository_root: 'unused', empty_global_config: 'empty', empty_hooks_directory: 'empty-hooks',
    run_git: async (input) => ({ stdout: Buffer.from(outputs[calls.push(input) - 1]!), stderr: Buffer.alloc(0), exit_code: 0 }),
  });
  const tree = await writer.writeAcceptedTree({ entries: [{ path: 'src/x.ts', mode: '100644', bytes: Buffer.from('x') }] });
  const commit = await writer.createCommit({ tree_sha: tree.tree_sha, base_sha: '4'.repeat(40), message: 'm', author_name: 'n', author_email: 'a@b', authored_at: '2026-08-10T12:00:00Z' });
  await writer.updateTaskRef({ task_ref: 'refs/heads/codex/auto/run', new_commit_sha: commit.commit_sha, expected_old_sha: '4'.repeat(40) });
  assert.deepEqual(calls.map((call) => call.argv), [
    ['rev-parse', '--show-object-format'], ['hash-object', '-w', '--no-filters', '--stdin'], ['mktree', '-z'], ['mktree', '-z'],
    ['commit-tree', '3'.repeat(40), '-p', '4'.repeat(40)], ['update-ref', 'refs/heads/codex/auto/run', '4'.repeat(40), '4'.repeat(40)],
    ['rev-parse', '--verify', 'refs/heads/codex/auto/run'], ['rev-parse', '--verify', `${'4'.repeat(40)}^{tree}`],
  ]);
  assert.equal(Buffer.from(calls[1]!.stdin).toString(), 'x');
  assert.equal(calls[4]!.environment.HOME, undefined);
  assert.equal(calls[4]!.environment.GIT_CONFIG_COUNT, '1');
  assert.equal(calls[4]!.environment.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.equal(calls[4]!.environment.GIT_CONFIG_VALUE_0, 'empty-hooks');
});
