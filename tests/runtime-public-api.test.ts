import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('runtime-v4 keeps an intentional entry-point module surface', async () => {
  const source = await readFile(new URL('../src/runtime/index.ts', import.meta.url), 'utf8');
  const modules = [...source.matchAll(/^export \* from '(\.\/[^']+)';$/gmu)].map((match) => match[1]);
  assert.deepEqual(modules, [
    './contracts.js',
    './failures.js',
    './model-guidance.js',
    './readiness.js',
    './routing.js',
    './iterative-executor.js',
    './frontier-supervisor.js',
    './autonomous-dispatcher.js',
    './worker-capability.js',
  ]);
});

test('package exports identify stable, boundary-specific, and experimental runtime surfaces', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports?: Record<string, unknown> };
  assert.deepEqual(Object.keys(packageJson.exports ?? {}), [
    './fingerprint',
    './pilot-v3',
    './dogfood-v1',
    './runtime-v4',
    './runtime-v4/contracts',
    './runtime-v4/host',
    './runtime-v4/experimental',
  ]);
});
