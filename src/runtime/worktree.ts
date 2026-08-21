import { mkdirSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { RuntimeWorkContractV4 } from './contracts.js';
import { gitTextV4, runGit } from './git-runner.js';

const shaPattern = /^[a-f0-9]{40}$/;
const runPattern = /^run_[A-Za-z0-9_-]{1,92}$/;

export interface WorktreeRecordV4 {
  readonly run_id: string;
  readonly path: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly manifest_hash: string;
}

export interface WorktreeVerificationV4 {
  readonly valid: boolean;
  readonly head_sha: string;
  readonly clean: boolean;
}

export interface WorktreeManagerV4 {
  create(contract: RuntimeWorkContractV4): Promise<WorktreeRecordV4>;
  verify(record: WorktreeRecordV4): Promise<WorktreeVerificationV4>;
  markTerminal(runId: string, terminal: WorktreeTerminalV4): Promise<WorktreeReconciliationReportV4>;
  report(): Promise<WorktreeReconciliationReportV4>;
  reconcile(
    input: { readonly mode: 'REPORT' } | { readonly mode: 'APPLY'; readonly expected_report_hash: string },
  ): Promise<WorktreeReconciliationReportV4>;
}

export type WorktreeTerminalStateV4 = 'FINALIZED' | 'FAILED' | 'ABORTED';
export type WorktreeDispositionV4 = 'MERGED' | 'DISCARD_AFTER_RETENTION' | 'KEEP_BRANCH';
export type WorktreeClassificationV4 =
  | 'OWNED_ACTIVE'
  | 'OWNED_TERMINAL_RETAINED'
  | 'OWNED_TERMINAL_SAFE'
  | 'OWNED_TERMINAL_DIRTY'
  | 'OWNED_CLEANED'
  | 'UNOWNED'
  | 'INDETERMINATE';

export interface WorktreeTerminalV4 {
  readonly state: WorktreeTerminalStateV4;
  readonly disposition: WorktreeDispositionV4;
  readonly recorded_at: string;
  readonly evidence_hash: string;
}

export interface WorktreeReconciliationEntryV4 {
  readonly run_id: string | null;
  readonly path: string;
  readonly branch: string | null;
  readonly classification: WorktreeClassificationV4;
  readonly managed_bytes: number | null;
  readonly detail: string;
}

export interface WorktreeReconciliationReportV4 {
  readonly schema_version: 4;
  readonly repository_root: string;
  readonly worktree_parent: string;
  readonly entries: readonly WorktreeReconciliationEntryV4[];
  readonly report_hash: string;
}

interface WorktreeManifestV4 {
  readonly schema_version: 4;
  readonly run_id: string;
  readonly repository_root: string;
  readonly worktree_parent: string;
  readonly path: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly created_at: string;
  readonly ownership_nonce: string;
  readonly terminal: WorktreeTerminalV4 | null;
  readonly cleanup: { readonly cleaned_at: string; readonly worktree_removed: true; readonly branch_deleted: boolean } | null;
  readonly manifest_hash: string;
}

export interface WorktreeManagerOptionsV4 {
  readonly repository_root: string;
  readonly worktree_parent: string;
  readonly now?: () => string;
  readonly retention_seconds?: Readonly<Record<WorktreeTerminalStateV4, number>>;
  readonly quotas?: {
    readonly max_active_worktrees: number;
    readonly max_managed_worktrees: number;
    readonly max_managed_bytes: number;
  };
}

const hashPattern = /^[a-f0-9]{64}$/;
const metadataDirectoryName = '.agent-orchestration-worktrees-v4';
const defaultRetention = Object.freeze({ FINALIZED: 0, FAILED: 7 * 24 * 60 * 60, ABORTED: 24 * 60 * 60 });
const defaultQuotas = Object.freeze({ max_active_worktrees: 8, max_managed_worktrees: 32, max_managed_bytes: 20 * 1024 * 1024 * 1024 });
const terminalStates = new Set<WorktreeTerminalStateV4>(['FINALIZED', 'FAILED', 'ABORTED']);
const dispositions = new Set<WorktreeDispositionV4>(['MERGED', 'DISCARD_AFTER_RETENTION', 'KEEP_BRANCH']);

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function manifestBody(manifest: WorktreeManifestV4): Omit<WorktreeManifestV4, 'manifest_hash'> {
  const { manifest_hash: _manifestHash, ...body } = manifest;
  return body;
}

function sealManifest(body: Omit<WorktreeManifestV4, 'manifest_hash'>): WorktreeManifestV4 {
  return Object.freeze({ ...body, manifest_hash: hashCanonicalV4(body) });
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!(process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')) throw error;
  } finally {
    await handle.close();
  }
}

async function atomicManifest(path: string, manifest: WorktreeManifestV4): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJsonV4(manifest)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(resolve(path, '..'));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function directoryBytes(root: string, limit = 100_000): Promise<number | null> {
  let bytes = 0;
  let seen = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
    if (entries === null) return null;
    for (const entry of entries) {
      seen += 1;
      if (seen > limit) return null;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) bytes += (await stat(path).catch(() => null))?.size ?? 0;
    }
  }
  return bytes;
}

