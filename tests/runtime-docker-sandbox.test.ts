import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  DOCKER_ISOLATION_ARGS_V4,
  buildDockerRunArgvV4,
  createDockerContainerRemovalControllerV4,
  createDockerProcessSandboxV4,
  dockerSandboxPolicyHashV4,
  proveDockerSandboxMountsV4,
  reproveDockerSandboxMountsV4,
  validateDockerSandboxConfigV4,
  validateDockerSandboxRequestV4,
  type DockerSandboxConfigV4,
} from '../src/runtime/docker-sandbox.js';
import type { SandboxRunRequestV4 } from '../src/runtime/process-sandbox.js';
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

const imageId = `sha256:${'a'.repeat(64)}` as const;
const config: DockerSandboxConfigV4 = {
  docker_executable: 'docker',
  image_id: imageId,
  certification_ttl_seconds: 900,
  provider_hosts: ['api.arliai.com'],
  allowed_mount_roots: [tmpdir()],
  active_worktree: process.cwd(),
  broker_state_directory: join(tmpdir(), 'ao-broker-state-not-mounted'),
};

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
});

test('production gateway accepts only the exact lower-case ArliAI TLS origin', () => {
  assert.equal(validateProviderGatewayOriginV4('https://api.arliai.com').origin, 'https://api.arliai.com');
  for (const value of [
    'https://api.arliai.com:8443',
    'https://API.ARLIAI.COM',
    'https://127.0.0.1',
    'https://api.arliai.com/v1',
  ]) {
    assert.throws(() => validateProviderGatewayOriginV4(value), /PROCESS_SANDBOX_UNAVAILABLE/);
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
    () => validateDockerSandboxRequestV4(config, validationRequest({ environment: { ARLIAI_API_KEY: 'real-secret' } })),
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
      ARLIAI_API_KEY: 'broker-gateway',
      ARLIAI_BASE_URL: 'http://provider-gateway:8080/v1',
    },
  });

  assert.doesNotThrow(() => validateDockerSandboxRequestV4(config, request));
  assert.throws(
    () => validateDockerSandboxRequestV4(config, { ...request, environment: { ...request.environment, ARLIAI_API_KEY: 'synthetic-real-key' } }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
  assert.throws(
    () => validateDockerSandboxRequestV4(config, { ...request, network: { mode: 'INTERNAL', name: 'ordinary-bridge' } }),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('physical mount proof rejects aliases, ambiguous parents, sensitive roots, and open enums', async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-mount-proof-'));
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
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-mount-reproof-'));
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
  broker_version: '0.1.0-v4',
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

test('terminate aborts blocked Docker identity commands and releases the execution ID', { timeout: 7_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-cli-block-'));
  const previousCwd = process.cwd();
  try {
    await Promise.all([
      mkdir(join(root, 'active')),
      mkdir(join(root, 'broker')),
      writeFile(join(root, 'info'), 'setTimeout(()=>process.exit(2),2000);'),
      writeFile(join(root, 'image'), 'setTimeout(()=>process.exit(2),2000);'),
    ]);
    process.chdir(root);
    const backend = createDockerProcessSandboxV4({
      ...config,
      docker_executable: process.execPath,
      allowed_mount_roots: [root],
      active_worktree: join(root, 'active'),
      broker_state_directory: join(root, 'broker'),
    });
    const request = validationRequest({ execution_id: 'exec_blocked_probe_0001' });
    const firstRun = assert.rejects(() => backend.run(request), /PROCESS_SANDBOX_UNAVAILABLE/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await backend.terminate(request.execution_id);
    assert.equal(Date.now() - started < 1_000, true, 'terminate must abort the blocked CLI rather than await its natural exit');
    await firstRun;

    const reused = assert.rejects(() => backend.run(request), /PROCESS_SANDBOX_UNAVAILABLE/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await backend.terminate(request.execution_id);
    await reused;
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('network retry classification accepts only Docker subnet-overlap failures', async () => {
  const runtime = await import('../src/runtime/docker-sandbox.js') as unknown as {
    isDockerNetworkSubnetOverlapV4?: (stderr: string) => boolean;
  };
  const classify = runtime.isDockerNetworkSubnetOverlapV4;
  assert.equal(typeof classify, 'function');
  assert.equal(classify!('Error response from daemon: Pool overlaps with other one on this address space\n'), true);
  for (const error of [
    'permission denied',
    'Cannot connect to the Docker daemon',
    'Error response from daemon: network already exists',
    'Error response from daemon: Pool overlaps with other one on this address space; ignored suffix',
  ]) assert.equal(classify!(error), false, error);
});
