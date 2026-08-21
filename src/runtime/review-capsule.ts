import { createHash, randomBytes } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import type { ReviewEnvelopeV4 } from './review-envelope.js';

export interface ReviewContextV4 {
  readonly path: string;
  readonly content: string;
  readonly content_hash: string;
}
export interface ReviewCapsuleInputV4 {
  readonly capsule_parent: string;
  readonly envelope: ReviewEnvelopeV4;
  readonly forbidden_roots: readonly string[];
  readonly approved_context: readonly ReviewContextV4[];
}
export interface ReviewCapsuleV4 {
  readonly root: string;
  readonly manifest_hash: string;
}

function invalid(message: string): never {
  throw new Error(`REVIEW_ATTESTATION_INVALID: ${message}`);
}
function within(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

export async function buildReviewCapsule(input: ReviewCapsuleInputV4): Promise<ReviewCapsuleV4> {
  const { envelope_hash: suppliedEnvelopeHash, ...envelopeBody } = input.envelope;
  if (
    input.approved_context.length > 64 ||
    !/^[a-f0-9]{64}$/.test(suppliedEnvelopeHash) ||
    suppliedEnvelopeHash !== hashCanonicalV4(envelopeBody)
  )
    invalid('capsule input is invalid');
  await mkdir(input.capsule_parent, { recursive: true, mode: 0o700 });
  const parent = await realpath(input.capsule_parent);
  for (const forbidden of input.forbidden_roots) {
    const physical = await realpath(forbidden).catch(() => resolve(forbidden));
    if (within(parent, physical) || within(physical, parent)) invalid('review capsule overlaps a forbidden root');
  }
  const root = join(parent, `review_${randomBytes(16).toString('hex')}`);
  await mkdir(root, { mode: 0o700 });
  const contextRoot = join(root, 'context');
  await mkdir(contextRoot, { mode: 0o700 });
  const files: Array<{ path: string; content_hash: string; byte_length: number }> = [];
  const put = async (path: string, bytes: Buffer): Promise<void> => {
    await writeFile(join(root, path), bytes, { flag: 'wx', mode: 0o400 });
    files.push({ path, content_hash: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length });
  };
  await put('envelope.json', Buffer.from(`${canonicalJsonV4(input.envelope)}\n`));
  const schema = await readFile(new URL('../../contracts/review-attestation-v4.schema.json', import.meta.url));
  await put('review-attestation-v4.schema.json', schema);
  let total = 0;
  const seen = new Set<string>();
  const contextIndex: Array<{ path: string; content_hash: string; byte_length: number }> = [];
  for (const item of input.approved_context) {
    const bytes = Buffer.from(item.content, 'utf8');
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (!isNormalizedRepositoryRelativePathV4(item.path) || actual !== item.content_hash || seen.has(item.path.toLowerCase()))
      invalid('approved review context is invalid');
    seen.add(item.path.toLowerCase());
    total += bytes.length;
    if (total > 256 * 1024) invalid('approved review context exceeds policy');
    await put(`context/${actual}.txt`, bytes);
    contextIndex.push({ path: item.path, content_hash: actual, byte_length: bytes.length });
  }
  contextIndex.sort((a, b) => a.path.localeCompare(b.path));
  await put('context-index.json', Buffer.from(`${canonicalJsonV4({ schema_version: 4, entries: contextIndex })}\n`));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestBody = { schema_version: 4, envelope_hash: input.envelope.envelope_hash, files };
  const manifestHash = hashCanonicalV4(manifestBody);
  await writeFile(join(root, 'manifest.json'), `${canonicalJsonV4({ ...manifestBody, manifest_hash: manifestHash })}\n`, {
    flag: 'wx',
    mode: 0o400,
  });
  return Object.freeze({ root, manifest_hash: manifestHash });
}