function worktreeMap(text: string): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const lines = block.split(/\r?\n/u);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null;
    result.set(resolve(path), branchRef?.startsWith('refs/heads/') === true ? branchRef.slice('refs/heads/'.length) : null);
  }
  return result;
}

export function createWorktreeManagerV4(input: WorktreeManagerOptionsV4): WorktreeManagerV4 {
  mkdirSync(input.worktree_parent, { recursive: true });
  const repositoryRoot = realpathSync.native(input.repository_root);
  const worktreeParent = realpathSync.native(input.worktree_parent);
  if (contains(repositoryRoot, worktreeParent) || contains(worktreeParent, repositoryRoot)) {
    throw new Error('BROKER_STATE_CORRUPT: worktree parent overlaps the active repository');
  }
  const metadataRoot = join(worktreeParent, metadataDirectoryName);
  const recordsRoot = join(metadataRoot, 'records');
  mkdirSync(recordsRoot, { recursive: true });
  const retention = Object.freeze({ ...defaultRetention, ...input.retention_seconds });
  const quotas = Object.freeze({ ...defaultQuotas, ...input.quotas });
  if (
    Object.values(retention).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    Object.values(quotas).some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error('BROKER_STATE_CORRUPT: invalid worktree lifecycle limits');
  }
  const now = input.now ?? (() => new Date().toISOString());
  let mutationTail: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const manifestPath = (runId: string): string => join(recordsRoot, `${runId}.json`);

  const loadManifests = async (): Promise<Array<{ manifest: WorktreeManifestV4 | null; file: string; error: string | null }>> => {
    const files = (await readdir(recordsRoot)).filter((file) => file.endsWith('.json')).sort();
    return Promise.all(
      files.map(async (file) => {
        try {
          const parsed = JSON.parse(await readFile(join(recordsRoot, file), 'utf8')) as WorktreeManifestV4;
          const terminalValid =
            parsed.terminal === null ||
            (typeof parsed.terminal === 'object' &&
              terminalStates.has(parsed.terminal.state) &&
              dispositions.has(parsed.terminal.disposition) &&
              validDate(parsed.terminal.recorded_at) &&
              hashPattern.test(parsed.terminal.evidence_hash));
          const cleanupValid =
            parsed.cleanup === null ||
            (typeof parsed.cleanup === 'object' &&
              validDate(parsed.cleanup.cleaned_at) &&
              parsed.cleanup.worktree_removed === true &&
              typeof parsed.cleanup.branch_deleted === 'boolean');
          const valid =
            parsed.schema_version === 4 &&
            runPattern.test(parsed.run_id) &&
            file === `${parsed.run_id}.json` &&
            shaPattern.test(parsed.base_sha) &&
            hashPattern.test(parsed.manifest_hash) &&
            parsed.manifest_hash === hashCanonicalV4(manifestBody(parsed)) &&
            parsed.repository_root === repositoryRoot &&
            parsed.worktree_parent === worktreeParent &&
            parsed.path === resolve(worktreeParent, parsed.run_id) &&
            contains(worktreeParent, parsed.path) &&
            parsed.branch === `codex/auto/${parsed.run_id}` &&
            validDate(parsed.created_at) &&
            hashPattern.test(parsed.ownership_nonce) &&
            terminalValid &&
            cleanupValid;
          return valid
            ? { manifest: parsed, file, error: null }
            : { manifest: null, file, error: 'manifest identity or self-hash is invalid' };
        } catch {
          return { manifest: null, file, error: 'manifest is unreadable' };
        }
      }),
    );
  };

  const verify = async (record: WorktreeRecordV4): Promise<WorktreeVerificationV4> => {
    const canonical = await realpath(record.path).catch(() => '');
    if (canonical === '' || !contains(worktreeParent, canonical)) return Object.freeze({ valid: false, head_sha: '', clean: false });
    const head = gitTextV4(await runGit(canonical, ['rev-parse', 'HEAD'])).trim();
    const branch = gitTextV4(await runGit(canonical, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const clean = (await runGit(canonical, ['status', '--porcelain=v2', '-z'])).stdout.length === 0;
    return Object.freeze({ valid: head === record.base_sha && branch === record.branch && clean, head_sha: head, clean });
  };

  const buildReport = async (): Promise<WorktreeReconciliationReportV4> => {
    const loaded = await loadManifests();
    const listed = worktreeMap(gitTextV4(await runGit(repositoryRoot, ['worktree', 'list', '--porcelain'])));
    const currentTime = Date.parse(now());
    const entries: WorktreeReconciliationEntryV4[] = [];
    const ownedPaths = new Set<string>();
    for (const item of loaded) {
      if (item.manifest === null) {
        entries.push(
          Object.freeze({
            run_id: null,
            path: join(recordsRoot, item.file),
            branch: null,
            classification: 'INDETERMINATE',
            managed_bytes: null,
            detail: item.error ?? 'invalid manifest',
          }),
        );
        continue;
      }
      const manifest = item.manifest;
      ownedPaths.add(manifest.path);
      if (manifest.cleanup !== null) {
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: 'OWNED_CLEANED',
            managed_bytes: 0,
            detail: 'durable cleanup tombstone',
          }),
        );
        continue;
      }
      const physical = await realpath(manifest.path).catch(() => '');
      const listedBranch = listed.get(resolve(manifest.path));
      if (physical === '' && listedBranch === undefined && manifest.terminal !== null) {
        const expiresAt = Date.parse(manifest.terminal.recorded_at) + retention[manifest.terminal.state] * 1000;
        const eligible = Number.isFinite(currentTime) && currentTime >= expiresAt;
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: eligible ? 'OWNED_TERMINAL_SAFE' : 'OWNED_TERMINAL_RETAINED',
            managed_bytes: 0,
            detail: eligible
              ? 'retention expired; exact owned path is already absent'
              : `retained until ${new Date(expiresAt).toISOString()}`,
          }),
        );
        continue;
      }
      if (physical === '' || !contains(worktreeParent, physical) || listedBranch !== manifest.branch) {
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: 'INDETERMINATE',
            managed_bytes: null,
            detail: 'owned path or Git registration does not match the manifest',
          }),
        );
        continue;
      }
      const managedBytes = await directoryBytes(physical);
      if (managedBytes === null) {
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: 'INDETERMINATE',
            managed_bytes: null,
            detail: 'managed tree could not be measured within the bounded traversal policy',
          }),
        );
        continue;
      }
      if (manifest.terminal === null) {
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: 'OWNED_ACTIVE',
            managed_bytes: managedBytes,
            detail: 'active managed worktree',
          }),
        );
        continue;
      }
      const expiresAt = Date.parse(manifest.terminal.recorded_at) + retention[manifest.terminal.state] * 1000;
      if (!Number.isFinite(currentTime) || currentTime < expiresAt) {
        entries.push(
          Object.freeze({
            run_id: manifest.run_id,
            path: manifest.path,
            branch: manifest.branch,
            classification: 'OWNED_TERMINAL_RETAINED',
            managed_bytes: managedBytes,
            detail: `retained until ${new Date(expiresAt).toISOString()}`,
          }),
        );
        continue;
      }
      const dirty = (await runGit(physical, ['status', '--porcelain=v2', '-z'])).stdout.length > 0;
      entries.push(
        Object.freeze({
          run_id: manifest.run_id,
          path: manifest.path,
          branch: manifest.branch,
          classification: dirty ? 'OWNED_TERMINAL_DIRTY' : 'OWNED_TERMINAL_SAFE',
          managed_bytes: managedBytes,
          detail: dirty ? 'retention expired; exact owned path requires forced removal' : 'retention expired; exact owned path is clean',
        }),
      );
    }
    const directoryEntries = await readdir(worktreeParent, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (entry.name === metadataDirectoryName) continue;
      const path = join(worktreeParent, entry.name);
      if (!ownedPaths.has(path))
        entries.push(
          Object.freeze({
            run_id: null,
            path,
            branch: null,
            classification: 'UNOWNED',
            managed_bytes: null,
            detail: 'no valid ownership manifest; no action permitted',
          }),
        );
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const body = Object.freeze({
      schema_version: 4 as const,
      repository_root: repositoryRoot,
      worktree_parent: worktreeParent,
      entries: Object.freeze(entries),
    });
    return Object.freeze({ ...body, report_hash: hashCanonicalV4(body) });
  };

  const branchExists = async (branch: string): Promise<boolean> =>
    runGit(repositoryRoot, ['show-ref', '--verify', `refs/heads/${branch}`]).then(
      () => true,
      () => false,
    );

  const applyReport = async (expectedReportHash: string): Promise<WorktreeReconciliationReportV4> => {
    const report = await buildReport();
    if (report.report_hash !== expectedReportHash) throw new Error('WORKTREE_CLEANUP_FAILED: report hash changed');
    const manifests = new Map(
      (await loadManifests()).flatMap((item) => (item.manifest === null ? [] : [[item.manifest.run_id, item.manifest] as const])),
    );
    for (const entry of report.entries) {
      if (!['OWNED_TERMINAL_SAFE', 'OWNED_TERMINAL_DIRTY'].includes(entry.classification) || entry.run_id === null) continue;
      const manifest = manifests.get(entry.run_id);
      if (manifest === undefined || manifest.terminal === null || manifest.cleanup !== null) continue;
      const refreshed = worktreeMap(gitTextV4(await runGit(repositoryRoot, ['worktree', 'list', '--porcelain'])));
      const registeredBranch = refreshed.get(resolve(manifest.path));
      if (registeredBranch !== undefined && registeredBranch !== manifest.branch)
        throw new Error('WORKTREE_CLEANUP_FAILED: worktree identity changed');
      if (registeredBranch === manifest.branch) {
        await runGit(
          repositoryRoot,
          entry.classification === 'OWNED_TERMINAL_DIRTY'
            ? ['worktree', 'remove', '--force', manifest.path]
            : ['worktree', 'remove', manifest.path],
        );
      } else if (
        await lstat(manifest.path).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error('WORKTREE_CLEANUP_FAILED: unregistered path occupies an owned location');
      }
      let branchDeleted = false;
      if (manifest.terminal.disposition !== 'KEEP_BRANCH' && (await branchExists(manifest.branch))) {
        await runGit(repositoryRoot, ['branch', '-D', manifest.branch]);
        branchDeleted = true;
      }
      const updated = sealManifest({
        ...manifestBody(manifest),
        cleanup: Object.freeze({ cleaned_at: now(), worktree_removed: true, branch_deleted: branchDeleted }),
      });
      await atomicManifest(manifestPath(manifest.run_id), updated);
    }
    return buildReport();
  };

  return Object.freeze({
    create: (contract: RuntimeWorkContractV4): Promise<WorktreeRecordV4> =>
      serialize(async () => {
        if (!shaPattern.test(contract.base_sha) || !runPattern.test(contract.run_id)) {
          throw new Error('OUT_OF_SCOPE_CHANGE: worktree identity is not immutable');
        }
        const preflight = await buildReport();
        await applyReport(preflight.report_hash);
        const current = await buildReport();
        if (current.entries.some((entry) => entry.classification === 'INDETERMINATE')) {
          throw new Error('WORKTREE_CREATION_FAILED: ownership state is indeterminate');
        }
        const active = current.entries.filter((entry) => entry.classification === 'OWNED_ACTIVE').length;
        const managed = current.entries.filter(
          (entry) => entry.classification.startsWith('OWNED_') && entry.classification !== 'OWNED_CLEANED',
        ).length;
        const bytes = current.entries.reduce((total, entry) => total + (entry.managed_bytes ?? 0), 0);
        if (active >= quotas.max_active_worktrees) throw new Error('WORKTREE_CREATION_FAILED: active worktree quota exceeded');
        if (managed >= quotas.max_managed_worktrees) throw new Error('WORKTREE_CREATION_FAILED: managed worktree quota exceeded');
        if (bytes >= quotas.max_managed_bytes) throw new Error('WORKTREE_CREATION_FAILED: managed byte quota exceeded');
        const exactBase = gitTextV4(await runGit(repositoryRoot, ['rev-parse', '--verify', `${contract.base_sha}^{commit}`])).trim();
        if (exactBase !== contract.base_sha) throw new Error('OUT_OF_SCOPE_CHANGE: base commit mismatch');
        const branch = `codex/auto/${contract.run_id}`;
        const worktreePath = resolve(worktreeParent, contract.run_id);
        if (
          !contains(worktreeParent, worktreePath) ||
          (await lstat(worktreePath).then(
            () => true,
            () => false,
          )) ||
          (await lstat(manifestPath(contract.run_id)).then(
            () => true,
            () => false,
          ))
        ) {
          throw new Error('BROKER_STATE_CORRUPT: worktree path is unavailable');
        }
        await runGit(repositoryRoot, ['worktree', 'add', '-b', branch, worktreePath, contract.base_sha]);
        try {
          const body = Object.freeze({
            schema_version: 4 as const,
            run_id: contract.run_id,
            repository_root: repositoryRoot,
            worktree_parent: worktreeParent,
            path: worktreePath,
            branch,
            base_sha: contract.base_sha,
            created_at: now(),
            ownership_nonce: hashCanonicalV4({
              run_id: contract.run_id,
              path: worktreePath,
              base_sha: contract.base_sha,
              created_at: now(),
            }),
            terminal: null,
            cleanup: null,
          });
          const manifest = sealManifest(body);
          await atomicManifest(manifestPath(contract.run_id), manifest);
          const record = Object.freeze({
            run_id: contract.run_id,
            path: worktreePath,
            branch,
            base_sha: contract.base_sha,
            manifest_hash: manifest.manifest_hash,
          });
          if (!(await verify(record)).valid) throw new Error('BROKER_STATE_CORRUPT: created worktree failed verification');
          return record;
        } catch (error) {
          await runGit(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
          if (await branchExists(branch)) await runGit(repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
          await unlink(manifestPath(contract.run_id)).catch(() => undefined);
          throw error;
        }
      }),
    verify,
    markTerminal: (runId: string, terminal: WorktreeTerminalV4) =>
      serialize(async () => {
        if (!runPattern.test(runId) || !validDate(terminal.recorded_at) || !hashPattern.test(terminal.evidence_hash)) {
          throw new Error('WORKTREE_CLEANUP_FAILED: terminal evidence is invalid');
        }
        const loaded = (await loadManifests()).find((item) => item.manifest?.run_id === runId)?.manifest;
        if (loaded === undefined || loaded === null || loaded.cleanup !== null)
          throw new Error('WORKTREE_CLEANUP_FAILED: owned active worktree not found');
        if (loaded.terminal !== null && canonicalJsonV4(loaded.terminal) !== canonicalJsonV4(terminal)) {
          throw new Error('WORKTREE_CLEANUP_FAILED: terminal evidence changed');
        }
        if (loaded.terminal === null)
          await atomicManifest(manifestPath(runId), sealManifest({ ...manifestBody(loaded), terminal: Object.freeze({ ...terminal }) }));
        const report = await buildReport();
        return applyReport(report.report_hash);
      }),
    report: () => serialize(buildReport),
    reconcile: (request: { readonly mode: 'REPORT' } | { readonly mode: 'APPLY'; readonly expected_report_hash: string }) =>
      serialize(async () => (request.mode === 'REPORT' ? buildReport() : applyReport(request.expected_report_hash))),
  });
}
