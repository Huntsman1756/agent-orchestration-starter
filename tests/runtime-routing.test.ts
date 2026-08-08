import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveWorkContract } from '../src/runtime/routing.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import type { DeriveWorkContractInputV4 } from '../src/runtime/routing.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy, validRuntimeProfile, validTaskRequest } from './runtime-contracts.test.js';

function contractInput(): DeriveWorkContractInputV4 {
  return {
    request: validTaskRequest() as RuntimeTaskRequestV4,
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    registration: {
      repository_id: 'fixture-repo',
      canonical_root: 'C:/broker/repos/fixture-repo',
      policy_ref: 'policies/fixture.yaml',
      profile_ref: 'profiles/fixture.yaml',
      worktree_parent: 'C:/broker/worktrees',
      state_path: 'C:/broker/state/fixture.json',
    },
    policy: freezeRepositoryPolicy(validRepositoryPolicy() as RuntimeRepositoryPolicyV4),
    profile: validRuntimeProfile() as RuntimeProfileV4,
    base_sha: 'b'.repeat(40),
    sandbox_profiles: {
      'executor-networked': { network: 'enabled' },
      'frontier-networked': { network: 'enabled' },
      'validation-untrusted': { network: 'disabled' },
      'review-capsule': { network: 'disabled' },
    },
  };
}

test('keeps a public normal task on the economy route', () => {
  assert.equal(deriveWorkContract(contractInput()).effective_route, 'ECONOMY');
});

test('elevates private-source work to the frontier route', () => {
  const input = contractInput();
  input.policy = freezeRepositoryPolicy({
    ...validRepositoryPolicy(),
    sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PRIVATE' },
  } as RuntimeRepositoryPolicyV4);
  input.profile = {
    ...input.profile,
    bindings: {
      ...input.profile.bindings,
      frontierExecutor: { ...input.profile.bindings.frontierExecutor, allowedSourceSensitivity: ['PRIVATE'] },
    },
  };

  assert.equal(deriveWorkContract(input).effective_route, 'FRONTIER');
});

test('rejects private work when the frontier binding is incompatible', () => {
  const input = contractInput();
  input.policy = freezeRepositoryPolicy({
    ...validRepositoryPolicy(),
    sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PRIVATE' },
  } as RuntimeRepositoryPolicyV4);

  assert.throws(() => deriveWorkContract(input), /SOURCE_SENSITIVITY_UNSUPPORTED/);
});

test('never downgrades an explicitly requested frontier route', () => {
  const input = contractInput();
  input.request.requested_route = 'FRONTIER';

  assert.equal(deriveWorkContract(input).effective_route, 'FRONTIER');
});
