import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { EconomyPolicyViolationErrorV4, enforceDiffPolicy, interceptEconomyDiffV4 } from '../src/runtime/diff-policy.js';
import { createEconomyPolicyRepairPacketV4 } from '../src/runtime/repair-packet.js';

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...argv: string[]) => (await execFileAsync('git', ['-C', repo, ...argv], { encoding: 'utf8' })).stdout.trim();

async function fixtureRepository(): Promise<{ root: string; baseSha: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ao-diff-'));
  await execFileAsync('git', ['init', '-b', 'main', root]);
  await git(root, 'config', 'user.email', 'runner@example.invalid');
  await git(root, 'config', 'user.name', 'Runner Fixture');
  await writeFile(join(root, 'modify.txt'), 'one\ntwo\n');
  await writeFile(join(root, 'delete.txt'), 'delete\n');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests', 'acceptance.test.ts'), 'assert.equal(greeting(), \'hello\');\n');
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

test('red-team economy diff cannot modify an immutable acceptance test and carries a repair instruction', async () => {
  const fixture = await fixtureRepository();
  try {
    await writeFile(join(fixture.root, 'tests', 'acceptance.test.ts'), 'assert.equal(greeting(), \'tampered\');\n');
    await assert.rejects(
      () => interceptEconomyDiffV4({
        repository_root: fixture.root,
        base_sha: fixture.baseSha,
        acceptance_tests: ['tests/acceptance.test.ts'],
        implementation_targets: [{ path: 'modify.txt', operations: ['MODIFY'] }],
        max_files_changed: 1,
        max_changed_lines: 20,
      }),
      (error: unknown) => error instanceof EconomyPolicyViolationErrorV4
        && error.code === 'ECONOMY_POLICY_VIOLATION'
        && error.violation_path === 'tests/acceptance.test.ts'
        && /Intentaste modificar los tests de aceptación/.test(error.repair_instruction),
    );
    await assert.rejects(
      () => interceptEconomyDiffV4({
        repository_root: fixture.root,
        base_sha: fixture.baseSha,
        acceptance_tests: ['tests/acceptance.test.ts'],
        implementation_targets: [{ path: 'modify.txt', operations: ['MODIFY'] }],
        max_files_changed: 1,
        max_changed_lines: 20,
      }),
      (error: unknown) => {
        if (!(error instanceof EconomyPolicyViolationErrorV4)) return false;
        const packet = createEconomyPolicyRepairPacketV4({ story_id: 'story_economy_policy', failed_attempt: 1, violation: error });
        return packet.findings[0]?.instruction === error.repair_instruction
          && packet.findings[0]?.category_code === 'economy_policy_violation';
      },
    );
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
