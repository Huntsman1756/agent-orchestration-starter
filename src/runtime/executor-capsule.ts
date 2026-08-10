import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';

export interface ExecutorCapsuleV4 {
  readonly root: string;
  readonly manifest_hash: string;
}

export interface ExecutorCapsuleInputV4 {
  readonly capsule_parent: string;
  readonly run_id: string;
  readonly worktree_root: string;
  readonly base_sha: string;
  readonly instruction_manifest_hash: string;
}

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

export async function buildExecutorCapsuleV4(input: ExecutorCapsuleInputV4): Promise<ExecutorCapsuleV4> {
  if (!/^run_[A-Za-z0-9_-]{1,92}$/.test(input.run_id)
    || !/^[a-f0-9]{40}$/.test(input.base_sha)
    || !/^[a-f0-9]{64}$/.test(input.instruction_manifest_hash)) {
    throw new Error('BROKER_STATE_CORRUPT: capsule identity is invalid');
  }
  await mkdir(input.capsule_parent, { recursive: true, mode: 0o700 });
  const parent = await realpath(input.capsule_parent);
  const worktree = await realpath(input.worktree_root);
  if (contains(parent, worktree) || contains(worktree, parent)) throw new Error('BROKER_STATE_CORRUPT: capsule and worktree roots overlap');
  const root = resolve(parent, input.run_id);
  if (!contains(parent, root)) throw new Error('BROKER_STATE_CORRUPT: capsule path escaped its parent');
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const directory of ['agent', 'cache', 'config', 'home', 'instructions', 'repo', 'tmp']) {
    await mkdir(join(root, directory), { mode: 0o700 });
  }
  const manifest = {
    schema_version: 4,
    run_id: input.run_id,
    base_sha: input.base_sha,
    instruction_manifest_hash: input.instruction_manifest_hash,
    mounts: [{ capsule_path: 'repo', host_path: worktree, mode: 'rw' }],
  } as const;
  await writeFile(join(root, 'config', 'mount-manifest.json'), `${canonicalJsonV4(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ root, manifest_hash: hashCanonicalV4(manifest) });
}
