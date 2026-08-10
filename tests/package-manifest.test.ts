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
    'docs/activation-readiness-v4.md',
    'docs/iterative-executor-v4.md',
    'docs/model-guidance-v4.md',
    'docs/publication-v4.md',
    'docs/runtime-v4-operations.md',
    'docs/host-installation-v4.md',
    'docs/autonomous-dispatcher-v4.md',
    'examples/**',
    'CHANGELOG.md',
    'LICENSE',
    'native/**',
    'orchestration.yaml',
    'policies/**',
    'profiles/**',
    'routing-gate.yaml',
    'scripts/build-linux-native-helper.mjs',
    'scripts/build-host-bundle.mjs',
    'README.md',
  ]);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.scripts?.prepublishOnly, 'npm run validate');
});
