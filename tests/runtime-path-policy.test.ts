import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectAllowedChanges } from '../src/runtime/path-policy.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runner-v4-paths-'));
  const external = mkdtempSync(join(tmpdir(), 'runner-v4-external-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'normal.ts'), 'export {};');
  writeFileSync(join(external, 'sentinel.txt'), 'outside');
  symlinkSync(external, join(root, 'escape'), 'junction');
  return root;
}

async function launchAfterInspection(root: string, path: string, executor: () => void) {
  await inspectAllowedChanges({
    repositoryRoot: root,
    changes: [{ path, operations: ['MODIFY'] }],
    platform: 'win32',
  });
  executor();
}

test('records the canonical parent and existence of a safe allowed change', async () => {
  const root = fixture();

  const [change] = await inspectAllowedChanges({
    repositoryRoot: root,
    changes: [{ path: 'src/normal.ts', operations: ['MODIFY'] }],
    platform: 'win32',
  });

  assert.equal(change.existed_at_freeze, true);
  assert.match(change.canonical_parent.replaceAll('\\', '/'), /\/src$/);
});

test('rejects symlink escapes and prevents executor launch', async () => {
  const root = fixture();
  let launched = false;

  await assert.rejects(
    () => launchAfterInspection(root, 'escape/sentinel.txt', () => { launched = true; }),
    /OUT_OF_SCOPE_CHANGE/,
  );

  assert.equal(launched, false);
});

test('rejects a missing path below a symlinked parent before launch', async () => {
  const root = fixture();
  let launched = false;

  await assert.rejects(
    () => launchAfterInspection(root, 'escape/new-file.ts', () => { launched = true; }),
    /OUT_OF_SCOPE_CHANGE/,
  );

  assert.equal(launched, false);
});

test('rejects Windows ADS-shaped names and case-fold collisions', async () => {
  const root = fixture();

  await assert.rejects(
    () => inspectAllowedChanges({
      repositoryRoot: root,
      changes: [{ path: 'src/normal.ts:stream', operations: ['MODIFY'] }],
      platform: 'win32',
    }),
    /OUT_OF_SCOPE_CHANGE/,
  );
  await assert.rejects(
    () => inspectAllowedChanges({
      repositoryRoot: root,
      changes: [
        { path: 'src/Normal.ts', operations: ['MODIFY'] },
        { path: 'src/normal.ts', operations: ['MODIFY'] },
      ],
      platform: 'win32',
    }),
    /OUT_OF_SCOPE_CHANGE/,
  );
});
