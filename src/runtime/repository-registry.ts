import { realpathSync, statSync } from 'node:fs';

export interface RegisteredRepositoryV4 {
  repository_id: string;
  canonical_root: string;
  policy_ref: string;
  profile_ref: string;
  worktree_parent: string;
  state_path: string;
}

export interface RepositoryRegistryV4 {
  repositories: readonly RegisteredRepositoryV4[];
}

function brokerState(message: string): never {
  throw new Error(`BROKER_STATE_CORRUPT: ${message}`);
}

function nonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) brokerState(`${name} must not be empty`);
}

export function loadRepositoryRegistration(repositoryId: string, registry: RepositoryRegistryV4): RegisteredRepositoryV4 {
  const matches = registry.repositories.filter((entry) => entry.repository_id === repositoryId);
  if (matches.length === 0) throw new Error(`REPOSITORY_NOT_ALLOWED: ${repositoryId}`);
  if (matches.length !== 1) brokerState(`repository ${repositoryId} has duplicate registrations`);

  const registration = matches[0];
  nonEmpty(registration.canonical_root, 'canonical_root');
  nonEmpty(registration.policy_ref, 'policy_ref');
  nonEmpty(registration.profile_ref, 'profile_ref');
  nonEmpty(registration.worktree_parent, 'worktree_parent');
  nonEmpty(registration.state_path, 'state_path');

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(registration.canonical_root);
    if (!statSync(canonicalRoot).isDirectory()) brokerState(`repository root is not a directory: ${repositoryId}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BROKER_STATE_CORRUPT:')) throw error;
    brokerState(`repository root cannot be canonicalized: ${repositoryId}`);
  }

  return Object.freeze({ ...registration, canonical_root: canonicalRoot });
}
