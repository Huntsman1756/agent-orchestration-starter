import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUNTIME_BROKER_VERSION_V4 } from '../src/runtime/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('sandbox qualification broker identity tracks the released package version', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
  assert.equal(RUNTIME_BROKER_VERSION_V4, `${manifest.version}-v4`);
});
