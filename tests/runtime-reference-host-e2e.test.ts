import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createBrokerDaemon, type BrokerDaemonDependenciesV4 } from '../src/runtime/broker-daemon.js';
import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';
import { composeRuntimeHostControlV4, type RuntimeHostOperationsV4 } from '../src/runtime/host-composition.js';
import { loadRuntimeHostDriverV4 } from '../src/runtime/host-driver.js';
import { activateRuntimeRepositoryV4, installRuntimeHostV4 } from '../src/runtime/host-installation.js';
import { createInProcessReclamationCoordinatorV4 } from '../src/runtime/repository-lock.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy, validRuntimeProfile, validTaskRequest } from './runtime-contracts.test.js';
import { createRuntimeHostFixtureV4 } from './runtime-host-fixtures.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';

function runCommand(request: RuntimeTaskRequestV4) {
  return { type: 'RUN_CODING_TASK' as const, command_id: 'reference-admission', request };
}

async function waitForTerminal(daemon: { status(run: string): Promise<{ state: string }> }, id: string): Promise<{ state: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await daemon.status(id);
    if (['FAILED', 'ABORTED', 'FINALIZED'].includes(result.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('reference E2E did not reach a terminal state');
}

test('reference host demonstrates activation through publication dry-run without secrets or network', async () => {
  const stages: string[] = [];
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const hostRoot = await mkdtemp(join(tmpdir(), 'reference-host-install-'));
  const driverSource = await readFile(new URL('../examples/reference-host-driver/reference-host-driver.mjs', import.meta.url), 'utf8');
  const fixture = await createRuntimeHostFixtureV4({ driverSource });
  const installation = await installRuntimeHostV4({ sourceRoot, hostRoot, hostDriver: fixture.driverSource, hostComponentsManifest: fixture.componentManifestPath, installedAt: '2026-08-10T12:00:00.000Z' });

  const repositoryRoot = await mkdtemp(join(tmpdir(), 'reference-runtime-repository-'));
  const stateDirectory = await mkdtemp(join(tmpdir(), 'reference-runtime-state-'));
  const worktreeParent = await mkdtemp(join(tmpdir(), 'reference-runtime-worktrees-'));
  await mkdir(join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(join(repositoryRoot, 'src', 'greeting.ts'), 'export const greeting = false;\n');
  assert.equal(spawnSync('git', ['init', repositoryRoot], { windowsHide: true }).status, 0);
  const policyPath = join(repositoryRoot, 'repository-policy.json');
  const profilePath = join(repositoryRoot, 'runtime-profile.json');
  const policy = { ...(validRepositoryPolicy() as RuntimeRepositoryPolicyV4), repositoryId: 'fixture-repo', publication: { ...(validRepositoryPolicy() as RuntimeRepositoryPolicyV4).publication, enabled: false } };
  const profile = validRuntimeProfile() as RuntimeProfileV4;
  await writeFile(policyPath, `${canonicalJsonV4(policy)}\n`);
  await writeFile(profilePath, `${canonicalJsonV4(profile)}\n`);
  const activation = await activateRuntimeRepositoryV4({
    repositoryRoot,
    policyPath,
    profilePath,
    worktreeParent,
    hostRoot,
    installationManifest: join(installation.root, 'installation-v4.json'),
    target: 'ANALYSIS_ONLY',
    activatedAt: '2026-08-10T12:00:00.000Z',
  });
  const driver = await loadRuntimeHostDriverV4(join(repositoryRoot, '.agent-orchestration', 'activation-v4.json'));
  assert.deepEqual(await driver.doctor(), ['reference-only host driver', 'components: credential_gateway,task_source,issue_planner,practice_pack_resolver,sandbox_coordinator,capability_issuer,github_publisher,post_merge_verifier']);
  stages.push('activation');

  const request = { ...(validTaskRequest() as RuntimeTaskRequestV4), repository_id: 'fixture-repo', allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] as const }] };
  const deps: BrokerDaemonDependenciesV4 = {
    stateDirectory,
    registry: { repositories: [{ repository_id: 'fixture-repo', canonical_root: repositoryRoot, policy_ref: policyPath, profile_ref: profilePath, worktree_parent: worktreeParent, state_path: stateDirectory }] },
    loadPolicy: async () => freezeRepositoryPolicy(policy),
    loadProfile: async () => profile,
    resolveBaseSha: async () => 'b'.repeat(40),
    sandboxProfiles: { 'executor-networked': {}, 'frontier-networked': {}, 'validation-untrusted': {}, 'review-capsule': {} },
    inspectChanges: async (input) => input.changes.map((change) => ({ ...change, canonical_parent: repositoryRoot, existed_at_freeze: true })),
    generateRunId: () => runId,
    lockOwnerStatus: async () => 'dead',
    reclamationCoordinator: createInProcessReclamationCoordinatorV4('reference-e2e'),
    allowInProcessCoordinatorForTests: true,
  };

  const operations: RuntimeHostOperationsV4 = {
    advance: async (id, daemon) => {
      stages.push('execution');
      await daemon.recordExternalProcessStarted(id, { pid: process.pid, boot_nonce: 'reference-e2e-boot' });
      await daemon.recordAttempt(id, { attempt: 1, executor_binding_ref: 'fixture-economy-worker', result_hash: hashCanonicalV4({ stage: 'execution', id }) });
      stages.push('validation');
      await daemon.reinspect(id);
      const diffHash = hashCanonicalV4({ file: 'src/greeting.ts', content: 'export const greeting = true;\n' });
      const treeHash = hashCanonicalV4({ base: 'b'.repeat(40), diffHash });
      const reviewHash = hashCanonicalV4({ reviewer: 'fixture-frontier-reviewer', treeHash, decision: 'ACCEPT' });
      stages.push('review');
      await daemon.recordAcceptedCandidate!({
        type: 'CANDIDATE_ACCEPTED',
        command_id: 'reference-candidate-accepted',
        run_id: id,
        validation_results: [{ validation_id: 'test', exit_code: 0, result_hash: hashCanonicalV4({ validation: 'deterministic-pass' }) }],
        diff_hash: diffHash,
        tree_hash: treeHash,
        changed_files: ['src/greeting.ts'],
        review_attestation_hash: reviewHash,
      });
      const accepted = await daemon.status(id);
      stages.push('finalize');
      await daemon.recordCommitCreated!({
        type: 'COMMIT_CREATED',
        command_id: 'reference-commit-created',
        run_id: id,
        task_ref: `refs/heads/${accepted.branch}`,
        base_sha: accepted.base_sha,
        git_tree_sha: 'd'.repeat(40),
        evidence_tree_hash: accepted.tree_hash,
        commit_sha: 'c'.repeat(40),
        contract_hash: accepted.contract_hash,
        diff_hash: accepted.diff_hash,
        validation_manifest_hash: hashCanonicalV4(accepted.validation_results),
        review_attestation_hash: accepted.review_attestation_hash!,
      });
      stages.push('publication-dry-run');
      const finalizedCandidate = await daemon.status(id);
      await daemon.recordPublication!({
        type: 'PUBLICATION_SKIPPED',
        command_id: 'reference-publication-dry-run',
        run_id: id,
        commit_sha: finalizedCandidate.commit_sha!,
        publication_policy_hash: finalizedCandidate.policy_hash,
        reason: 'POLICY_DISABLED',
      });
    },
    prepareRepair: async () => undefined,
    finalize: async () => undefined,
    stopExternal: async () => undefined,
  };
  const host = composeRuntimeHostControlV4(createBrokerDaemon(deps), operations);
  try {
    stages.push('admission');
    const reply = await host.daemon.submit(runCommand(request));
    const result = await waitForTerminal(host.daemon, reply.run_id);
    assert.equal(result.state, 'FINALIZED');
    assert.deepEqual(stages, ['activation', 'admission', 'execution', 'validation', 'review', 'finalize', 'publication-dry-run']);
    assert.equal((await host.daemon.status(reply.run_id)).publication.state, 'SKIPPED');
    assert.equal(activation.hostCompositionHash, installation.hostComposition?.compositionCertificationHash);
  } finally {
    await host.close();
  }
});
