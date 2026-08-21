import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';
import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import type { AllowedChangeV4, ChangeOperationV4 } from './contracts.js';
import { gitTextV4, runGit } from './git-runner.js';

export const ECONOMY_POLICY_REPAIR_INSTRUCTION_V4 =
  'Intentaste modificar los tests de aceptación. Esto está prohibido por el contrato. Solo modifica los archivos de implementación.';

export class EconomyPolicyViolationErrorV4 extends Error {
  readonly code = 'ECONOMY_POLICY_VIOLATION' as const;
  readonly violation_path: string;
  readonly repair_instruction = ECONOMY_POLICY_REPAIR_INSTRUCTION_V4;
  readonly evidence_hash: string;

  constructor(path: string) {
    super(`ECONOMY_POLICY_VIOLATION: ${ECONOMY_POLICY_REPAIR_INSTRUCTION_V4} Path: ${path}`);
    this.name = 'EconomyPolicyViolationErrorV4';
    this.violation_path = path;
    this.evidence_hash = hashCanonicalV4({ schema_version: 4, code: this.code, path, repair_instruction: this.repair_instruction });
  }
}

export interface DiffPolicyInputV4 {
  readonly repository_root: string;
  readonly base_sha: string;
  readonly allowed_changes: readonly AllowedChangeV4[];
  readonly acceptance_tests?: readonly string[];
  readonly reject_acceptance_test_changes?: boolean;
  readonly max_files_changed: number;
  readonly max_changed_lines: number;
}

export interface EconomyDiffPolicyInputV4 extends Omit<
  DiffPolicyInputV4,
  'allowed_changes' | 'acceptance_tests' | 'reject_acceptance_test_changes'
> {
  readonly acceptance_tests: readonly string[];
  readonly implementation_targets: readonly AllowedChangeV4[];
}

export interface DiffPolicyChangeV4 {
  readonly path: string;
  readonly operation: ChangeOperationV4;
  readonly content_hash: string | null;
}

export interface DiffPolicyResultV4 {
  readonly changes: readonly DiffPolicyChangeV4[];
  readonly changed_files: number;
  readonly changed_lines: number;
  readonly diff_hash: string;
  readonly tree_hash: string;
}

function reject(message: string): never {
  throw new Error(`OUT_OF_SCOPE_CHANGE: ${message}`);
}
function rejectEconomyPolicy(path: string): never {
  throw new EconomyPolicyViolationErrorV4(path);
}
function nulFields(buffer: Buffer): string[] {
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(buffer)
      .split('\0')
      .filter((value) => value.length > 0);
  } catch {
    return reject('Git emitted a non-UTF-8 path');
  }
}

export async function enforceDiffPolicy(input: DiffPolicyInputV4): Promise<DiffPolicyResultV4> {
  if (!/^[a-f0-9]{40}$/.test(input.base_sha)) reject('diff base must be an exact commit');
  const allowed = new Map<string, AllowedChangeV4>();
  for (const change of input.allowed_changes) {
    if (!isNormalizedRepositoryRelativePathV4(change.path) || allowed.has(change.path.toLowerCase()))
      reject(`ambiguous allowed path: ${change.path}`);
    allowed.set(change.path.toLowerCase(), change);
  }

  const classified = new Map<string, ChangeOperationV4>();
  const trackedChangedPaths = new Set<string>();
  const acceptanceTests = new Set((input.acceptance_tests ?? []).map((path) => path.toLocaleLowerCase('en-US')));
  const names = nulFields(
    (await runGit(input.repository_root, ['diff', '--name-status', '-z', '--no-renames', input.base_sha, '--'])).stdout,
  );
  for (let index = 0; index < names.length; index += 2) {
    const status = names[index] ?? '';
    const path = names[index + 1] ?? '';
    const operation =
      status === 'A'
        ? 'CREATE'
        : status === 'M'
          ? 'MODIFY'
          : status === 'D'
            ? 'DELETE'
            : reject(`unsupported Git change status: ${status}`);
    classified.set(path, operation);
    trackedChangedPaths.add(path);
  }
  for (const path of nulFields((await runGit(input.repository_root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout)) {
    if (classified.has(path)) reject(`duplicate changed path: ${path}`);
    classified.set(path, 'CREATE');
  }

  const raw = nulFields((await runGit(input.repository_root, ['diff', '--raw', '-z', '--no-renames', input.base_sha, '--'])).stdout);
  for (let index = 0; index < raw.length; index += 2) {
    const header = raw[index] ?? '';
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [AMD]$/.exec(header);
    if (match === null) reject('unparseable raw Git change');
    const [oldMode, newMode] = [match[1]!, match[2]!];
    if (['120000', '160000'].includes(oldMode) || ['120000', '160000'].includes(newMode)) reject('symlink or submodule change');
    if (oldMode !== '000000' && newMode !== '000000' && oldMode !== newMode) reject('file mode change');
  }

  let changedLines = 0;
  for (const record of nulFields(
    (await runGit(input.repository_root, ['diff', '--numstat', '-z', '--no-renames', input.base_sha, '--'])).stdout,
  )) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (match === null || match[1] === '-' || match[2] === '-') reject('binary or unparseable diff');
    changedLines += Number(match[1]) + Number(match[2]);
  }

  const changes: DiffPolicyChangeV4[] = [];
  for (const [path, operation] of [...classified].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (!isNormalizedRepositoryRelativePathV4(path)) reject(`invalid changed path: ${path}`);
    if (input.reject_acceptance_test_changes === true && acceptanceTests.has(path.toLocaleLowerCase('en-US'))) rejectEconomyPolicy(path);
    const policy = allowed.get(path.toLowerCase());
    if (policy === undefined || policy.path !== path || !policy.operations.includes(operation))
      reject(`change not allowed: ${path} (${operation})`);
    let contentHash: string | null = null;
    if (operation !== 'DELETE') {
      const metadata = await lstat(join(input.repository_root, ...path.split('/')));
      if (!metadata.isFile() || metadata.isSymbolicLink()) reject(`non-regular changed path: ${path}`);
      const content = await readFile(join(input.repository_root, ...path.split('/')));
      contentHash = createHash('sha256').update(content).digest('hex');
      if (operation === 'CREATE' && !trackedChangedPaths.has(path))
        changedLines += content.length === 0 ? 0 : content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
    }
    changes.push(Object.freeze({ path, operation, content_hash: contentHash }));
  }
  if (changes.length > input.max_files_changed) reject('changed file limit exceeded');
  if (changedLines > input.max_changed_lines) reject('changed line limit exceeded');
  const frozen = Object.freeze(changes);
  return Object.freeze({
    changes: frozen,
    changed_files: changes.length,
    changed_lines: changedLines,
    diff_hash: hashCanonicalV4({ schema_version: 4, base_sha: input.base_sha, changes: frozen }),
    tree_hash: hashCanonicalV4({ schema_version: 4, parent_tree: input.base_sha, applied_changes: frozen }),
  });
}

/**
 * Economy-only write interceptor. The whole repository remains readable, but
 * only implementation_targets are writable and acceptance_tests are immutable.
 * It runs against the observed Git tree, so a model cannot smuggle a test edit
 * through a different tool or an untracked-file path.
 */
export async function interceptEconomyDiffV4(input: EconomyDiffPolicyInputV4): Promise<DiffPolicyResultV4> {
  return enforceDiffPolicy({
    ...input,
    allowed_changes: input.implementation_targets,
    acceptance_tests: input.acceptance_tests,
    reject_acceptance_test_changes: true,
  });
}
