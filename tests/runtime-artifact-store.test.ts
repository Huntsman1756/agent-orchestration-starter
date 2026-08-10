import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createArtifactStoreV4 } from '../src/runtime/artifact-store.js';

test('stores bytes create-exclusively under a content address and verifies them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-artifacts-'));
  const store = createArtifactStoreV4({ root, max_artifact_bytes: 1024 });
  const bytes = new TextEncoder().encode('full validation output\n');
  const first = await store.put('VALIDATION_STDOUT', bytes);
  const second = await store.put('VALIDATION_STDOUT', bytes);
  assert.deepEqual(second, first);
  assert.equal(await store.verify(first), true);
  assert.deepEqual(new Uint8Array(await readFile(join(root, first.storage_key))), bytes);
});

test('detects tampering and rejects oversized or forged references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-artifacts-'));
  const store = createArtifactStoreV4({ root, max_artifact_bytes: 8 });
  await assert.rejects(() => store.put('VALIDATION_STDOUT', new Uint8Array(9)), /VALIDATION_FAILED/);
  const reference = await store.put('VALIDATION_STDERR', new TextEncoder().encode('error'));
  await writeFile(join(root, reference.storage_key), 'tampered');
  assert.equal(await store.verify(reference), false);
  assert.equal(await store.verify({ ...reference, storage_key: '../escape' }), false);
});
