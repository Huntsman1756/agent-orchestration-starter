import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBrokerDaemon, type BrokerDaemonDependenciesV4 } from '../src/runtime/broker-daemon.js';
import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import { acquireRepositoryLockV4, acquireRunLockV4 } from '../src/runtime/repository-lock.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import { writeBrokerStateCacheV4 } from '../src/runtime/run-state.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy, validRuntimeProfile, validTaskRequest } from './runtime-contracts.test.js';

async function daemonFixture(overrides: Partial<BrokerDaemonDependenciesV4> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runner-v4-repo-'));
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-daemon-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'greeting.ts'), 'export const greeting = true;');
  const deps: BrokerDaemonDependenciesV4 = {
    stateDirectory,
    registry: { repositories: [{ repository_id: 'fixture-repo', canonical_root: root, policy_ref: 'policy', profile_ref: 'profile', worktree_parent: join(root, '.worktrees'), state_path: stateDirectory }] },
    loadPolicy: async () => freezeRepositoryPolicy(validRepositoryPolicy() as RuntimeRepositoryPolicyV4),
    loadProfile: async () => validRuntimeProfile() as RuntimeProfileV4,
    resolveBaseSha: async () => 'b'.repeat(40),
    sandboxProfiles: { 'executor-networked': {}, 'frontier-networked': {}, 'validation-untrusted': {}, 'review-capsule': {} },
    inspectChanges: async (input) => input.changes.map((change) => ({ ...change, canonical_parent: join(root, 'src'), existed_at_freeze: true })),
    generateRunId: () => 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    now: () => '2026-08-08T12:00:00.000Z',
    lockOwnerStatus: async () => 'dead',
    ...overrides,
  };
  return { deps, stateDirectory };
}

function runCommand(request = validTaskRequest() as RuntimeTaskRequestV4, commandId = 'command-run') {
  return { type: 'RUN_CODING_TASK' as const, command_id: commandId, request };
}

test('generates the run ID and reaches executor-ready state only after path inspection', async () => {
  const { deps } = await daemonFixture();
  const daemon = createBrokerDaemon(deps);

  const reply = await daemon.submit(runCommand());
  const result = await daemon.status(reply.run_id);

  assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(result.state, 'READY_FOR_EXECUTOR');
  await daemon.close();
});

test('does not append a run when pre-launch inspection fails', async () => {
  const { deps, stateDirectory } = await daemonFixture({ inspectChanges: async () => { throw new Error('OUT_OF_SCOPE_CHANGE: unsafe parent'); } });
  const daemon = createBrokerDaemon(deps);

  await assert.rejects(() => daemon.submit(runCommand()), /OUT_OF_SCOPE_CHANGE/);
  await daemon.close();
  const journal = await import('../src/runtime/journal.js').then(({ reopenJournalV4 }) => reopenJournalV4(stateDirectory));
  assert.equal(journal.records.length, 0);
  await journal.close();
});

test('resubmission after restart returns the original run without another append', async () => {
  const { deps, stateDirectory } = await daemonFixture();
  const first = createBrokerDaemon(deps);
  const original = await first.submit(runCommand());
  await first.close();

  const restarted = createBrokerDaemon({ ...deps, generateRunId: () => 'run_DIFFERENT000000000000' });
  await restarted.recover();
  const replay = await restarted.submit(runCommand(validTaskRequest() as RuntimeTaskRequestV4, 'command-retry'));
  await restarted.close();
  const journal = await import('../src/runtime/journal.js').then(({ reopenJournalV4 }) => reopenJournalV4(stateDirectory));

  assert.equal(replay.run_id, original.run_id);
  assert.equal(journal.records.length, 1);
  await journal.close();
});

test('recovers a mutation fsynced to the journal before cache replacement or reply', async () => {
  let failCacheReplacement = true;
  const { deps } = await daemonFixture({
    writeStateCache: async (directory, state, sequence) => {
      if (sequence === 1 && failCacheReplacement) {
        failCacheReplacement = false;
        throw new Error('simulated crash after journal fsync');
      }
      await writeBrokerStateCacheV4(directory, state, sequence);
    },
  } as Partial<BrokerDaemonDependenciesV4>);
  const first = createBrokerDaemon(deps);

  await assert.rejects(() => first.submit(runCommand()), /BROKER_STATE_CORRUPT/);
  await first.close();
  const restarted = createBrokerDaemon(deps);
  await restarted.recover();

  const result = await restarted.status('run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(result.state, 'READY_FOR_EXECUTOR');
  await restarted.close();
});

test('normalizes raw dependency failures at the public daemon boundary', async () => {
  const { deps } = await daemonFixture({ loadPolicy: async () => { throw new Error('ENOENT C:\\Users\\secret-owner\\policy.yaml'); } });
  const daemon = createBrokerDaemon(deps);

  await assert.rejects(
    () => daemon.submit(runCommand()),
    (error: Error) => /^UNKNOWN_FAILURE:/.test(error.message) && !/secret-owner|ENOENT/.test(error.message),
  );

  await daemon.close();
});

test('fails an indeterminate external process as UNKNOWN_FAILURE during restart reconciliation', async () => {
  const { deps } = await daemonFixture({ reconcileExternalProcess: async () => 'unknown' });
  const daemon = createBrokerDaemon(deps);
  const accepted = await daemon.submit(runCommand());
  await daemon.recordExternalProcessStarted(accepted.run_id, { pid: 4242, boot_nonce: 'external-boot' });
  await daemon.close();

  const restarted = createBrokerDaemon(deps);
  await restarted.recover();
  const result = await restarted.status(accepted.run_id);

  assert.equal(result.state, 'FAILED');
  assert.equal(result.failure?.code, 'UNKNOWN_FAILURE');
  await restarted.close();
});

test('does not steal a repository lock from a live or unverifiable owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-lock-'));
  const owner = await acquireRepositoryLockV4({ directory, repositoryId: 'fixture-repo', ownerStatus: async () => 'live', pid: 100, ownerIdentity: { boot_id: 'boot', process_start_id: 'start-100' } });

  await assert.rejects(
    () => acquireRepositoryLockV4({ directory, repositoryId: 'fixture-repo', ownerStatus: async () => 'unknown', pid: 200, ownerIdentity: { boot_id: 'boot', process_start_id: 'start-200' } }),
    /REPOSITORY_BUSY/,
  );

  await owner.release();
});

