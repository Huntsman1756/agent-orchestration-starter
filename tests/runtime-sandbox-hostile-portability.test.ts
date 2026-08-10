import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('hostile Docker suite skips cleanly when Docker certification is not configured', async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), 'runtime-no-docker-path-'));
  const suite = fileURLToPath(new URL('./runtime-sandbox-hostile.test.ts', import.meta.url));
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPath };
  delete environment.AO_SANDBOX_IMAGE;
  delete environment.AO_DOCKER_EXECUTABLE;

  const script = `await import(${JSON.stringify(pathToFileURL(suite).href)}); console.log('HOSTILE_SUITE_IMPORTED');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: dirname(suite),
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HOSTILE_SUITE_IMPORTED/u);
});
