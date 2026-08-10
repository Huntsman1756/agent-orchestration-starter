import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildInstructionBundle } from '../src/runtime/instruction-bundle.js';

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...argv: string[]) => (await execFileAsync('git', ['-C', repo, ...argv], { encoding: 'utf8' })).stdout.trim();

test('copies only approved instructions from the frozen base tree and hashes every byte', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ao-instructions-repo-'));
  const output = await mkdtemp(join(tmpdir(), 'ao-instructions-out-'));
  try {
    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git(repo, 'config', 'user.email', 'runner@example.invalid');
    await git(repo, 'config', 'user.name', 'Runner Fixture');
    await writeFile(join(repo, 'AGENTS.md'), 'frozen broker-approved instructions\n');
    await writeFile(join(repo, 'CLAUDE.md'), 'not approved\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    const baseSha = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'AGENTS.md'), 'hostile mutable replacement\n');

    const bundle = await buildInstructionBundle({
      repository_root: repo,
      base_sha: baseSha,
      approved_sources: ['AGENTS.md'],
      output_root: output,
      max_total_bytes: 4096,
    });

    assert.equal(bundle.entries.length, 1);
    assert.equal(bundle.entries[0]?.source_path, 'AGENTS.md');
    assert.equal(bundle.entries[0]?.content_hash, createHash('sha256').update('frozen broker-approved instructions\n').digest('hex'));
    assert.equal(await readFile(join(output, bundle.entries[0]!.capsule_path), 'utf8'), 'frozen broker-approved instructions\n');
    assert.equal(bundle.manifest_hash.length, 64);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('fails closed on symbolic base revisions and oversized instruction text', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ao-instructions-repo-'));
  const output = await mkdtemp(join(tmpdir(), 'ao-instructions-out-'));
  try {
    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git(repo, 'config', 'user.email', 'runner@example.invalid');
    await git(repo, 'config', 'user.name', 'Runner Fixture');
    await writeFile(join(repo, 'AGENTS.md'), 'too large');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');
    const baseSha = await git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(() => buildInstructionBundle({ repository_root: repo, base_sha: 'HEAD', approved_sources: ['AGENTS.md'], output_root: output }), /OUT_OF_SCOPE_CHANGE/);
    await assert.rejects(() => buildInstructionBundle({ repository_root: repo, base_sha: baseSha, approved_sources: ['AGENTS.md'], output_root: output, max_total_bytes: 3 }), /OUT_OF_SCOPE_CHANGE/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});
