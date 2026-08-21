import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import { createWorktreeManagerV4 } from '../src/runtime/worktree.js';
import { runCli } from '../src/cli/main.js';

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...argv: string[]) =>
  (await execFileAsync('git', ['-C', repo, ...argv], { encoding: 'utf8' })).stdout.trim();

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

test('creates an isolated owned worktree without touching a dirty active tree', async () => {
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
    assert.match(created.manifest_hash, /^[a-f0-9]{64}$/u);
    assert.equal(await git(created.path, 'branch', '--show-current'), created.branch);
    assert.equal(await git(created.path, 'rev-parse', 'HEAD'), fixture.baseSha);
    const schema = JSON.parse(await readFile(new URL('../contracts/runtime-worktree-record-v4.schema.json', import.meta.url), 'utf8'));
    const validateRecord = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
    const record = JSON.parse(await readFile(join(parent, '.agent-orchestration-worktrees-v4', 'records', 'run_fixture.json'), 'utf8'));
    assert.equal(validateRecord(record), true, JSON.stringify(validateRecord.errors));
    assert.deepEqual(
      {
        head: await git(fixture.root, 'rev-parse', 'HEAD'),
        status: await git(fixture.root, 'status', '--porcelain=v2', '-z'),
        tracked: await readFile(join(fixture.root, 'tracked.txt'), 'utf8'),
        untracked: await readFile(join(fixture.root, 'untracked.txt'), 'utf8'),
      },
      before,
    );
    assert.equal((await manager.verify(created)).valid, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('removes an exactly owned finalized worktree and local branch while retaining a durable tombstone', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  try {
    const manager = createWorktreeManagerV4({ repository_root: fixture.root, worktree_parent: parent });
    const created = await manager.create({ run_id: 'run_finalized', base_sha: fixture.baseSha } as RuntimeWorkContractV4);
    const terminal = await manager.markTerminal(created.run_id, {
      state: 'FINALIZED',
      disposition: 'MERGED',
      recorded_at: '2026-08-21T12:00:00.000Z',
      evidence_hash: 'a'.repeat(64),
    });

    assert.equal(terminal.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_CLEANED');
    await assert.rejects(
      () => access(created.path),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
    await assert.rejects(() => execFileAsync('git', ['-C', fixture.root, 'show-ref', '--verify', `refs/heads/${created.branch}`]));
    assert.equal((await manager.report()).entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_CLEANED');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('retains a dirty failed worktree until expiry and removes only that exact owned path afterwards', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  let now = '2026-08-21T12:00:00.000Z';
  try {
    const manager = createWorktreeManagerV4({
      repository_root: fixture.root,
      worktree_parent: parent,
      now: () => now,
      retention_seconds: { FINALIZED: 0, FAILED: 3600, ABORTED: 3600 },
    });
    const created = await manager.create({ run_id: 'run_failed_dirty', base_sha: fixture.baseSha } as RuntimeWorkContractV4);
    await writeFile(join(created.path, 'uncommitted.txt'), 'diagnostic bytes\n');
    const retained = await manager.markTerminal(created.run_id, {
      state: 'FAILED',
      disposition: 'DISCARD_AFTER_RETENTION',
      recorded_at: now,
      evidence_hash: 'b'.repeat(64),
    });
    assert.equal(retained.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_TERMINAL_RETAINED');
    await access(created.path);

    const unowned = join(parent, 'user-owned-directory');
    await mkdir(unowned);
    now = '2026-08-21T13:00:01.000Z';
    const before = await manager.report();
    assert.equal(before.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_TERMINAL_DIRTY');
    const applied = await manager.reconcile({ mode: 'APPLY', expected_report_hash: before.report_hash });
    assert.equal(applied.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_CLEANED');
    await access(unowned);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('reports unowned directories, rejects stale apply evidence, and enforces active quotas', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  try {
    const manager = createWorktreeManagerV4({
      repository_root: fixture.root,
      worktree_parent: parent,
      quotas: { max_active_worktrees: 1, max_managed_worktrees: 2, max_managed_bytes: 10_000_000 },
    });
    await manager.create({ run_id: 'run_quota_one', base_sha: fixture.baseSha } as RuntimeWorkContractV4);
    await assert.rejects(
      () => manager.create({ run_id: 'run_quota_two', base_sha: fixture.baseSha } as RuntimeWorkContractV4),
      /WORKTREE_CREATION_FAILED: active worktree quota exceeded/u,
    );
    await mkdir(join(parent, 'foreign-folder'));
    const report = await manager.report();
    assert.ok(report.entries.some((entry) => entry.classification === 'UNOWNED'));
    await assert.rejects(
      () => manager.reconcile({ mode: 'APPLY', expected_report_hash: 'f'.repeat(64) }),
      /WORKTREE_CLEANUP_FAILED: report hash changed/u,
    );
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
      await assert.rejects(
        () => manager.create({ run_id: 'run_symbolic', base_sha: 'HEAD' } as RuntimeWorkContractV4),
        /OUT_OF_SCOPE_CHANGE/,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('never deletes a path whose ownership record was altered', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  try {
    const manager = createWorktreeManagerV4({ repository_root: fixture.root, worktree_parent: parent });
    const created = await manager.create({ run_id: 'run_tampered', base_sha: fixture.baseSha } as RuntimeWorkContractV4);
    const recordPath = join(parent, '.agent-orchestration-worktrees-v4', 'records', 'run_tampered.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, `${JSON.stringify({ ...record, base_sha: 'f'.repeat(40) })}\n`);

    const report = await manager.report();
    assert.ok(report.entries.some((entry) => entry.classification === 'INDETERMINATE' && entry.detail.includes('self-hash')));
    assert.equal(report.entries.find((entry) => entry.path === created.path)?.classification, 'UNOWNED');
    const applied = await manager.reconcile({ mode: 'APPLY', expected_report_hash: report.report_hash });
    assert.ok(applied.entries.some((entry) => entry.classification === 'UNOWNED' && entry.path === created.path));
    await access(created.path);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('recovers an exact cleanup interrupted after Git removed the worktree', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  let now = '2026-08-21T12:00:00.000Z';
  try {
    const manager = createWorktreeManagerV4({
      repository_root: fixture.root,
      worktree_parent: parent,
      now: () => now,
      retention_seconds: { FINALIZED: 0, FAILED: 1, ABORTED: 1 },
    });
    const created = await manager.create({ run_id: 'run_interrupted', base_sha: fixture.baseSha } as RuntimeWorkContractV4);
    await manager.markTerminal(created.run_id, {
      state: 'FAILED',
      disposition: 'DISCARD_AFTER_RETENTION',
      recorded_at: now,
      evidence_hash: 'c'.repeat(64),
    });
    await execFileAsync('git', ['-C', fixture.root, 'worktree', 'remove', '--force', created.path]);
    now = '2026-08-21T12:00:02.000Z';
    const report = await manager.report();
    assert.equal(report.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_TERMINAL_SAFE');
    const applied = await manager.reconcile({ mode: 'APPLY', expected_report_hash: report.report_hash });
    assert.equal(applied.entries.find((entry) => entry.run_id === created.run_id)?.classification, 'OWNED_CLEANED');
    await assert.rejects(() => execFileAsync('git', ['-C', fixture.root, 'show-ref', '--verify', `refs/heads/${created.branch}`]));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('exposes report-only cleanup through the CLI and requires hash-bound APPLY', async () => {
  const fixture = await fixtureRepository();
  const parent = await mkdtemp(join(tmpdir(), 'ao-managed-worktrees-'));
  try {
    const lines: string[] = [];
    assert.equal(
      await runCli(['runtime', 'worktree-gc', '--repository-root', fixture.root, '--worktree-parent', parent, '--mode', 'REPORT'], {
        stdout: (line) => lines.push(line),
      }),
      0,
    );
    const report = JSON.parse(lines[0]!) as { report_hash: string };
    assert.match(report.report_hash, /^[a-f0-9]{64}$/u);
    assert.equal(
      await runCli(['runtime', 'worktree-gc', '--repository-root', fixture.root, '--worktree-parent', parent, '--mode', 'APPLY'], {
        stderr: (line) => lines.push(line),
      }),
      2,
    );
    assert.match(lines.at(-1) ?? '', /APPLY requires one expected report hash/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
