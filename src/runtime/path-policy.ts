import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import type { AllowedChangeV4 } from './contracts.js';

export interface PathInspectionInputV4 {
  repositoryRoot: string;
  changes: readonly AllowedChangeV4[];
  platform: NodeJS.Platform;
}

export interface InspectedChangeV4 extends AllowedChangeV4 {
  canonical_parent: string;
  existed_at_freeze: boolean;
}

function outOfScope(message: string): never {
  throw new Error(`OUT_OF_SCOPE_CHANGE: ${message}`);
}

function withinRoot(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const from = platform === 'win32' ? root.toLocaleLowerCase() : root;
  const to = platform === 'win32' ? candidate.toLocaleLowerCase() : candidate;
  const pathToCandidate = relative(from, to);
  return pathToCandidate === '' || (!pathToCandidate.startsWith(`..${sep}`) && pathToCandidate !== '..' && !pathToCandidate.startsWith('..'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function inspectAllowedChanges(input: PathInspectionInputV4): Promise<readonly InspectedChangeV4[]> {
  const canonicalRoot = await realpath(input.repositoryRoot).catch(() => outOfScope('repository root cannot be canonicalized'));
  const rootStats = await stat(canonicalRoot);
  if (!rootStats.isDirectory()) outOfScope('repository root is not a directory');

  const seen = new Set<string>();
  const inspected: InspectedChangeV4[] = [];
  for (const change of input.changes) {
    if (!isNormalizedRepositoryRelativePathV4(change.path)) outOfScope(`invalid path: ${change.path}`);
    const folded = input.platform === 'win32' ? change.path.toLocaleLowerCase() : change.path;
    if (seen.has(folded)) outOfScope(`case-fold collision: ${change.path}`);
    seen.add(folded);

    const candidate = resolve(canonicalRoot, ...change.path.split('/'));
    if (!withinRoot(canonicalRoot, candidate, input.platform)) outOfScope(`outside repository root: ${change.path}`);
    const parent = dirname(candidate);
    const canonicalParent = await realpath(parent).catch(() => outOfScope(`parent cannot be canonicalized: ${change.path}`));
    if (!withinRoot(canonicalRoot, canonicalParent, input.platform)) outOfScope(`canonical parent outside repository root: ${change.path}`);
    if ((await stat(canonicalParent)).dev !== rootStats.dev) outOfScope(`parent mount differs from repository root: ${change.path}`);

    let current = canonicalRoot;
    for (const segment of change.path.split('/').slice(0, -1)) {
      current = resolve(current, segment);
      if (!(await exists(current))) break;
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) outOfScope(`reparse path component: ${change.path}`);
      const resolved = await realpath(current);
      if (resolved !== current) outOfScope(`canonical path component changed: ${change.path}`);
    }
    if (await exists(candidate)) {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink()) outOfScope(`reparse target: ${change.path}`);
    }
    inspected.push(Object.freeze({ ...change, canonical_parent: canonicalParent, existed_at_freeze: await exists(candidate) }));
  }
  return Object.freeze(inspected);
}
