import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { build_capability_snapshot } from '../src/routing/capability-snapshot.js';

function contract(overrides: Record<string, unknown> = {}) {
  return {
    repository_id: 'fixture',
    base_sha: 'a'.repeat(40),
    implementation_targets: [{ path: 'src/A.ts', operations: ['MODIFY'] }],
    acceptance_tests: ['tests/A.test.ts'],
    ...overrides,
  } as any;
}

test('resolves only static local dependencies and excludes unrelated repository files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-capability-snapshot-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'src', 'A.ts'), "import { B } from './B.js';\nexport const a: B = { value: 'a' };\n");
    await writeFile(join(root, 'src', 'B.ts'), 'export interface B { value: string }\nexport const b = 1;\n');
    await writeFile(join(root, 'src', 'Z.ts'), 'export const unrelated = "must not enter the snapshot";\n');
    await writeFile(join(root, 'tests', 'A.test.ts'), "import { a } from '../src/A.js';\nvoid a;\n");

    const snapshot = await build_capability_snapshot(contract(), { repository_root: root });
    const paths = snapshot.files.map((file) => file.path);
    assert.deepEqual(paths, ['src/A.ts', 'src/B.ts', 'tests/A.test.ts']);
    assert.equal(paths.includes('src/Z.ts'), false);
    assert.equal(snapshot.mode, 'FULL');
    assert.match(snapshot.rendered_context, /<file path="src\/B\.ts"/);
    assert.doesNotMatch(snapshot.rendered_context, /src\/Z\.ts/);
    assert.match(snapshot.snapshot_hash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to root files plus exported dependency signatures when the context limit is exceeded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-capability-fallback-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(join(root, 'src', 'A.ts'), "import { Contract } from './B.js';\nexport const a: Contract = { value: 'a' };\n");
    await writeFile(
      join(root, 'src', 'B.ts'),
      `export interface Contract { value: string }\nexport const implementation = '${'x'.repeat(30_000)}';\n`,
    );
    await writeFile(join(root, 'tests', 'A.test.ts'), "import { a } from '../src/A.js';\nvoid a;\n");

    const snapshot = await build_capability_snapshot(contract(), { repository_root: root, max_bytes: 8 * 1024 });
    assert.equal(snapshot.mode, 'SIGNATURE_FALLBACK');
    const dependency = snapshot.files.find((file) => file.path === 'src/B.ts');
    assert.equal(dependency?.mode, 'EXPORTED_SIGNATURES');
    assert.match(dependency?.content ?? '', /interface Contract/);
    assert.doesNotMatch(dependency?.content ?? '', /implementation =/);
    assert.ok(snapshot.total_bytes <= 8 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not evaluate dynamic imports and records them as ignored static-analysis edges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-capability-dynamic-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests'), { recursive: true });
    await writeFile(
      join(root, 'src', 'A.ts'),
      "const modulePath = './Z.js';\nexport async function load() { return import(modulePath); }\n",
    );
    await writeFile(join(root, 'src', 'Z.ts'), 'export const secret = 1;\n');
    await writeFile(join(root, 'tests', 'A.test.ts'), "import { load } from '../src/A.js';\nvoid load;\n");

    const snapshot = await build_capability_snapshot(contract(), { repository_root: root });
    assert.equal(
      snapshot.files.some((file) => file.path === 'src/Z.ts'),
      false,
    );
    assert.ok(snapshot.ignored_dynamic_imports.some((entry) => entry.includes('dynamic-import-ignored')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
