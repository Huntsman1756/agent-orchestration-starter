import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadRepositoryRegistration, type RepositoryRegistryV4 } from '../src/runtime/repository-registry.js';

test('loads the broker-owned canonical registration for an allowed repository', () => {
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'runner-v4-registry-')));
  const registry: RepositoryRegistryV4 = {
    repositories: [{
      repository_id: 'fixture-repo',
      canonical_root: fixtureRoot,
      policy_ref: 'policies/fixture.yaml',
      profile_ref: 'profiles/fixture.yaml',
      worktree_parent: 'C:/broker/worktrees',
      state_path: 'C:/broker/state/fixture.json',
    }],
  };

  const registration = loadRepositoryRegistration('fixture-repo', registry);

  assert.equal(registration.canonical_root, fixtureRoot);
  assert.equal(registration.policy_ref, 'policies/fixture.yaml');
  assert.equal(registration.profile_ref, 'profiles/fixture.yaml');
});

test('rejects a repository absent from the broker registry', () => {
  assert.throws(
    () => loadRepositoryRegistration('missing-repo', { repositories: [] }),
    /REPOSITORY_NOT_ALLOWED/,
  );
});
