import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import test from 'node:test';

import {
  DOCKER_ISOLATION_ARGS_V4,
  buildDockerRunArgvV4,
  dockerSandboxPolicyHashV4,
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
  createSandboxCertificationV4,
  matchesSandboxCertificationV4,
  type SandboxCertificationIdentityV4,
} from '../src/runtime/sandbox-certification.js';

const imageId = `sha256:${'a'.repeat(64)}` as const;
const config: DockerSandboxConfigV4 = {
  docker_executable: 'docker',
  image_id: imageId,
  certification_ttl_seconds: 900,
  provider_hosts: ['api.arliai.com'],
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
  const imageIndex = argv.indexOf(imageId);

  assert.deepEqual(argv.slice(0, DOCKER_ISOLATION_ARGS_V4.length), DOCKER_ISOLATION_ARGS_V4);
  assert.ok(imageIndex > DOCKER_ISOLATION_ARGS_V4.length);
  assert.deepEqual(argv.slice(imageIndex), [imageId, 'node', '--version']);
  assert.deepEqual(argv.filter((entry) => entry.startsWith('--network')), ['--network=none']);
  assert.ok(argv.includes('--name=ao-exec-contract-0001'));
  assert.ok(argv.includes('--workdir=/capsule'));
  assert.ok(argv.includes('--env=HOME=/tmp/home'));
  assert.ok(argv.includes('--env=TMPDIR=/tmp'));
});

test('Docker policy hashes are deterministic, profile-bound, and provider-host-bound', () => {
  const first = dockerSandboxPolicyHashV4(config, 'VALIDATION_UNTRUSTED');
  const repeated = dockerSandboxPolicyHashV4({ ...config, provider_hosts: ['api.arliai.com'] }, 'VALIDATION_UNTRUSTED');
  const networked = dockerSandboxPolicyHashV4(config, 'EXECUTOR_NETWORKED');
  const otherHost = dockerSandboxPolicyHashV4({ ...config, provider_hosts: ['other.example'] }, 'VALIDATION_UNTRUSTED');

  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(repeated, first);
  assert.notEqual(networked, first);
  assert.notEqual(otherHost, first);
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
const completeEffects = Object.fromEntries(REQUIRED_SANDBOX_EFFECTS_V4.map((effect) => [effect, true]));

test('certification refuses to bless a candidate when any hostile OS effect remains possible', () => {
  const effects = { ...completeEffects, docker_socket_blocked: false };

  assert.throws(
    () => createSandboxCertificationV4(certificationIdentity, effects, 900, '2026-08-09T10:00:00.000Z'),
    /PROCESS_SANDBOX_UNAVAILABLE/,
  );
});

test('certification is valid only for the exact host, image, profile, policy, broker, and TTL', () => {
  const certification = createSandboxCertificationV4(
    certificationIdentity,
    completeEffects,
    900,
    '2026-08-09T10:00:00.000Z',
  );

  assert.equal(matchesSandboxCertificationV4(certification, certificationIdentity, '2026-08-09T10:14:59.000Z'), true);
  assert.equal(matchesSandboxCertificationV4(certification, certificationIdentity, '2026-08-09T10:15:01.000Z'), false);
  for (const mismatch of [
    { ...certificationIdentity, docker_server_id: 'server-b' },
    { ...certificationIdentity, image_id: `sha256:${'c'.repeat(64)}` as const },
    { ...certificationIdentity, profile: 'EXECUTOR_NETWORKED' as const },
    { ...certificationIdentity, policy_hash: `sha256:${'d'.repeat(64)}` as const },
    { ...certificationIdentity, broker_version: '0.1.1-v4' },
  ]) {
    assert.equal(matchesSandboxCertificationV4(certification, mismatch, '2026-08-09T10:01:00.000Z'), false);
  }
});
