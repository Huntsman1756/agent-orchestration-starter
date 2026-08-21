import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import test, { after } from 'node:test';

import {
  DOCKER_ISOLATION_ARGS_V4,
  buildDockerRunArgvV4,
  createDockerContainerRemovalControllerV4,
  createDockerProcessSandboxV4,
  dockerSandboxPolicyHashV4,
  isDockerNetworkAbsentV4,
  proveDockerSandboxMountsV4,
  reproveDockerSandboxMountsV4,
  validateDockerSandboxConfigV4,
  validateDockerSandboxRequestV4,
  type DockerSandboxConfigV4,
} from '../src/runtime/docker-sandbox.js';
import type { SandboxRunRequestV4 } from '../src/runtime/process-sandbox.js';
import { createBrokerOwnedDockerContainerV4 } from '../src/runtime/docker-container-transaction.js';
import { dockerCliEnvironmentV4, registerOrReproveDockerLauncherV4 } from '../src/runtime/docker-launcher.js';
import { settleBoundedProcessAndCleanupV4, startBoundedProcessV4 } from '../src/runtime/bounded-process.js';
import {
  isProviderEgressAddressAllowedV4,
  validateProviderGatewayOriginV4,
} from '../src/runtime/provider-egress-gateway.js';
import {
  REQUIRED_SANDBOX_EFFECTS_V4,
  validateSandboxCertificationTranscriptV4,
  type SandboxCertificationIdentityV4,
  type SandboxCertificationTranscriptV4,
} from '../src/runtime/sandbox-certification.js';
import { RUNTIME_BROKER_VERSION_V4 } from '../src/runtime/version.js';

const imageId = `sha256:${'a'.repeat(64)}` as const;
const trustedFixtureParent = process.platform === 'win32'
  ? join(process.env.PUBLIC ?? join(parse(homedir()).root, 'Users', 'Public'), 'agent-orchestration-test-fixtures')
  : join(homedir(), '.agent-orchestration-test-fixtures');

async function makeTrustedFixtureRoot(prefix: string): Promise<string> {
  await mkdir(trustedFixtureParent, { recursive: true });
  await chmod(trustedFixtureParent, 0o700);
  const root = await mkdtemp(join(trustedFixtureParent, prefix));
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  return root;
}

async function assertProcessNotRunning(pid: number, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
      if (stat === undefined) return;
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd >= 0 && stat.slice(commandEnd + 2, commandEnd + 3) === 'Z') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

