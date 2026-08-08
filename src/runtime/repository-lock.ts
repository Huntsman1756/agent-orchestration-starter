import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonV4 } from './canonical.js';

export type LockOwnerStatusV4 = 'live' | 'dead' | 'unknown';

export interface RepositoryLockOptionsV4 {
  directory: string;
  repositoryId: string;
  ownerStatus?: (owner: RepositoryLockOwnerV4) => Promise<LockOwnerStatusV4>;
  pid?: number;
  bootNonce?: string;
}

export interface RepositoryLockOwnerV4 {
  repository_id: string;
  pid: number;
  boot_nonce: string;
}

export interface RepositoryLockV4 extends RepositoryLockOwnerV4 {
  release(): Promise<void>;
}

export interface RunLockOptionsV4 {
  directory: string;
  runId: string;
  ownerStatus?: (owner: RepositoryLockOwnerV4) => Promise<LockOwnerStatusV4>;
  pid?: number;
  bootNonce?: string;
}

export interface RunLockV4 {
  run_id: string;
  pid: number;
  boot_nonce: string;
  release(): Promise<void>;
}

function busy(repositoryId: string): never {
  throw new Error(`REPOSITORY_BUSY: repository ${repositoryId} is locked by a live or unverifiable owner`);
}

function lockName(repositoryId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(repositoryId)) throw new Error(`INVALID_CONTRACT: invalid repository_id ${repositoryId}`);
  return `${repositoryId}.lock`;
}

async function defaultOwnerStatus(owner: RepositoryLockOwnerV4): Promise<LockOwnerStatusV4> {
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

async function readOwner(path: string): Promise<RepositoryLockOwnerV4> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RepositoryLockOwnerV4>;
    if (typeof value.repository_id !== 'string' || !Number.isSafeInteger(value.pid) || typeof value.boot_nonce !== 'string' || value.boot_nonce.length < 8) {
      throw new Error('invalid lock owner');
    }
    return value as RepositoryLockOwnerV4;
  } catch {
    throw new Error('REPOSITORY_BUSY: repository lock owner is unverifiable');
  }
}

export async function acquireRepositoryLockV4(options: RepositoryLockOptionsV4): Promise<RepositoryLockV4> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const path = join(options.directory, lockName(options.repositoryId));
  const owner: RepositoryLockOwnerV4 = {
    repository_id: options.repositoryId,
    pid: options.pid ?? process.pid,
    boot_nonce: options.bootNonce ?? randomBytes(16).toString('hex'),
  };
  const attempt = async (): Promise<boolean> => {
    const file = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null;
      throw error;
    });
    if (file === null) return false;
    try {
      await file.writeFile(`${canonicalJsonV4(owner)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
  };

  if (!(await attempt())) {
    const recorded = await readOwner(path);
    const status = await (options.ownerStatus ?? defaultOwnerStatus)(recorded).catch(() => 'unknown' as const);
    if (status !== 'dead') busy(options.repositoryId);
    const verification = await readOwner(path);
    if (canonicalJsonV4(verification) !== canonicalJsonV4(recorded)) busy(options.repositoryId);
    await unlink(path);
    if (!(await attempt())) busy(options.repositoryId);
  }

  return Object.freeze({
    ...owner,
    release: async () => {
      const recorded = await readOwner(path).catch(() => null);
      if (recorded !== null && recorded.boot_nonce === owner.boot_nonce && recorded.pid === owner.pid) await unlink(path).catch(() => undefined);
    },
  });
}

export async function acquireRunLockV4(options: RunLockOptionsV4): Promise<RunLockV4> {
  if (!/^run_[A-Za-z0-9_-]{16,96}$/.test(options.runId)) throw new Error(`INVALID_CONTRACT: invalid run_id ${options.runId}`);
  const delegated = await acquireRepositoryLockV4({
    directory: options.directory,
    repositoryId: `run-lock-${createHash('sha256').update(options.runId, 'utf8').digest('hex')}`,
    ownerStatus: options.ownerStatus,
    pid: options.pid,
    bootNonce: options.bootNonce,
  });
  return Object.freeze({
    run_id: options.runId,
    pid: delegated.pid,
    boot_nonce: delegated.boot_nonce,
    release: delegated.release,
  });
}
