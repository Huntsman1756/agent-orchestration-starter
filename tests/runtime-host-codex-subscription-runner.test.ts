import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHostCodexSubscriptionRunnerV4 } from '../src/runtime/host-codex-subscription-runner.js';
import { validModelGuidance } from './runtime-contracts.test.js';

const successfulResult = {
  exit_code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  termination: null,
} as const;

test('qualifies keyring ChatGPT auth and executes an ephemeral read-only host review', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ao-codex-host-'));
  const calls: any[] = [];
  let now = 1_000;
  try {
    const runner = createHostCodexSubscriptionRunnerV4({
      harness_argv: [process.execPath, 'fake-codex.js'],
      runtime_home_parent: parent,
      environment: { PATH: process.env.PATH ?? '' },
      now_ms: () => (now += 5),
      run_process: async (request) => {
        calls.push(request);
        if (request.argv.at(-2) === 'login' && request.argv.at(-1) === 'status')
          return { ...successfulResult, stdout: 'Logged in using ChatGPT\n' };
        return { ...successfulResult, stdout: '{"type":"thread.started","thread_id":"session"}\n{"type":"turn.completed"}\n' };
      },
    });
    const probe = await runner.probe();
    assert.equal(probe.status, 'SUPPORTED');
    assert.match(probe.policy_hash, /^[a-f0-9]{64}$/u);
    const result = await runner.execute({
      execution_id: 'exec_host_review_0001',
      capsule_root: parent,
      model: 'gpt-5.6-sol',
      guidance: validModelGuidance(),
      prompt: 'Review the capsule.',
      expected_policy_hash: probe.policy_hash,
    });
    assert.equal(result.exit_code, 0);
    const execution = calls.at(-1);
    assert.deepEqual(execution.argv.slice(1, 13), [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--output-schema',
      join(parent, 'review-attestation-v4.schema.json'),
      '--json',
      '--cd',
      parent,
    ]);
    assert.ok(execution.argv.includes('cli_auth_credentials_store="keyring"'));
    assert.ok(execution.argv.includes('forced_login_method="chatgpt"'));
    assert.equal(execution.environment.CODEX_HOME.startsWith(parent), true);
    assert.equal(
      Object.keys(execution.environment).some((key) => /api|token|secret|credential/iu.test(key)),
      false,
    );
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('fails closed when the ChatGPT login is not available from the OS keyring', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ao-codex-host-'));
  try {
    const runner = createHostCodexSubscriptionRunnerV4({
      harness_argv: [process.execPath, 'fake-codex.js'],
      runtime_home_parent: parent,
      environment: {},
      run_process: async () => ({ ...successfulResult, exit_code: 1, stdout: 'Not logged in\n' }),
    });
    const probe = await runner.probe();
    assert.equal(probe.status, 'UNSUPPORTED');
    assert.equal(probe.reason, 'KEYRING_LOGIN_REQUIRED');
    await assert.rejects(
      runner.execute({
        execution_id: 'exec_host_review_0002',
        capsule_root: parent,
        model: 'gpt-5.6-sol',
        guidance: validModelGuidance(),
        prompt: 'Review.',
        expected_policy_hash: probe.policy_hash,
      }),
      /CAPABILITY_UNVERIFIED/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('rejects a host environment that contains credential-shaped variables', () => {
  assert.throws(
    () =>
      createHostCodexSubscriptionRunnerV4({
        harness_argv: [process.execPath],
        runtime_home_parent: tmpdir(),
        environment: { OPENAI_API_KEY: 'forbidden' },
      }),
    /CAPABILITY_UNVERIFIED/u,
  );
});
