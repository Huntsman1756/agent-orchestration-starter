import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { canonicalJsonV4 } from './canonical.js';

const execFileAsync = promisify(execFile);

export type LockOwnerStatusV4 = 'live' | 'dead' | 'unknown';

export interface RepositoryLockOptionsV4 {
  directory: string;
  repositoryId: string;
  ownerStatus?: (owner: RepositoryLockOwnerV4) => Promise<LockOwnerStatusV4>;
  pid?: number;
  bootNonce?: string;
  ownerIdentity?: LockProcessIdentityV4;
  reclamationCoordinator?: ReclamationCoordinatorV4;
}

export interface ReclamationCoordinatorV4 {
  certification: { kind: 'native-cross-process' | 'in-process-test'; identity: string };
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export function createInProcessReclamationCoordinatorV4(identity: string): ReclamationCoordinatorV4 {
  const tails = new Map<string, Promise<void>>();
  return {
    certification: { kind: 'in-process-test', identity },
    runExclusive: async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
      const prior = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, tail);
      await prior;
      try { return await operation(); } finally { release(); if (tails.get(key) === tail) tails.delete(key); }
    },
  };
}

export interface LockProcessIdentityV4 { boot_id: string; process_start_id: string }

export interface RepositoryLockOwnerV4 {
  repository_id: string;
  pid: number;
  boot_nonce: string;
  boot_id: string;
  process_start_id: string;
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
  ownerIdentity?: LockProcessIdentityV4;
  reclamationCoordinator?: ReclamationCoordinatorV4;
}

export interface RunLockV4 {
  run_id: string;
  pid: number;
  boot_nonce: string;
  release(): Promise<void>;
}

async function platformIdentity(pid: number): Promise<LockProcessIdentityV4 | null> {
  if (process.platform === 'linux') {
    try {
      const [bootId, statLine] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const afterName = statLine.slice(statLine.lastIndexOf(')') + 2).split(' ');
      const startTime = afterName[19];
      return startTime === undefined ? null : { boot_id: bootId.trim(), process_start_id: startTime };
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : null;
    }
  }
  if (process.platform === 'win32') {
    const script = "$p=Get-Process -Id $env:RUNNER_V4_PID -ErrorAction Stop; $o=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{boot_id=$o.LastBootUpTime.ToUniversalTime().ToString('o');process_start_id=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress";
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, RUNNER_V4_PID: String(pid) }, windowsHide: true, maxBuffer: 4_096,
      });
      const value = JSON.parse(stdout.trim()) as Partial<LockProcessIdentityV4>;
      return typeof value.boot_id === 'string' && typeof value.process_start_id === 'string' ? value as LockProcessIdentityV4 : null;
    } catch { return null; }
  }
  return null;
}

function busy(repositoryId: string): never {
  throw new Error(`REPOSITORY_BUSY: repository ${repositoryId} is locked by a live or unverifiable owner`);
}

function lockName(repositoryId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(repositoryId)) throw new Error(`INVALID_CONTRACT: invalid repository_id ${repositoryId}`);
  return `${repositoryId}.lock`;
}

async function defaultOwnerStatus(owner: RepositoryLockOwnerV4): Promise<LockOwnerStatusV4> {
  const current = await platformIdentity(process.pid);
  if (current === null) return 'unknown';
  if (current.boot_id !== owner.boot_id) return 'dead';
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  const candidate = await platformIdentity(owner.pid);
  if (candidate === null) return 'unknown';
  return candidate.boot_id === owner.boot_id && candidate.process_start_id === owner.process_start_id ? 'live' : 'dead';
}

async function readOwner(path: string): Promise<RepositoryLockOwnerV4> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<RepositoryLockOwnerV4>;
    if (typeof value.repository_id !== 'string' || !Number.isSafeInteger(value.pid) || typeof value.boot_nonce !== 'string' || value.boot_nonce.length < 8
      || typeof value.boot_id !== 'string' || value.boot_id.length === 0 || typeof value.process_start_id !== 'string' || value.process_start_id.length === 0) {
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
  const identity = options.ownerIdentity ?? await platformIdentity(options.pid ?? process.pid);
  if (identity === null) throw new Error('BROKER_STATE_CORRUPT: process boot/start identity is unavailable for lock ownership');
  const owner: RepositoryLockOwnerV4 = {
    repository_id: options.repositoryId,
    pid: options.pid ?? process.pid,
    boot_nonce: options.bootNonce ?? randomBytes(16).toString('hex'),
    ...identity,
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
    if (options.reclamationCoordinator === undefined) busy(options.repositoryId);
    try {
      await options.reclamationCoordinator.runExclusive(`repository-lock:${path}`, async () => {
        if (await attempt()) return;
        const recorded = await readOwner(path);
        const status = await (options.ownerStatus ?? defaultOwnerStatus)(recorded).catch(() => 'unknown' as const);
        if (status !== 'dead') busy(options.repositoryId);
        const verification = await readOwner(path);
        if (canonicalJsonV4(verification) !== canonicalJsonV4(recorded)) busy(options.repositoryId);
        await unlink(path);
        if (!(await attempt())) busy(options.repositoryId);
      });
    } catch {
      busy(options.repositoryId);
    }
  }

  return Object.freeze({
    ...owner,
    release: async () => {
      const recorded = await readOwner(path).catch(() => null);
      if (recorded !== null && recorded.boot_nonce === owner.boot_nonce && recorded.pid === owner.pid
        && recorded.boot_id === owner.boot_id && recorded.process_start_id === owner.process_start_id) await unlink(path).catch(() => undefined);
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
    ownerIdentity: options.ownerIdentity,
    reclamationCoordinator: options.reclamationCoordinator,
  });
  return Object.freeze({
    run_id: options.runId,
    pid: delegated.pid,
    boot_nonce: delegated.boot_nonce,
    release: delegated.release,
  });
}
