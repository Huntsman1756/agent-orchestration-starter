import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderProject } from '../src/core/render.js';
import { resolvedPolicy } from './fixtures.js';

async function target(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agent-orchestration-render-'));
}

test('does not overwrite an unmanaged existing file', async () => {
  const directory = await target();
  const path = join(directory, '.codex', 'agents', 'executor.toml');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(directory, '.codex', 'agents'), { recursive: true }));
  await writeFile(path, 'user-owned\n', 'utf8');

  const report = await renderProject({ targetDir: directory, policy: resolvedPolicy(), harnesses: ['codex'] });

  assert.deepEqual(report.conflicts, [{ path: '.codex/agents/executor.toml', reason: 'unmanaged' }]);
  assert.equal(await readFile(path, 'utf8'), 'user-owned\n');
});

test('protects a locally modified managed file unless that exact path is forced', async () => {
  const directory = await target();
  await renderProject({ targetDir: directory, policy: resolvedPolicy(), harnesses: ['codex'] });
  const path = join(directory, '.codex', 'agents', 'executor.toml');
  await writeFile(path, 'local edit\n', 'utf8');

  const blocked = await renderProject({ targetDir: directory, policy: resolvedPolicy(), harnesses: ['codex'] });
  assert.deepEqual(blocked.conflicts, [{ path: '.codex/agents/executor.toml', reason: 'locally-modified' }]);
  assert.equal(await readFile(path, 'utf8'), 'local edit\n');

  const forced = await renderProject({
    targetDir: directory,
    policy: resolvedPolicy(),
    harnesses: ['codex'],
    forcePaths: ['.codex/agents/executor.toml'],
  });
  assert.equal(forced.conflicts.length, 0);
  assert.match(await readFile(path, 'utf8'), /model = "economy-code"/);
});

test('dry run reports planned files without writing them', async () => {
  const directory = await target();

  const report = await renderProject({ targetDir: directory, policy: resolvedPolicy(), harnesses: ['opencode'], dryRun: true });

  assert.ok(report.created.includes('.opencode/agents/executor.md'));
  await assert.rejects(readFile(join(directory, '.opencode', 'agents', 'executor.md'), 'utf8'), /ENOENT/);
});
