import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUnsupportedProcessSandboxBackendV4,
  type SandboxRunRequestV4,
} from '../src/runtime/process-sandbox.js';

const request: SandboxRunRequestV4 = {
  execution_id: 'exec_contract_0001',
  profile: 'VALIDATION_UNTRUSTED',
  argv: ['node', '--version'],
  working_directory: '/capsule',
  environment: {},
  mounts: [],
  network: { mode: 'NONE' },
  timeout_ms: 1_000,
  max_output_bytes: 4_096,
};

test('unsupported backends fail closed before starting a sandbox process', async () => {
  const backend = createUnsupportedProcessSandboxBackendV4('unsupported-test-host');

  assert.deepEqual(await backend.probe('VALIDATION_UNTRUSTED'), {
    status: 'UNSUPPORTED',
    failure: 'PROCESS_SANDBOX_UNAVAILABLE',
  });
  await assert.rejects(
    () => backend.run(request),
    (error: Error) => error.message === 'PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable',
  );
});

test('unsupported backend termination is idempotent and has no process side effect', async () => {
  const backend = createUnsupportedProcessSandboxBackendV4('unsupported-test-host');

  await backend.terminate('exec_contract_0001');
  await backend.terminate('exec_contract_0001');
});
