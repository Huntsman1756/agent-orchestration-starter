import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildReviewCapsule } from '../src/runtime/review-capsule.js';
import { hashCanonicalV4 } from '../src/runtime/canonical.js';

test('materializes only immutable evidence and approved content outside the worktree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ao-review-parent-'));
  const worktree = await mkdtemp(join(tmpdir(), 'ao-review-worktree-'));
  await writeFile(join(worktree, 'sentinel.txt'), 'must stay invisible');
  const envelopeBody = { schema_version: 4 };
  const envelope = { ...envelopeBody, envelope_hash: hashCanonicalV4(envelopeBody) } as any;
  const content = 'export const x = 1;\n';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const capsule = await buildReviewCapsule({
    capsule_parent: parent,
    envelope,
    forbidden_roots: [worktree],
    approved_context: [{ path: 'src/x.ts', content, content_hash: contentHash }],
  });
  assert.deepEqual((await readdir(capsule.root)).sort(), [
    'context',
    'context-index.json',
    'envelope.json',
    'manifest.json',
    'review-attestation-v4.schema.json',
  ]);
  assert.deepEqual(await readdir(join(capsule.root, 'context')), [contentHash + '.txt']);
  assert.doesNotMatch(JSON.stringify(capsule), new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
