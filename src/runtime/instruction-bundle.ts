import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';
import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import { runGit } from './git-runner.js';

export interface InstructionBundleEntryV4 {
  readonly source_path: string;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly capsule_path: string;
}

export interface InstructionBundleV4 {
  readonly entries: readonly InstructionBundleEntryV4[];
  readonly total_bytes: number;
  readonly manifest_hash: string;
}

export interface InstructionBundleInputV4 {
  readonly repository_root: string;
  readonly base_sha: string;
  readonly approved_sources: readonly string[];
  readonly output_root: string;
  readonly max_total_bytes?: number;
}

export async function buildInstructionBundle(input: InstructionBundleInputV4): Promise<InstructionBundleV4> {
  if (!/^[a-f0-9]{40}$/.test(input.base_sha)) throw new Error('OUT_OF_SCOPE_CHANGE: instruction base must be an exact commit');
  const maximum = input.max_total_bytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('OUT_OF_SCOPE_CHANGE: instruction byte policy is invalid');
  await mkdir(input.output_root, { recursive: true });
  let total = 0;
  const seen = new Set<string>();
  const entries: InstructionBundleEntryV4[] = [];
  for (const source of input.approved_sources) {
    if (!isNormalizedRepositoryRelativePathV4(source) || seen.has(source.toLowerCase())) {
      throw new Error('OUT_OF_SCOPE_CHANGE: instruction source is invalid or ambiguous');
    }
    seen.add(source.toLowerCase());
    const content = (await runGit(input.repository_root, ['show', `${input.base_sha}:${source}`])).stdout;
    if (content.includes(0)) throw new Error('OUT_OF_SCOPE_CHANGE: instruction source is not bounded text');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new Error('OUT_OF_SCOPE_CHANGE: instruction source is not UTF-8 text');
    }
    total += content.length;
    if (total > maximum) throw new Error('OUT_OF_SCOPE_CHANGE: instruction bundle exceeds byte limit');
    const hash = createHash('sha256').update(content).digest('hex');
    const capsulePath = `${hash.slice(0, 16)}-${basename(source)}`;
    await writeFile(join(input.output_root, capsulePath), content, { flag: 'wx', mode: 0o600 });
    entries.push(Object.freeze({ source_path: source, content_hash: hash, byte_length: content.length, capsule_path: capsulePath }));
  }
  entries.sort((left, right) => (left.source_path < right.source_path ? -1 : left.source_path > right.source_path ? 1 : 0));
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    entries: frozenEntries,
    total_bytes: total,
    manifest_hash: hashCanonicalV4({ schema_version: 4, entries: frozenEntries, total_bytes: total }),
  });
}
