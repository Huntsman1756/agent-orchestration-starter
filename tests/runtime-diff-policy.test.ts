import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { enforceDiffPolicy } from '../src/runtime/diff-policy.js';

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...argv: string[]) => (await execFileAsync('git', ['-C', repo, ...argv], { encoding: 'utf8' })).stdout.trim();

async function fixtureRepository(): Promise<{ root: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ao-diff-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await git(root, 'config', 'user.email', 'runner@example.invalid');
  await git(root, 'config', 'user.name', 'Runner Fixture');
  await writeFile(join(root, 'modify.txt'), 'one\ntwo\n');
  await writeFile(join(root, 'delete.txt'), 'delete\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  return { root, baseSha: await git(root, 'rev-parse', 'HEAD') };
}

test('classifies exact create, modify, and delete paths and emits reproducible hashes', async () => {
  const fixture = await fixtureRepository();
  try {
    await writeFile(join(fixture.root, 'modify.txt'), 'one\nchanged\n');
    await rm(join(fixture.root, 'delete.txt'));
    await writeFile(join(fixture.root, 'M'), 'created\n');
    const input = {
      repository_root: fixture.root,
      base_sha: fixture.baseSha,
      allowed_changes: [
        { path: 'modify.txt', operations: ['MODIFY'] as const },
        { path: 'delete.txt', operations: ['DELETE'] as const },
        { path: 'M', operations: ['CREATE'] as const },
      ],
      max_files_changed: 3,
      max_changed_lines: 20,
    };
    const first = await enforceDiffPolicy(input);
    const second = await enforceDiffPolicy(input);
    assert.deepEqual(first.changes.map(({ path, operation }) => ({ path, operation })), [
      { path: 'M', operation: 'CREATE' },
      { path: 'delete.txt', operation: 'DELETE' },
      { path: 'modify.txt', operation: 'MODIFY' },
    ]);
    assert.equal(first.diff_hash, second.diff_hash);
    assert.equal(first.tree_hash, second.tree_hash);
    assert.equal(first.changed_files, 3);
    assert.equal(first.changed_lines, 4);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects out-of-contract files, symlinks, and limit overruns', async () => {
  const fixture = await fixtureRepository();
  try {
    await writeFile(join(fixture.root, 'unexpected.txt'), 'no');
    await assert.rejects(() => enforceDiffPolicy({
      repository_root: fixture.root,
      base_sha: fixture.baseSha,
      allowed_changes: [{ path: 'modify.txt', operations: ['MODIFY'] }],
      max_files_changed: 1,
      max_changed_lines: 10,
    }), /OUT_OF_SCOPE_CHANGE/);
    await rm(join(fixture.root, 'unexpected.txt'));
    await symlink(join(fixture.root, 'modify.txt'), join(fixture.root, 'link.txt'));
    await assert.rejects(() => enforceDiffPolicy({
      repository_root: fixture.root,
      base_sha: fixture.baseSha,
      allowed_changes: [{ path: 'link.txt', operations: ['CREATE'] }],
      max_files_changed: 1,
      max_changed_lines: 10,
    }), /OUT_OF_SCOPE_CHANGE/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