after(async () => {
  await rm(trustedFixtureParent, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
});

const config: DockerSandboxConfigV4 = {
  docker_executable: join(tmpdir(), process.platform === 'win32' ? 'docker.exe' : 'docker'),
  image_id: imageId,
  certification_ttl_seconds: 900,
  provider_hosts: ['api.arliai.com'],
  allowed_mount_roots: [tmpdir()],
  active_worktree: process.cwd(),
  broker_state_directory: join(tmpdir(), 'ao-broker-state-not-mounted'),
};

test('sandbox image contains the complete local module closure for the provider gateway', async () => {
  const dockerfile = await readFile(new URL('../infra/sandbox/Dockerfile', import.meta.url), 'utf8');
  for (const module of [
    'bounded-process.js',
    'canonical.js',
    'docker-container-transaction.js',
    'docker-launcher.js',
    'process-sandbox.js',
    'provider-egress-gateway.js',
  ]) {
    assert.match(dockerfile, new RegExp(`COPY [^\\n]*dist/runtime/${module.replace('.', '\\.')}`), module);
  }
});

function validationRequest(overrides: Partial<SandboxRunRequestV4> = {}): SandboxRunRequestV4 {
  return {
    execution_id: 'exec_contract_0001',
    profile: 'VALIDATION_UNTRUSTED',
    argv: ['node', '--version'],
    working_directory: '/capsule',
    environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
    mounts: [],
    network: { mode: 'NONE' },
    timeout_ms: 5_000,
    max_output_bytes: 16_384,
    ...overrides,
  };
}

test('Docker validation argv contains the complete immutable isolation policy before the image ID', () => {
  const argv = buildDockerRunArgvV4(config, validationRequest());
  const secondArgv = buildDockerRunArgvV4(config, validationRequest());
  const imageIndex = argv.indexOf(imageId);

  assert.deepEqual(argv.slice(0, DOCKER_ISOLATION_ARGS_V4.length), DOCKER_ISOLATION_ARGS_V4);
  assert.ok(imageIndex > DOCKER_ISOLATION_ARGS_V4.length);
  assert.deepEqual(argv.slice(imageIndex), [imageId, 'node', '--version']);
  assert.deepEqual(argv.filter((entry) => entry.startsWith('--network')), ['--network=none']);
  const name = argv.find((entry) => entry.startsWith('--name=ao-exec-contract-0001-'));
  const secondName = secondArgv.find((entry) => entry.startsWith('--name=ao-exec-contract-0001-'));
  assert.match(name ?? '', /^--name=ao-exec-contract-0001-[a-f0-9]{32}$/);
  assert.notEqual(secondName, name);
  assert.ok(argv.includes('--label=agent-orchestration.execution=exec_contract_0001'));
  assert.ok(argv.some((entry) => /^--label=agent-orchestration.nonce=[a-f0-9]{32}$/.test(entry)));
  assert.ok(argv.includes(`--label=agent-orchestration.image=${imageId}`));
  assert.ok(argv.includes('--workdir=/capsule'));
  assert.ok(argv.includes('--env=HOME=/tmp/home'));
  assert.ok(argv.includes('--env=TMPDIR=/tmp'));
});

test('Docker policy hashes bind the profile, provider origin, and host mount policy', () => {
  const first = dockerSandboxPolicyHashV4(config, 'VALIDATION_UNTRUSTED');
  const repeated = dockerSandboxPolicyHashV4({ ...config, provider_hosts: ['api.arliai.com'] }, 'VALIDATION_UNTRUSTED');
  const networked = dockerSandboxPolicyHashV4(config, 'EXECUTOR_NETWORKED');
  const otherHost = dockerSandboxPolicyHashV4({ ...config, provider_hosts: ['other.example'] }, 'VALIDATION_UNTRUSTED');
  const otherMountRoot = dockerSandboxPolicyHashV4({ ...config, allowed_mount_roots: [join(tmpdir(), 'other-root')] }, 'VALIDATION_UNTRUSTED');
  const otherWorktree = dockerSandboxPolicyHashV4({ ...config, active_worktree: join(tmpdir(), 'other-worktree') }, 'VALIDATION_UNTRUSTED');
  const otherBrokerState = dockerSandboxPolicyHashV4({ ...config, broker_state_directory: join(tmpdir(), 'other-broker-state') }, 'VALIDATION_UNTRUSTED');

  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(repeated, first);
  assert.notEqual(networked, first);
  assert.notEqual(otherHost, first);
  assert.notEqual(otherMountRoot, first);
  assert.notEqual(otherWorktree, first);
  assert.notEqual(otherBrokerState, first);
});

test('Docker config rejects mutable images and non-canonical provider origins', () => {
  assert.doesNotThrow(() => validateDockerSandboxConfigV4({ ...config, provider_hosts: ['api.provider-one.example', 'gateway.provider-two.example'] }));
  assert.throws(
    () => validateDockerSandboxConfigV4({ ...config, docker_executable: 'docker' }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxConfigV4({ ...config, image_id: 'agent-orchestration-sandbox:v4' as `sha256:${string}` }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxConfigV4({ ...config, provider_hosts: ['API.ARLIAI.COM'] }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxConfigV4({ ...config, provider_hosts: ['127.0.0.1'] }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxConfigV4({ ...config, provider_hosts: ['api.provider.example', 'api.provider.example'] }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('Docker config ignores ambient host and context retargets', () => {
  const previousHost = process.env.DOCKER_HOST;
  const previousContext = process.env.DOCKER_CONTEXT;
  try {
    process.env.DOCKER_HOST = 'tcp://127.0.0.1:2375';
    assert.doesNotThrow(() => validateDockerSandboxConfigV4(config));
    process.env.DOCKER_CONTEXT = 'same-name-attacker-context';
    assert.doesNotThrow(() => validateDockerSandboxConfigV4(config));
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext;
  }
});

test('Docker launcher freezes the default endpoint and rejects isolated config mutation', async () => {
  const previousHost = process.env.DOCKER_HOST;
  const previousContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = 'tcp://127.0.0.1:2375';
  process.env.DOCKER_CONTEXT = 'same-name-attacker-context';
  const root = await makeTrustedFixtureRoot('ao-docker-endpoint-');
  const executable = join(root, process.platform === 'win32' ? 'docker.exe' : 'docker');
  const brokerState = join(root, 'broker');
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  await mkdir(brokerState);
  try {
    const identity = await registerOrReproveDockerLauncherV4(executable, undefined, brokerState);
    const environment = await dockerCliEnvironmentV4(executable);
    const expectedEndpoint = process.platform === 'win32'
      ? 'npipe:////./pipe/docker_engine'
      : 'unix:///var/run/docker.sock';
    assert.equal(identity.endpoint_context, null);
    assert.equal(identity.endpoint_host, expectedEndpoint);
    assert.equal(environment.DOCKER_HOST, expectedEndpoint);
    assert.equal(environment.DOCKER_CONTEXT, undefined);
    assert.equal(environment.DOCKER_CONFIG, join(brokerState, 'docker-cli-v4-empty'));

    await mkdir(join(brokerState, 'docker-cli-v4-empty'));
    await assert.rejects(
      () => registerOrReproveDockerLauncherV4(executable),
      /PROCESS_SANDBOX_UNAVAILABLE/,
    );
  } finally {
    if (previousHost !== undefined) process.env.DOCKER_HOST = previousHost;
    if (previousContext !== undefined) process.env.DOCKER_CONTEXT = previousContext;
    await rm(root, { recursive: true, force: true });
  }
});

test('production gateway accepts only an exact allowlisted lower-case provider TLS origin', () => {
  assert.equal(validateProviderGatewayOriginV4('https://api.arliai.com', ['api.arliai.com']).origin, 'https://api.arliai.com');
  assert.equal(validateProviderGatewayOriginV4('https://api.provider.example', ['api.provider.example']).origin, 'https://api.provider.example');
  assert.throws(() => validateProviderGatewayOriginV4('https://api.provider.example', ['other.provider.example']), /PROCESS_SANDBOX_UNAVAILABLE/);
  for (const value of [
    'https://api.arliai.com:8443',
    'https://API.ARLIAI.COM',
    'https://127.0.0.1',
    'https://api.arliai.com/v1',
  ]) {
    assert.throws(() => validateProviderGatewayOriginV4(value, ['api.arliai.com']), /PROCESS_SANDBOX_UNAVAILABLE/);
  }
});

test('gateway DNS pinning rejects literal private, local, metadata, mapped, multicast, and reserved addresses', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1',
    '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '2001:db8::1',
  ]) {
    assert.equal(isProviderEgressAddressAllowedV4(address), false, address);
  }
  assert.equal(isProviderEgressAddressAllowedV4('93.184.216.10'), true);
  assert.equal(isProviderEgressAddressAllowedV4('2606:4700:4700::1111'), true);
});

test('validation rejects network, provider credentials, host-home, and Docker-socket exposure', () => {
  assert.throws(
    () => validateDockerSandboxRequestV4(config, validationRequest({ network: { mode: 'INTERNAL', name: 'ao-int-run-1' } })),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, validationRequest({ environment: { OPENAI_API_KEY: 'real-secret' } })),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, validationRequest({ mounts: [{ source: homedir(), target: '/capsule', access: 'READ_ONLY' }] })),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, validationRequest({ mounts: [{ source: `${homedir()}/.ssh`, target: '/capsule', access: 'READ_ONLY' }] })),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, validationRequest({ mounts: [{ source: '/var/run/docker.sock', target: '/capsule', access: 'READ_ONLY' }] })),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('networked executor permits only an internal network and the fixed non-secret gateway token', () => {
  const request = validationRequest({
    profile: 'EXECUTOR_NETWORKED',
    network: { mode: 'INTERNAL', name: 'ao-int-exec-contract-0001' },
    environment: {
      HOME: '/tmp/home',
      PROVIDER_GATEWAY_TOKEN: 'broker-gateway',
      PROVIDER_BASE_URL: 'http://provider-gateway:8080/v1',
    },
  });

  assert.doesNotThrow(() => validateDockerSandboxRequestV4(config, request));
  assert.throws(
    () => validateDockerSandboxRequestV4(config, { ...request, environment: { ...request.environment, OPENAI_API_KEY: 'synthetic-real-key' } }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, { ...request, network: { mode: 'INTERNAL', name: 'ordinary-bridge' } }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('physical mount proof rejects aliases, ambiguous parents, sensitive roots, and open enums', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? dirname(process.cwd()) : tmpdir(), 'ao-mount-proof-'));
  const allowed = join(root, 'allowed');
  const source = join(allowed, 'capsule');
  const activeWorktree = join(root, 'active-worktree');
  const brokerState = join(allowed, 'broker-state');
  const alias = join(allowed, 'capsule-alias');
  const physicalConfig = {
    ...config,
    allowed_mount_roots: [allowed],
    active_worktree: activeWorktree,
    broker_state_directory: brokerState,
  } as DockerSandboxConfigV4;
  try {
    await Promise.all([mkdir(source, { recursive: true }), mkdir(activeWorktree, { recursive: true }), mkdir(brokerState, { recursive: true })]);
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.doesNotReject(() => proveDockerSandboxMountsV4(physicalConfig, validationRequest({
      mounts: [{ source, target: '/capsule', access: 'READ_ONLY' }],
    })));
    for (const mount of [
      { source: alias, target: '/capsule', access: 'READ_ONLY' },
      { source: join(allowed, 'missing-parent', 'capsule'), target: '/capsule', access: 'READ_ONLY' },
      { source: brokerState, target: '/capsule', access: 'READ_ONLY' },
      { source: activeWorktree, target: '/capsule', access: 'READ_ONLY' },
      { source, target: '/etc', access: 'READ_ONLY' },
      { source, target: '/capsule', access: 'OWNER_WRITE' },
    ]) {
      await assert.rejects(
        () => proveDockerSandboxMountsV4(physicalConfig, validationRequest({ mounts: [mount] as never })),
        /PROCESS_SANDBOX_UNAVAILABLE/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('mount capability reproof rejects a source replaced by an alias before Docker effects', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? dirname(process.cwd()) : tmpdir(), 'ao-mount-reproof-'));
  const allowed = join(root, 'allowed');
  const source = join(allowed, 'capsule');
  const replacement = join(allowed, 'replacement');
  const physicalConfig = {
    ...config,
    allowed_mount_roots: [allowed],
    active_worktree: join(root, 'active-worktree'),
    broker_state_directory: join(root, 'broker-state'),
  } as DockerSandboxConfigV4;
  try {
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(replacement, { recursive: true }),
      mkdir(physicalConfig.active_worktree, { recursive: true }),
      mkdir(physicalConfig.broker_state_directory, { recursive: true }),
    ]);
    const request = validationRequest({ mounts: [{ source, target: '/capsule', access: 'READ_ONLY' }] });
    const proof = await proveDockerSandboxMountsV4(physicalConfig, request);
    await rm(source, { recursive: true });
    await symlink(replacement, source, process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      () => reproveDockerSandboxMountsV4(physicalConfig, request, proof),
      /PROCESS_SANDBOX_UNAVAILABLE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('container removal is ID-bound, propagates failure, remains retryable, and serializes concurrent revoke', async () => {
  const containerId = 'a'.repeat(64);
  let present = true;
  let removeCalls = 0;
  let failFirst = true;
  const controller = createDockerContainerRemovalControllerV4(containerId, {
    inspect_exact_id: async (id) => {
      assert.equal(id, containerId);
      return present;
    },
    force_remove_exact_id: async (id) => {
      assert.equal(id, containerId);
      removeCalls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error('synthetic removal failure');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      present = false;
    },
    poll_interval_ms: 1,
    absence_timeout_ms: 100,
  });

  await assert.rejects(() => controller.remove(), /PROCESS_SANDBOX_UNAVAILABLE/);
  assert.equal(present, true);
  await Promise.all([controller.remove(), controller.remove(), controller.remove()]);
  assert.equal(removeCalls, 2, 'one failed call plus one serialized retry');
  await controller.remove();
  assert.equal(removeCalls, 2, 'verified absence makes later removal idempotent');
});

test('container removal fails closed when the exact ID remains inspectable', async () => {
  const controller = createDockerContainerRemovalControllerV4('b'.repeat(64), {
    inspect_exact_id: async () => true,
    force_remove_exact_id: async () => {},
    poll_interval_ms: 1,
    absence_timeout_ms: 5,
  });
  await assert.rejects(() => controller.remove(), /PROCESS_SANDBOX_UNAVAILABLE/);
});

const certificationIdentity: SandboxCertificationIdentityV4 = {
  backend_id: 'docker-engine-linux-v4',
  docker_server_id: 'server-a',
  docker_server_version: '29.6.2',
  docker_server_os: 'linux',
  docker_server_architecture: 'amd64',
  image_id: imageId,
  image_os: 'linux',
  image_architecture: 'amd64',
  profile: 'VALIDATION_UNTRUSTED',
  policy_hash: `sha256:${'b'.repeat(64)}`,
  broker_version: RUNTIME_BROKER_VERSION_V4,
};
function transcript(overrides: Partial<SandboxCertificationTranscriptV4> = {}): SandboxCertificationTranscriptV4 {
  const artifact = (id: string, kind: 'DOCKER_IDENTITY_RESULT' | 'HOSTILE_PROCESS_RESULT' | 'TIMEOUT_TREE_RESULT' | 'GATEWAY_NETWORK_RESULT') => ({
    artifact_id: id,
    execution_id: 'exec_hostile_cert_0001',
    kind,
    started_at: '2026-08-09T10:00:00.000Z',
    completed_at: '2026-08-09T10:00:01.000Z',
    content_base64: Buffer.from(kind === 'DOCKER_IDENTITY_RESULT'
      ? JSON.stringify(certificationIdentity)
      : `bounded-real-run-artifact:${kind}`).toString('base64'),
    content_hash: `sha256:${'0'.repeat(64)}` as const,
  });
  const artifacts = [
    artifact('artifact_identity_0001', 'DOCKER_IDENTITY_RESULT'),
    artifact('artifact_process_0001', 'HOSTILE_PROCESS_RESULT'),
    artifact('artifact_timeout_0001', 'TIMEOUT_TREE_RESULT'),
    artifact('artifact_gateway_0001', 'GATEWAY_NETWORK_RESULT'),
  ];
  return {
    run_id: 'cert_run_0001',
    identity: certificationIdentity,
    started_at: '2026-08-09T10:00:00.000Z',
    completed_at: '2026-08-09T10:00:01.000Z',
    artifacts,
    observations: REQUIRED_SANDBOX_EFFECTS_V4.map((effect) => ({
      effect,
      passed: true as const,
      artifact_ids: [effect === 'timeout_tree_killed'
        ? 'artifact_timeout_0001'
        : effect.startsWith('gateway_') || effect === 'direct_ip_blocked' || effect === 'metadata_only_logs'
          ? 'artifact_gateway_0001'
          : 'artifact_process_0001'],
    })),
    ...overrides,
  };
}

function validTranscript(overrides: Partial<SandboxCertificationTranscriptV4> = {}): SandboxCertificationTranscriptV4 {
  const unsigned = transcript();
  return transcript({
    artifacts: unsigned.artifacts.map((artifact) => ({
      ...artifact,
      content_hash: `sha256:${createHash('sha256').update(Buffer.from(artifact.content_base64, 'base64')).digest('hex')}`,
    })),
    ...overrides,
  });
}

test('certification rejects a forged all-true boolean record without bounded run artifacts', () => {
  const forged = {
    run_id: 'cert_run_0001',
    identity: certificationIdentity,
    started_at: '2026-08-09T10:00:00.000Z',
    completed_at: '2026-08-09T10:00:01.000Z',
    observations: Object.fromEntries(REQUIRED_SANDBOX_EFFECTS_V4.map((effect) => [effect, true])),
  };

  assert.throws(
    () => validateSandboxCertificationTranscriptV4(forged, certificationIdentity, 900, '2026-08-09T10:00:01.000Z'),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('production backend rejects every injected identity, runner, or clock authority', async () => {
  const dockerModule = await import('../src/runtime/docker-sandbox.js');
  const certificationModule = await import('../src/runtime/sandbox-certification.js');
  assert.equal('runDockerSandboxCertificationCandidateV4' in dockerModule, false);
  assert.equal('createSandboxCertificationV4' in certificationModule, false);
  assert.throws(
    () => (createDockerProcessSandboxV4 as unknown as (...args: unknown[]) => unknown)(config, {
      now: () => '2026-08-09T10:00:01.000Z',
      test_only: {
        explicit_test_only: true,
        inspect_identity: async () => certificationIdentity,
        run_hostile_certification: async () => validTranscript(),
      },
    } as never),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('certification transcript binds artifact bytes, exact identity, config TTL, and non-future time', () => {
  const valid = validTranscript();

  const evidence = validateSandboxCertificationTranscriptV4(valid, certificationIdentity, 900, '2026-08-09T10:00:01.000Z');
  assert.match(evidence.evidence_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(evidence.certified_at, '2026-08-09T10:00:01.000Z');
  assert.equal(evidence.expires_at, '2026-08-09T10:15:01.000Z');

  assert.throws(
    () => validateSandboxCertificationTranscriptV4(valid, certificationIdentity, 900, '2026-08-09T10:00:00.999Z'),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateSandboxCertificationTranscriptV4(valid, certificationIdentity, 901, '2026-08-09T10:00:01.000Z'),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateSandboxCertificationTranscriptV4(
      { ...valid, identity: { ...certificationIdentity, docker_server_id: 'server-b' } },
      certificationIdentity,
      900,
      '2026-08-09T10:00:01.000Z',
    ),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateSandboxCertificationTranscriptV4(
      { ...valid, artifacts: [{ ...valid.artifacts[0]!, content_base64: Buffer.from('tampered').toString('base64') }] },
      certificationIdentity,
      900,
      '2026-08-09T10:00:01.000Z',
    ),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('certification transcript contains exactly one artifact of each required kind', () => {
  const valid = validTranscript();
  const duplicate = {
    ...valid.artifacts[1]!,
    artifact_id: 'artifact_process_duplicate_0001',
  };
  assert.throws(
    () => validateSandboxCertificationTranscriptV4(
      { ...valid, artifacts: [...valid.artifacts, duplicate] },
      certificationIdentity,
      900,
      '2026-08-09T10:00:01.000Z',
    ),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('terminate aborts blocked Docker identity commands and releases the execution ID', { timeout: 30_000 }, async () => {
  const root = await makeTrustedFixtureRoot('ao-cli-block-');
  try {
    await Promise.all([mkdir(join(root, 'active')), mkdir(join(root, 'broker'))]);
    const dockerExecutable = join(root, process.platform === 'win32' ? 'docker.exe' : 'docker');
    const blockedCommand = (pidPath: string) => [
      "const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},2147483647)'],{stdio:'inherit'});",
      `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},2147483647);`,
    ].join('');
    if (process.platform === 'win32') {
      await Promise.all([
        copyFile(process.execPath, dockerExecutable),
        writeFile(join(root, 'info'), blockedCommand(join(root, 'info-child.pid'))),
        writeFile(join(root, 'image'), blockedCommand(join(root, 'image-child.pid'))),
      ]);
    } else {
      await writeFile(dockerExecutable, `#!${process.execPath}\n${blockedCommand(join(root, 'info-child.pid'))}\n`, 'utf8');
      await chmod(dockerExecutable, 0o700);
    }
    const backend = createDockerProcessSandboxV4({
      ...config,
      docker_executable: dockerExecutable,
      allowed_mount_roots: [root],
      active_worktree: join(root, 'active'),
      broker_state_directory: join(root, 'broker'),
    });
    const request = validationRequest({ execution_id: 'exec_blocked_probe_0001' });
    const firstRun = assert.rejects(() => backend.run(request), /PROCESS_SANDBOX_UNAVAILABLE/);
    let descendantPid: number | undefined;
    const pidDeadline = Date.now() + 10_000;
    while (descendantPid === undefined && Date.now() < pidDeadline) {
      try {
        descendantPid = Number(await readFile(join(root, 'info-child.pid'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.notEqual(descendantPid, undefined, 'the fake Docker identity command must reach its blocked descendant');
    const started = Date.now();
    await backend.terminate(request.execution_id);
    assert.equal(Date.now() - started < 5_000, true, 'terminate must abort the blocked CLI within the bounded cleanup contract rather than await its natural exit');
    await firstRun;
    await assertProcessNotRunning(
      descendantPid!,
      'the blocked identity command descendant must not retain inherited stdio',
    );

    const reused = assert.rejects(() => backend.run(request), /PROCESS_SANDBOX_UNAVAILABLE/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await backend.terminate(request.execution_id);
    await reused;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('Windows bounded termination waits for every detached descendant to be absent', { timeout: 30_000, skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-windows-tree-'));
  try {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const pidPath = join(root, `descendant-${iteration}.pid`);
      const source = [
        "const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');",
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},2147483647)'],{detached:${String(process.platform === 'win32')},stdio:'ignore'});`,
        `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},2147483647);`,
      ].join('');
      const handle = startBoundedProcessV4({
        executable: process.execPath,
        argv: ['-e', source],
        environment: { ...process.env },
        deadline_ms: 20_000,
        max_output_bytes: 4_096,
      });
      let descendantPid: number | undefined;
      const deadline = Date.now() + 5_000;
      while (descendantPid === undefined && Date.now() < deadline) {
        descendantPid = await readFile(pidPath, 'utf8').then(Number, () => undefined);
        if (descendantPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.notEqual(descendantPid, undefined);
      await handle.terminate();
      assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' }, `iteration ${iteration} descendant survived`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('Windows bounded termination propagates taskkill failure even when the main process closes', { timeout: 15_000, skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-taskkill-failure-'));
  const previousSystemRoot = process.env.SystemRoot;
  let descendantPid: number | undefined;
  try {
    await mkdir(join(root, 'System32'));
    await copyFile(process.execPath, join(root, 'System32', 'taskkill.exe'));
    const pidPath = join(root, 'descendant.pid');
    const source = [
      "const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},2147483647)'],{detached:true,stdio:'ignore'});",
      `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setTimeout(()=>process.exit(0),300);`,
    ].join('');
    const handle = startBoundedProcessV4({
      executable: process.execPath,
      argv: ['-e', source],
      environment: { ...process.env },
      deadline_ms: 10_000,
      max_output_bytes: 4_096,
    });
    const pidDeadline = Date.now() + 5_000;
    while (descendantPid === undefined && Date.now() < pidDeadline) {
      descendantPid = await readFile(pidPath, 'utf8').then(Number, () => undefined);
      if (descendantPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(descendantPid, undefined);
    process.env.SystemRoot = root;
    await assert.rejects(() => handle.terminate(), /PROCESS_SANDBOX_UNAVAILABLE/);
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already absent */ }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('bounded attach cleanup kills the local tree even when immutable-ID removal fails', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-attach-cleanup-'));
  let descendantPid: number | undefined;
  try {
    const pidPath = join(root, 'descendant.pid');
    const source = [
      "const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},2147483647)'],{detached:${String(process.platform === 'win32')},stdio:'ignore'});`,
      `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},2147483647);`,
    ].join('');
    const handle = startBoundedProcessV4({
      executable: process.execPath,
      argv: ['-e', source],
      environment: { ...process.env },
      deadline_ms: 10_000,
      max_output_bytes: 4_096,
    });
    const deadline = Date.now() + 5_000;
    while (descendantPid === undefined && Date.now() < deadline) {
      descendantPid = await readFile(pidPath, 'utf8').then(Number, () => undefined);
      if (descendantPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.notEqual(descendantPid, undefined);
    await assert.rejects(
      () => settleBoundedProcessAndCleanupV4(handle, async () => { throw new Error('removal denied'); }),
      /removal denied/,
    );
    await assertProcessNotRunning(descendantPid!, 'the bounded attach descendant survived cleanup');
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already absent */ }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('network retry classification accepts only Docker subnet-overlap failures', async () => {
  const runtime = await import('../src/runtime/docker-sandbox.js') as unknown as {
    isDockerNetworkSubnetOverlapV4?: (stderr: string) => boolean;
  };
  const classify = runtime.isDockerNetworkSubnetOverlapV4;
  assert.equal(typeof classify, 'function');
  assert.equal(classify!('Error response from daemon: Pool overlaps with other one on this address space\n'), true);
  assert.equal(classify!('Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n'), true);
  for (const error of [
    'permission denied',
    'Cannot connect to the Docker daemon',
    'Error response from daemon: network already exists',
    'Error response from daemon: Pool overlaps with other one on this address space; ignored suffix',
  ]) assert.equal(classify!(error), false, error);
});

test('network absence classification accepts only the exact immutable ID not-found response', () => {
  const id = 'c'.repeat(64);
  assert.equal(isDockerNetworkAbsentV4(id, 1, '[]\n', `Error response from daemon: network ${id} not found\n`), true);
  assert.equal(isDockerNetworkAbsentV4(id, 1, '[]\n', 'permission denied\n'), false);
  assert.equal(isDockerNetworkAbsentV4(id, 1, '[]\n', 'Cannot connect to the Docker daemon\n'), false);
  assert.equal(isDockerNetworkAbsentV4(id, 0, '[]\n', `Error response from daemon: network ${id} not found\n`), false);
  assert.equal(isDockerNetworkAbsentV4(id, 1, '', `Error response from daemon: network ${id} not found\n`), false);
  assert.equal(isDockerNetworkAbsentV4(id, 1, '[]\n', `Error response from daemon: network ${'d'.repeat(64)} not found\n`), false);
});

test('broker container transaction recovers partial and delayed create effects and removes the exact IDs', { timeout: 60_000 }, async () => {
  const root = await makeTrustedFixtureRoot('ao-container-transaction-');
  const executable = join(root, process.platform === 'win32' ? 'docker.exe' : 'docker');
  const statePath = join(root, 'state.json');
  const queryPath = join(root, 'queries.log');
  const removedPath = join(root, 'removed.log');
  const transientInspectPath = join(root, 'transient-inspect');
  try {
    await copyFile(process.execPath, executable);
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    await writeFile(join(root, 'create'), [
      "const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');",
      "const args=process.argv.slice(2),id='d'.repeat(64),name=args.find((v)=>v.startsWith('--name='))?.slice(7);",
      "const labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label')labels[args[++i].split('=')[0]]=args[i].slice(args[i].indexOf('=')+1);",
      "const image=args.find((v)=>/^sha256:[a-f0-9]{64}$/.test(v)),record={Id:id,Name:'/'+name,Config:{Image:image,Labels:labels}};",
      `if(labels['agent-orchestration.container-kind']==='tls-fixture'){const source="setTimeout(()=>require('node:fs').writeFileSync("+${JSON.stringify(JSON.stringify(statePath))}+","+JSON.stringify(JSON.stringify(record))+"),2500)";spawn(process.execPath,['-e',source],{detached:true,stdio:'ignore'}).unref();process.exit(1);}`,
      `if(labels['agent-orchestration.container-kind']==='executor'){writeFileSync(${JSON.stringify(statePath)},JSON.stringify(record));setInterval(()=>{},2147483647);}`,
      `writeFileSync(${JSON.stringify(statePath)},JSON.stringify(record));process.stdout.write(id.slice(0,17));`,
    ].join(''));
    await writeFile(join(root, 'container'), [
      "const{appendFileSync,existsSync,readFileSync,writeFileSync}=require('node:fs'),args=process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(queryPath)},args.join(' ')+'\\n');if(!existsSync(${JSON.stringify(statePath)}))process.exit(0);`,
      `const record=JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8'));`,
      `if(args[0]==='inspect'&&record.Config.Labels['agent-orchestration.container-kind']==='gateway'&&!existsSync(${JSON.stringify(transientInspectPath)})){writeFileSync(${JSON.stringify(transientInspectPath)},'failed');process.stderr.write('transient inspect failure');process.exit(2);}`,
      "if(args[0]==='ls')process.stdout.write(record.Id+'\\n');else if(args[0]==='inspect')process.stdout.write(JSON.stringify([record]));else process.exit(1);",
    ].join(''));
    await writeFile(join(root, 'rm'), [
      "const{appendFileSync,rmSync}=require('node:fs'),id=process.argv.at(-1);",
      `appendFileSync(${JSON.stringify(removedPath)},id+'\\n');rmSync(${JSON.stringify(statePath)},{force:true});process.stdout.write(id+'\\n');`,
    ].join(''));
    for (const kind of ['gateway', 'tls-fixture'] as const) {
      await assert.rejects(() => createBrokerOwnedDockerContainerV4({
        docker_executable: executable,
        broker_state_directory: root,
        image_id: imageId,
        execution_id: `exec_transaction_${kind.replace('-', '_')}_0001`,
        kind,
        create_arguments: [imageId, 'node', '-e', 'setInterval(()=>{},2147483647)'],
      }), /PROCESS_SANDBOX_UNAVAILABLE/);
    }
    const abort = new AbortController();
    const cancelled = assert.rejects(() => createBrokerOwnedDockerContainerV4({
      docker_executable: executable,
      broker_state_directory: root,
      image_id: imageId,
      execution_id: 'exec_transaction_cancelled_0001',
      kind: 'executor',
      create_arguments: [imageId, 'node', '-e', 'setInterval(()=>{},2147483647)'],
      signal: abort.signal,
    }), /PROCESS_SANDBOX_UNAVAILABLE/);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await readFile(statePath, 'utf8').then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    abort.abort();
    await cancelled;
    assert.deepEqual((await readFile(removedPath, 'utf8')).trim().split('\n'), ['d'.repeat(64), 'd'.repeat(64), 'd'.repeat(64)]);
    assert.equal((await readFile(queryPath, 'utf8')).split('\n').filter((line) => line.startsWith('ls ')).length >= 3, true,
      'the delayed effect must require at least one bounded recovery retry');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('fresh process reconciles a durable owned container transaction before new create authority', { timeout: 60_000 }, async () => {
  const root = await makeTrustedFixtureRoot('ao-container-restart-');
  const executable = join(root, process.platform === 'win32' ? 'docker.exe' : 'docker');
  const statePath = join(root, 'state.json');
  const countPath = join(root, 'count');
  const removedPath = join(root, 'removed.log');
  await copyFile(process.execPath, executable);
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  await writeFile(join(root, 'create'), [
    "const{existsSync,readFileSync,writeFileSync}=require('node:fs');const args=process.argv.slice(2);",
    `const n=existsSync(${JSON.stringify(countPath)})?Number(readFileSync(${JSON.stringify(countPath)},'utf8'))+1:1;writeFileSync(${JSON.stringify(countPath)},String(n));`,
    "const id=(n===1?'d':'e').repeat(64),name=args.find((v)=>v.startsWith('--name='))?.slice(7),labels={};",
    "for(let i=0;i<args.length;i++)if(args[i]==='--label')labels[args[++i].split('=')[0]]=args[i].slice(args[i].indexOf('=')+1);",
    "const image=args.find((v)=>/^sha256:[a-f0-9]{64}$/.test(v));",
    `writeFileSync(${JSON.stringify(statePath)},JSON.stringify({Id:id,Name:'/'+name,Config:{Image:image,Labels:labels}}));process.stdout.write(id);`,
  ].join(''));
  await writeFile(join(root, 'container'), [
    "const{existsSync,readFileSync}=require('node:fs'),args=process.argv.slice(2);",
    `if(!existsSync(${JSON.stringify(statePath)}))process.exit(0);const record=JSON.parse(readFileSync(${JSON.stringify(statePath)},'utf8'));`,
    "if(args[0]==='ls')process.stdout.write(record.Id+'\\n');else if(args[0]==='inspect')process.stdout.write(JSON.stringify([record]));else process.exit(1);",
  ].join(''));
  await writeFile(join(root, 'rm'), [
    "const{appendFileSync,rmSync}=require('node:fs'),id=process.argv.at(-1);",
    `appendFileSync(${JSON.stringify(removedPath)},id+'\\n');rmSync(${JSON.stringify(statePath)},{force:true});process.stdout.write(id+'\\n');`,
  ].join(''));
  const request = {
    docker_executable: executable,
    broker_state_directory: root,
    image_id: imageId,
    execution_id: 'exec_restart_owned_0001',
    kind: 'executor' as const,
    create_arguments: [imageId, 'node', '-e', 'setInterval(()=>{},2147483647)'],
  };
  const nonce = 'f'.repeat(32);
  const name = `ao-executor-${'a'.repeat(32)}`;
  const transactionDirectory = join(
    root,
    'container-transactions-v4',
    createHash('sha256').update(executable).digest('hex'),
  );
  const launcherKey = createHash('sha256').update(executable).digest('hex');
  const source = [
    '(async()=>{',
    "const{mkdir,writeFile}=require('node:fs/promises');",
    `const request=${JSON.stringify(request)},nonce=${JSON.stringify(nonce)},name=${JSON.stringify(name)},id='d'.repeat(64);`,
    `await mkdir(${JSON.stringify(transactionDirectory)},{recursive:true});`,
    `await writeFile(${JSON.stringify(statePath)},JSON.stringify({Id:id,Name:'/'+name,Config:{Image:request.image_id,Labels:{'agent-orchestration.execution':request.execution_id,'agent-orchestration.nonce':nonce,'agent-orchestration.image':request.image_id,'agent-orchestration.launcher':${JSON.stringify(launcherKey)},'agent-orchestration.container-kind':request.kind}}}),{flush:true});`,
    `await writeFile(${JSON.stringify(countPath)},'1',{flush:true});`,
    `await writeFile(${JSON.stringify(join(transactionDirectory, `${nonce}.json`))},JSON.stringify({request,name,nonce,container_id:id,owner_pid:process.pid}),{flush:true});`,
    '})().catch((error)=>{console.error(error);process.exit(1)});',
  ].join('');
  try {
    await new Promise<void>((resolvePromise, reject) => {
      let stderr = '';
      const child = spawn(process.execPath, ['-e', source], {
        cwd: root,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DOCKER_HOST' && key !== 'DOCKER_CONTEXT')),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    await new Promise<void>((resolvePromise, reject) => {
      let output = '';
      let errorOutput = '';
      const probe = spawn(executable, ['container', 'ls'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      probe.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
      probe.stderr?.setEncoding('utf8').on('data', (chunk: string) => { errorOutput += chunk; });
      probe.once('error', reject);
      probe.once('exit', (code) => code === 0 && output.trim() === 'd'.repeat(64)
        ? resolvePromise()
        : reject(new Error(`fake Docker preflight ${code}: ${output} ${errorOutput}`)));
    });
    const owned = await createBrokerOwnedDockerContainerV4({ ...request, execution_id: 'exec_restart_owned_0002' });
    await owned.removal.remove();
    assert.deepEqual((await readFile(removedPath, 'utf8')).trim().split('\n'), ['d'.repeat(64), 'e'.repeat(64)]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
