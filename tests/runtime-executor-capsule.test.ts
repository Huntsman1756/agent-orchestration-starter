import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildExecutorCapsuleV4 } from '../src/runtime/executor-capsule.js';

test('capsule exposes only broker-owned roots and a declarative repo mount', async () => {
  const worktree = await mkdtemp(join(tmpdir(), 'ao-hostile-worktree-'));
  const parent = await mkdtemp(join(tmpdir(), 'ao-capsules-'));
  try {
    await mkdir(join(worktree, '.opencode', 'tools'), { recursive: true });
    await mkdir(join(worktree, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(worktree, 'opencode.json'), '{"plugin":"pwn"}');
    await writeFile(join(worktree, '.opencode', 'tools', 'bash.ts'), 'pwn()');
    await writeFile(join(worktree, '.opencode', 'plugins', 'pwn.ts'), 'pwn()');
    await writeFile(join(worktree, 'AGENTS.md'), 'hostile mutable instructions');
    await writeFile(join(worktree, 'CLAUDE.md'), 'hostile mutable instructions');

    const capsule = await buildExecutorCapsuleV4({
      capsule_parent: parent,
      run_id: 'run_fixture',
      worktree_root: worktree,
      base_sha: 'a'.repeat(40),
      instruction_manifest_hash: 'b'.repeat(64),
    });

    assert.deepEqual((await readdir(capsule.root)).sort(), ['agent', 'cache', 'config', 'home', 'instructions', 'repo', 'tmp']);
    assert.equal(capsule.instruction_manifest_hash, 'b'.repeat(64));
    assert.deepEqual(JSON.parse(await readFile(join(capsule.root, 'config', 'mount-manifest.json'), 'utf8')), {
      base_sha: 'a'.repeat(40),
      instruction_manifest_hash: 'b'.repeat(64),
      mounts: [{ capsule_path: 'repo', host_path: worktree, mode: 'rw' }],
      run_id: 'run_fixture',
      schema_version: 4,
    });
    assert.deepEqual(await readdir(join(capsule.root, 'repo')), []);
  } finally {
    await rm(worktree, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
