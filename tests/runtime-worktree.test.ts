import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { createWorktreeManagerV4 } from '../src/runtime/worktree.js';

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...argv: string[]) => (await execFileAsync('git', ['-C', repo, ...argv], { encoding: 'utf8' })).stdout.trim();

async function fixtureRepository(): Promise<{ root: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ao-worktree-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await git(root, 'config', 'user.email', 'runner@example.invalid');
  await git(root, 'config', 'user.name', 'Runner Fixture');
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '-m', 'base');
  return { root, baseSha: await git(root, 'rev-parse', 'HEAD') };
}

test('creates an isolated detached worktree without touching a dirty active tree', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  try {
    await writeFile(join(fixture.root, 'tracked.txt'), 'dirty active bytes\n');
    await writeFile(join(fixture.root, 'untracked.txt'), 'must remain\n');
    const before = {
      head: await git(fixture.root, 'rev-parse', 'HEAD'),
      status: await git(fixture.root, 'status', '--porcelain=v2', '-z'),
      tracked: await readFile(join(fixture.root, 'tracked.txt'), 'utf8'),
      untracked: await readFile(join(fixture.root, 'untracked.txt'), 'utf8'),
    };
    const manager = createWorktreeManagerV4({ repository_root: fixture.root, worktree_parent: parent });
    const created = await manager.create({ run_id: 'run_fixture', base_sha: fixture.baseSha } as RuntimeWorkContractV4);

    assert.equal(created.branch, 'codex/auto/run_fixture');
    assert.equal(created.base_sha, fixture.baseSha);
    assert.equal(await git(created.path, 'rev-parse', 'HEAD'), fixture.baseSha);
    assert.deepEqual({
      head: await git(fixture.root, 'rev-parse', 'HEAD'),
      status: await git(fixture.root, 'status', '--porcelain=v2', '-z'),
      tracked: await readFile(join(fixture.root, 'tracked.txt'), 'utf8'),
      untracked: await readFile(join(fixture.root, 'untracked.txt'), 'utf8'),
    }, before);
    assert.equal((await manager.verify(created)).valid, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('rejects a mutable ref or a worktree parent inside the registered repository', async () => {
  const fixture = await fixtureRepository();
  try {
    assert.throws(
      () => createWorktreeManagerV4({ repository_root: fixture.root, worktree_parent: join(fixture.root, '.tasks') }),
      /BROKER_STATE_CORRUPT/,
    );
    const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
    try {
      const manager = createWorktreeManagerV4({ repository_root: fixture.root, worktree_parent: parent });
      await assert.rejects(() => manager.create({ run_id: 'run_symbolic', base_sha: 'HEAD' } as RuntimeWorkContractV4), /OUT_OF_SCOPE_CHANGE/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
