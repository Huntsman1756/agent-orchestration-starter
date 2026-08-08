import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 as win32Path } from 'node:path';
import test from 'node:test';

import { inspectAllowedChanges, type PathMetadataProviderV4 } from '../src/runtime/path-policy.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runner-v4-paths-'));
  const external = mkdtempSync(join(tmpdir(), 'runner-v4-external-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'normal.ts'), 'export {};');
  writeFileSync(join(external, 'sentinel.txt'), 'outside');
  symlinkSync(external, join(root, 'escape'), 'junction');
  return root;
}

async function launchAfterInspection(
  root: string,
  changes: readonly { path: string; operations: readonly ('CREATE' | 'MODIFY' | 'DELETE')[] }[],
  executor: () => void,
  extra: Record<string, unknown> = {},
) {
  await inspectAllowedChanges({
    repositoryRoot: root,
    changes,
    platform: process.platform,
    ...extra,
  });
  executor();
}

function virtualWindowsMetadata(options: {
  canonicalParents?: Readonly<Record<string, string>>;
  deviceIds?: Readonly<Record<string, number>>;
  existingFiles?: readonly string[];
  mountIds?: Readonly<Record<string, string>>;
  reparsePaths?: readonly string[];
} = {}): PathMetadataProviderV4 {
  const root = 'C:\\repo';
  const source = 'C:\\repo\\src';
  const directories = new Set([root, source, ...Object.values(options.canonicalParents ?? {})]);
  const existingPaths = new Set([...directories, ...(options.existingFiles ?? [])]);
  const reparsePaths = new Set(options.reparsePaths ?? []);
  const entry = (path: string, isDirectory: boolean) => ({
    isDirectory: () => isDirectory,
    isSymbolicLink: () => false,
    dev: options.deviceIds?.[path] ?? 7,
  });
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {
    realpath: async (path) => {
      if (existingPaths.has(path)) return options.canonicalParents?.[path] ?? path;
      throw missing();
    },
    lstat: async (path) => {
      if (existingPaths.has(path)) return entry(path, directories.has(path));
      throw missing();
    },
    stat: async (path) => {
      if (existingPaths.has(path)) return entry(path, directories.has(path));
      throw missing();
    },
    mountIdentity: async (path) => options.mountIds?.[path] ?? 'volume-guid-a',
    isReparsePoint: async (path) => reparsePaths.has(path),
  };
}

test('records the canonical parent and existence of a safe allowed change', async () => {
  const root = fixture();

  const [change] = await inspectAllowedChanges({
    repositoryRoot: root,
    changes: [{ path: 'src/normal.ts', operations: ['MODIFY'] }],
    platform: process.platform,
  });

  assert.equal(change.existed_at_freeze, true);
  assert.match(change.canonical_parent.replaceAll('\\', '/'), /\/src$/);
});

test('rejects symlink escapes and prevents executor launch', async () => {
  const root = fixture();
  let launched = false;

  await assert.rejects(
    () => launchAfterInspection(root, [{ path: 'escape/sentinel.txt', operations: ['MODIFY'] }], () => { launched = true; }),
    /OUT_OF_SCOPE_CHANGE/,
  );

  assert.equal(launched, false);
});

test('rejects a missing path below a symlinked parent before launch', async () => {
  const root = fixture();
  let launched = false;

  await assert.rejects(
    () => launchAfterInspection(root, [{ path: 'escape/new-file.ts', operations: ['MODIFY'] }], () => { launched = true; }),
    /OUT_OF_SCOPE_CHANGE/,
  );

  assert.equal(launched, false);
});

test('rejects every lexical unsafe path before the executor launches', async () => {
  const root = fixture();
  const unsafeChanges = [
    [{ path: 'src/normal.ts:stream', operations: ['MODIFY'] }],
    [
      { path: 'src/Normal.ts', operations: ['MODIFY'] },
      { path: 'src/normal.ts', operations: ['MODIFY'] },
    ],
  ] as const;

  for (const changes of unsafeChanges) {
    let launched = false;
    await assert.rejects(
      () => launchAfterInspection(root, changes, () => { launched = true; }),
      /OUT_OF_SCOPE_CHANGE/,
    );
    assert.equal(launched, false);
  }
});

test('rejects a same-device mount identity change before the executor launches', async () => {
  let launched = false;
  await assert.rejects(
    () => launchAfterInspection('C:\\repo', [{ path: 'src/new.ts', operations: ['CREATE'] }], () => { launched = true; }, {
      pathApi: win32Path,
      metadata: virtualWindowsMetadata({ mountIds: { 'C:\\repo': 'volume-guid-a', 'C:\\repo\\src': 'volume-guid-b' } }),
    }),
    /mount identity changed/,
  );
  assert.equal(launched, false);
});

test('rejects an existing final target with a different mount identity before the executor launches', async () => {
  let launched = false;
  await assert.rejects(
    () => launchAfterInspection('C:\\repo', [{ path: 'src/mounted.ts', operations: ['MODIFY'] }], () => { launched = true; }, {
      pathApi: win32Path,
      metadata: virtualWindowsMetadata({
        existingFiles: ['C:\\repo\\src\\mounted.ts'],
        mountIds: { 'C:\\repo': 'volume-guid-a', 'C:\\repo\\src\\mounted.ts': 'volume-guid-b' },
      }),
    }),
    /mount identity changed/,
  );
  assert.equal(launched, false);
});

test('rejects a non-final parent with a different device before the executor launches', async () => {
  let launched = false;
  await assert.rejects(
    () => launchAfterInspection('C:\\repo', [{ path: 'src/nested/new.ts', operations: ['CREATE'] }], () => { launched = true; }, {
      pathApi: win32Path,
      metadata: virtualWindowsMetadata({
        canonicalParents: { 'C:\\repo\\src\\nested': 'C:\\repo\\src\\nested' },
        deviceIds: { 'C:\\repo\\src': 99 },
      }),
    }),
    /device differs/,
  );
  assert.equal(launched, false);
});

test('permits a create for a nonexistent final leaf after its parent chain is proven', async () => {
  let launched = false;
  await launchAfterInspection('C:\\repo', [{ path: 'src/new.ts', operations: ['CREATE'] }], () => { launched = true; }, {
    pathApi: win32Path,
    metadata: virtualWindowsMetadata(),
  });

  assert.equal(launched, true);
});

test('rejects generic Windows reparse metadata before the executor launches', async () => {
  let launched = false;
  await assert.rejects(
    () => launchAfterInspection('C:\\repo', [{ path: 'src/new.ts', operations: ['CREATE'] }], () => { launched = true; }, {
      pathApi: win32Path,
      metadata: virtualWindowsMetadata({ reparsePaths: ['C:\\repo\\src'] }),
    }),
    /reparse metadata/,
  );
  assert.equal(launched, false);
});

test('rejects a Windows cross-volume canonical parent before the executor launches', async () => {
  let launched = false;
  await assert.rejects(
    () => launchAfterInspection('C:\\repo', [{ path: 'src/new.ts', operations: ['CREATE'] }], () => { launched = true; }, {
      pathApi: win32Path,
      metadata: virtualWindowsMetadata({ canonicalParents: { 'C:\\repo\\src': 'D:\\external' } }),
    }),
    /canonical parent outside repository root/,
  );
  assert.equal(launched, false);
});

test('deep-freezes inspected operations against caller mutation', async () => {
  const root = fixture();
  const operations: ('MODIFY' | 'DELETE')[] = ['MODIFY'];
  const [inspected] = await inspectAllowedChanges({
    repositoryRoot: root,
    changes: [{ path: 'src/normal.ts', operations }],
    platform: process.platform,
  });

  operations[0] = 'DELETE';

  assert.deepEqual(inspected.operations, ['MODIFY']);
  assert.equal(Object.isFrozen(inspected.operations), true);
});

test('rejects unsupported platform metadata before the executor launches', async () => {
  const root = fixture();
  let launched = false;

  await assert.rejects(
    () => launchAfterInspection(root, [{ path: 'src/normal.ts', operations: ['MODIFY'] }], () => { launched = true; }, { platform: 'aix' }),
    /mount identity unavailable/,
  );

  assert.equal(launched, false);
});