test('replaces a lock only after its recorded owner is proven dead', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-lock-'));
  await writeFile(join(directory, 'fixture-repo.lock'), JSON.stringify({ repository_id: 'fixture-repo', pid: 100, boot_nonce: 'old-nonce', boot_id: 'old-boot', process_start_id: 'old-start' }));

  const replacement = await acquireRepositoryLockV4({ directory, repositoryId: 'fixture-repo', ownerStatus: async () => 'dead', pid: 200, bootNonce: 'new-nonce', ownerIdentity: { boot_id: 'new-boot', process_start_id: 'new-start' } });

  assert.equal(replacement.boot_nonce, 'new-nonce');
  await replacement.release();
});

test('serializes mutation ownership with a distinct per-run lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-run-lock-'));
  const owner = await acquireRunLockV4({ directory, runId: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', ownerStatus: async () => 'live', pid: 100, ownerIdentity: { boot_id: 'boot', process_start_id: 'start-100' } });

  await assert.rejects(
    () => acquireRunLockV4({ directory, runId: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', ownerStatus: async () => 'live', pid: 200, ownerIdentity: { boot_id: 'boot', process_start_id: 'start-200' } }),
    /REPOSITORY_BUSY/,
  );

  await owner.release();
});

test('serializes stale-lock reclamation so a second contender cannot unlink the new owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-lock-race-'));
  await writeFile(join(directory, 'fixture-repo.lock'), JSON.stringify({ repository_id: 'fixture-repo', pid: 100, boot_nonce: 'old-nonce', boot_id: 'old-boot', process_start_id: 'old-start' }));
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
  const first = acquireRepositoryLockV4({
    directory,
    repositoryId: 'fixture-repo',
    pid: 200,
    bootNonce: 'first-nonce',
    ownerIdentity: { boot_id: 'new-boot', process_start_id: 'first-start' },
    ownerStatus: async () => { firstEntered(); await firstPaused; return 'dead'; },
  });
  await entered;

  const second = acquireRepositoryLockV4({
    directory,
    repositoryId: 'fixture-repo',
    pid: 300,
    bootNonce: 'second-nonce',
    ownerIdentity: { boot_id: 'new-boot', process_start_id: 'second-start' },
    ownerStatus: async (lockOwner) => lockOwner.pid === 100 ? 'dead' : 'live',
  });
  await assert.rejects(second, /REPOSITORY_BUSY/);
  releaseFirst();
  const winner = await first;

  const third = acquireRepositoryLockV4({ directory, repositoryId: 'fixture-repo', ownerStatus: async () => 'live', pid: 400, ownerIdentity: { boot_id: 'new-boot', process_start_id: 'third-start' } });
  await assert.rejects(third, /REPOSITORY_BUSY/);
  await winner.release();
});

test('recovers an orphaned reclaim guard only after its identity is proven dead', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-orphan-guard-'));
  const staleOwner = { repository_id: 'fixture-repo', pid: 100, boot_nonce: 'stale-owner', boot_id: 'old-boot', process_start_id: 'old-start' };
  await writeFile(join(directory, 'fixture-repo.lock'), JSON.stringify(staleOwner));
  await writeFile(join(directory, `fixture-repo.lock.reclaim-${hashCanonicalV4(staleOwner).slice(0, 16)}`), JSON.stringify(staleOwner));

  const recovered = await acquireRepositoryLockV4({
    directory,
    repositoryId: 'fixture-repo',
    pid: 200,
    bootNonce: 'new-owner',
    ownerIdentity: { boot_id: 'new-boot', process_start_id: 'new-start' },
    ownerStatus: async () => 'dead',
  });

  assert.equal(recovered.boot_nonce, 'new-owner');
  await recovered.release();
});
