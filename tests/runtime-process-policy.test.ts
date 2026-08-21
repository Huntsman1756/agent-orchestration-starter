import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeRepositoryPolicyV4 } from '../src/runtime/contracts.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import { assertResolvedValidationV4, resolveValidation } from '../src/runtime/process-policy.js';

function policy(): RuntimeRepositoryPolicyV4 {
  return {
    schemaVersion: 4,
    repositoryId: 'fixture-repo',
    base: { allowedBranches: ['main'] },
    worktrees: { parentRef: 'managed' },
    routing: { frontierOnly: { riskClasses: ['security'], taskClasses: [], paths: [], sourceSensitivity: ['PRIVATE'] } },
    validation: {
      test: {
        argv: ['npm', 'test', '--', '--runInBand'],
        workingDirectory: '.',
        timeoutSeconds: 120,
        sandboxProfile: 'VALIDATION_UNTRUSTED',
      },
    },
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
}

test('resolves the exact owner-policy command, cwd, timeout, profile, and policy hash', () => {
  const frozen = freezeRepositoryPolicy(policy());
  const resolved = resolveValidation(frozen, 'test');
  assert.deepEqual(resolved.argv, ['npm', 'test', '--', '--runInBand']);
  assert.equal(resolved.working_directory, '.');
  assert.equal(resolved.timeout_ms, 120_000);
  assert.equal(resolved.policy_hash, frozen.hash);
  assert.doesNotThrow(() => assertResolvedValidationV4(resolved, frozen.hash));
  assert.throws(() => assertResolvedValidationV4({ ...resolved, argv: ['echo', 'pass'] }, frozen.hash), /VALIDATION_FAILED/);
  assert.throws(() => assertResolvedValidationV4(resolved, 'f'.repeat(64)), /VALIDATION_FAILED/);
});

test('rejects unknown IDs, shell syntax, install/lifecycle commands, unsafe cwd, and timeout expansion', () => {
  assert.throws(() => resolveValidation(freezeRepositoryPolicy(policy()), 'missing'), /VALIDATION_FAILED/);
  for (const mutation of [
    (value: RuntimeRepositoryPolicyV4) => {
      value.validation.test!.argv = ['npm', 'test && curl bad'];
    },
    (value: RuntimeRepositoryPolicyV4) => {
      value.validation.test!.argv = ['npm', 'install'];
    },
    (value: RuntimeRepositoryPolicyV4) => {
      value.validation.test!.workingDirectory = '../outside';
    },
    (value: RuntimeRepositoryPolicyV4) => {
      value.validation.test!.timeoutSeconds = 4000;
    },
  ]) {
    const value = structuredClone(policy()) as RuntimeRepositoryPolicyV4;
    mutation(value);
    assert.throws(() => resolveValidation(freezeRepositoryPolicy(value), 'test'), /VALIDATION_FAILED/);
  }
});
