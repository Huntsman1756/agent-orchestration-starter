import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RuntimeRepositoryPolicyV4 } from '../src/runtime/contracts.js';
import type { ProcessSandboxBackendV4, SandboxRunRequestV4 } from '../src/runtime/process-sandbox.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import { createArtifactStoreV4 } from '../src/runtime/artifact-store.js';
import { resolveValidation } from '../src/runtime/process-policy.js';
import { createValidationRunner } from '../src/runtime/validation.js';

function frozenPolicy() {
  const policy: RuntimeRepositoryPolicyV4 = {
    schemaVersion: 4,
    repositoryId: 'fixture',
    base: { allowedBranches: ['main'] },
    worktrees: { parentRef: 'managed' },
    routing: { frontierOnly: { riskClasses: [], taskClasses: [], paths: [], sourceSensitivity: ['PRIVATE'] } },
    validation: { test: { argv: ['node', '--test'], workingDirectory: '.', timeoutSeconds: 30, sandboxProfile: 'VALIDATION_UNTRUSTED' } },
    sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PUBLIC' },
    sandbox: { requiredBackend: 'docker', requiredProfiles: ['VALIDATION_UNTRUSTED'] },
    instructions: { approvedSources: ['AGENTS.md'] },
    publication: {
      enabled: true,
      remote: 'origin',
      baseBranch: 'main',
      mergeMethod: 'squash',
      requireRequiredChecks: true,
      timeoutSeconds: 900,
    },
  };
  return freezeRepositoryPolicy(policy);
}

function sandbox(result: Partial<Awaited<ReturnType<ProcessSandboxBackendV4['run']>>> = {}) {
  const requests: SandboxRunRequestV4[] = [];
  const backend: ProcessSandboxBackendV4 = {
    id: 'fixture',
    probe: async () => ({
      status: 'SUPPORTED',
      backend_id: 'docker-v4',
      policy_hash: 'a'.repeat(64),
      certification_hash: 'b'.repeat(64),
      expires_at: '2026-08-10T10:00:00.000Z',
    }),
    run: async (request) => {
      requests.push(request);
      return {
        execution_id: request.execution_id,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout: 'ok🙂'.repeat(20),
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        duration_ms: 12,
        ...result,
      };
    },
    terminate: async () => {},
  };
  return { backend, requests };
}

test('launches only the resolved command in credential-free, networkless validation and stores full logs', async () => {
  const capsule = await mkdtemp(join(tmpdir(), 'ao-validation-capsule-'));
  const repo = await mkdtemp(join(tmpdir(), 'ao-validation-repo-'));
  const artifacts = createArtifactStoreV4({ root: await mkdtemp(join(tmpdir(), 'ao-validation-artifacts-')), max_artifact_bytes: 4096 });
  const fake = sandbox();
  const frozen = frozenPolicy();
  const runner = createValidationRunner({
    sandbox: fake.backend,
    artifacts,
    now: () => '2026-08-10T09:00:00.000Z',
    current_tree_hash: async () => 'c'.repeat(64),
    preview_bytes: 17,
  });
  const input = {
    execution_id: 'exec_validation_0001',
    validation: resolveValidation(frozen, 'test'),
    expected_policy_hash: frozen.hash,
    expected_sandbox_policy_hash: 'a'.repeat(64),
    capsule_root: capsule,
    repository_root: repo,
    tree_hash: 'c'.repeat(64),
  };
  const result = await runner.run(input);

  assert.equal(result.passed, true);
  assert.equal(result.validated_tree_hash, 'c'.repeat(64));
  assert.equal(await artifacts.verify(result.stdout_artifact), true);
  assert.equal(Buffer.byteLength(result.stdout_preview, 'utf8') <= 17, true);
  assert.doesNotMatch(result.stdout_preview, /�/);
  assert.deepEqual(fake.requests[0]?.argv, ['node', '--test']);
  assert.equal(fake.requests[0]?.working_directory, '/capsule/repo');
  assert.deepEqual(fake.requests[0]?.environment, { HOME: '/capsule/home', TMPDIR: '/capsule/tmp', NO_COLOR: '1' });
  assert.deepEqual(fake.requests[0]?.network, { mode: 'NONE' });
  await assert.rejects(() => runner.run({ ...input, argv: ['echo', 'pass'] } as typeof input), /VALIDATION_FAILED/);
});

test('fails the gate on nonzero exit, timeout, sandbox truncation, artifact mismatch, or changed tree', async () => {
  const frozen = frozenPolicy();
  for (const scenario of [{ exit_code: 1 }, { timed_out: true }, { stdout_truncated: true }]) {
    const fake = sandbox(scenario);
    const artifacts = createArtifactStoreV4({ root: await mkdtemp(join(tmpdir(), 'ao-validation-artifacts-')), max_artifact_bytes: 4096 });
    const runner = createValidationRunner({
      sandbox: fake.backend,
      artifacts,
      now: () => '2026-08-10T09:00:00.000Z',
      current_tree_hash: async () => 'c'.repeat(64),
      preview_bytes: 32,
    });
    const result = await runner.run({
      execution_id: `exec_validation_${Object.keys(scenario)[0]}`,
      validation: resolveValidation(frozen, 'test'),
      expected_policy_hash: frozen.hash,
      expected_sandbox_policy_hash: 'a'.repeat(64),
      capsule_root: await mkdtemp(join(tmpdir(), 'ao-capsule-')),
      repository_root: await mkdtemp(join(tmpdir(), 'ao-repo-')),
      tree_hash: 'c'.repeat(64),
    });
    assert.equal(result.passed, false);
    assert.equal(result.failure_code, 'VALIDATION_FAILED');
  }
  const fake = sandbox();
  const artifacts = createArtifactStoreV4({ root: await mkdtemp(join(tmpdir(), 'ao-validation-artifacts-')), max_artifact_bytes: 4096 });
  const changed = createValidationRunner({
    sandbox: fake.backend,
    artifacts,
    now: () => '2026-08-10T09:00:00.000Z',
    current_tree_hash: async () => 'd'.repeat(64),
    preview_bytes: 32,
  });
  const result = await changed.run({
    execution_id: 'exec_validation_changed',
    validation: resolveValidation(frozen, 'test'),
    expected_policy_hash: frozen.hash,
    expected_sandbox_policy_hash: 'a'.repeat(64),
    capsule_root: await mkdtemp(join(tmpdir(), 'ao-capsule-')),
    repository_root: await mkdtemp(join(tmpdir(), 'ao-repo-')),
    tree_hash: 'c'.repeat(64),
  });
  assert.equal(result.passed, false);

  const tamperedArtifacts = { put: artifacts.put, verify: async () => false };
  const artifactMismatch = createValidationRunner({
    sandbox: fake.backend,
    artifacts: tamperedArtifacts,
    now: () => '2026-08-10T09:00:00.000Z',
    current_tree_hash: async () => 'c'.repeat(64),
    preview_bytes: 32,
  });
  const mismatch = await artifactMismatch.run({
    execution_id: 'exec_validation_artifact',
    validation: resolveValidation(frozen, 'test'),
    expected_policy_hash: frozen.hash,
    expected_sandbox_policy_hash: 'a'.repeat(64),
    capsule_root: await mkdtemp(join(tmpdir(), 'ao-capsule-')),
    repository_root: await mkdtemp(join(tmpdir(), 'ao-repo-')),
    tree_hash: 'c'.repeat(64),
  });
  assert.equal(mismatch.passed, false);
});
