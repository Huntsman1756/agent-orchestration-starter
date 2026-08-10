import { mkdirSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { RuntimeWorkContractV4 } from './contracts.js';
import { gitTextV4, runGit } from './git-runner.js';

const shaPattern = /^[a-f0-9]{40}$/;
const runPattern = /^run_[A-Za-z0-9_-]{1,92}$/;

export interface WorktreeRecordV4 {
  readonly run_id: string;
  readonly path: string;
  readonly branch: string;
  readonly base_sha: string;
}

export interface WorktreeVerificationV4 {
  readonly valid: boolean;
  readonly head_sha: string;
  readonly clean: boolean;
}

export interface WorktreeManagerV4 {
  create(contract: RuntimeWorkContractV4): Promise<WorktreeRecordV4>;
  verify(record: WorktreeRecordV4): Promise<WorktreeVerificationV4>;
}

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

export function createWorktreeManagerV4(input: { repository_root: string; worktree_parent: string }): WorktreeManagerV4 {
  mkdirSync(input.worktree_parent, { recursive: true });
  const repositoryRoot = realpathSync.native(input.repository_root);
  const worktreeParent = realpathSync.native(input.worktree_parent);
  if (contains(repositoryRoot, worktreeParent) || contains(worktreeParent, repositoryRoot)) {
    throw new Error('BROKER_STATE_CORRUPT: worktree parent overlaps the active repository');
  }

  const verify = async (record: WorktreeRecordV4): Promise<WorktreeVerificationV4> => {
    const canonical = await realpath(record.path).catch(() => '');
    if (canonical === '' || !contains(worktreeParent, canonical)) return Object.freeze({ valid: false, head_sha: '', clean: false });
    const head = gitTextV4(await runGit(canonical, ['rev-parse', 'HEAD'])).trim();
    const clean = (await runGit(canonical, ['status', '--porcelain=v2', '-z'])).stdout.length === 0;
    return Object.freeze({ valid: head === record.base_sha && clean, head_sha: head, clean });
  };

  return Object.freeze({
    create: async (contract: RuntimeWorkContractV4): Promise<WorktreeRecordV4> => {
      if (!shaPattern.test(contract.base_sha) || !runPattern.test(contract.run_id)) {
        throw new Error('OUT_OF_SCOPE_CHANGE: worktree identity is not immutable');
      }
      const exactBase = gitTextV4(await runGit(repositoryRoot, ['rev-parse', '--verify', `${contract.base_sha}^{commit}`])).trim();
      if (exactBase !== contract.base_sha) throw new Error('OUT_OF_SCOPE_CHANGE: base commit mismatch');
      const branch = `codex/auto/${contract.run_id}`;
      const worktreePath = resolve(worktreeParent, contract.run_id);
      if (!contains(worktreeParent, worktreePath) || await lstat(worktreePath).then(() => true, () => false)) {
        throw new Error('BROKER_STATE_CORRUPT: worktree path is unavailable');
      }
      await runGit(repositoryRoot, ['worktree', 'add', '--detach', worktreePath, contract.base_sha]);
      await runGit(repositoryRoot, ['branch', branch, contract.base_sha]);
      const record = Object.freeze({ run_id: contract.run_id, path: worktreePath, branch, base_sha: contract.base_sha });
      if (!(await verify(record)).valid) throw new Error('BROKER_STATE_CORRUPT: created worktree failed verification');
      return record;
    },
    verify,
  });
}
