import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface PackageManifest {
  files?: string[];
  license?: string;
  scripts?: Record<string, string>;
}

test('package metadata constrains published files and validates before publish', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;

  assert.deepEqual(manifest.files, [
    'contracts/**',
    'dist/**',
    'docs/runtime-broker-quarantine-remediation.md',
    'docs/runtime-v4-operations.md',
    'examples/**',
    'LICENSE',
    'native/**',
    'orchestration.yaml',
    'policies/**',
    'profiles/**',
    'routing-gate.yaml',
    'scripts/build-linux-native-helper.mjs',
    'README.md',
  ]);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.scripts?.prepublishOnly, 'npm run validate');
});
