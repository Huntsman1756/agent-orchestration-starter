import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createDockerProcessSandboxV4,
  inspectDockerSandboxIdentityV4,
  runDockerSandboxCertificationCandidateV4,
  type DockerSandboxConfigV4,
} from '../src/runtime/docker-sandbox.js';
import { startProviderEgressGatewayV4 } from '../src/runtime/provider-egress-gateway.js';
import {
  REQUIRED_SANDBOX_EFFECTS_V4,
  createSandboxCertificationV4,
  type SandboxHostileEffectV4,
} from '../src/runtime/sandbox-certification.js';

const imageId = process.env.AO_SANDBOX_IMAGE;
const dockerIntegration = imageId?.startsWith('sha256:') ? test : test.skip;
const fixtureDirectory = dirname(fileURLToPath(new URL('./fixtures/sandbox/hostile-child.mjs', import.meta.url)));
const execFileAsync = promisify(execFile);
const observedEffects: Partial<Record<SandboxHostileEffectV4, true>> = {};

async function docker(...argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', argv, { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function waitForContainer(name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await docker('inspect', '--format', '{{.State.Running}}', name).catch(() => 'false')) === 'true') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('container did not become inspectable');
}

async function createTlsCertificate(directory: string, hostname: string): Promise<void> {
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  await execFileAsync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function startTlsFixture(options: {
  name: string;
  network: string;
  address: string;
  alias: string;
  certificateDirectory: string;
}): Promise<void> {
  const source = [
    "const https=require('node:https'),fs=require('node:fs'),crypto=require('node:crypto');",
    "const server=https.createServer({key:fs.readFileSync('/fixture/key.pem'),cert:fs.readFileSync('/fixture/cert.pem')},(req,res)=>{",
    "let bytes=0;req.on('data',(chunk)=>{bytes+=chunk.length});req.on('end',()=>{",
    "console.log(JSON.stringify({event:'REQUEST',method:req.method,path:req.url,bytes}));",
    "const authHash=crypto.createHash('sha256').update(req.headers.authorization??'').digest('hex');",
    "res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({auth_hash:authHash}));});});",
    "server.listen(443,'0.0.0.0',()=>console.log(JSON.stringify({event:'READY'})));",
  ].join('');
  await docker(
    'run', '--detach', '--rm', `--name=${options.name}`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32',
    '--memory=256m', '--cpus=1', '--user=1000:1000', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m',
    `--network=${options.network}`, `--ip=${options.address}`, `--network-alias=${options.alias}`,
    '--mount', `type=bind,src=${options.certificateDirectory},dst=/fixture,readonly`,
    config().image_id, 'node', '-e', source,
  );
  await waitForContainer(options.name);
}

function config(): DockerSandboxConfigV4 {
  return {
    docker_executable: 'docker',
    image_id: imageId as `sha256:${string}`,
    certification_ttl_seconds: 900,
    provider_hosts: ['api.arliai.com'],
  };
}

dockerIntegration('trusted sandbox image runs as uid 1000 with the exact pinned harness versions', { timeout: 30_000 }, async () => {
  const source = [
    "const {execFileSync}=require('node:child_process');",
    "const read=(name)=>execFileSync(name,['--version'],{encoding:'utf8'}).trim();",
    "console.log(JSON.stringify({uid:process.getuid(),cwd:process.cwd(),opencode:read('opencode'),codex:read('codex')}));",
  ].join('');
  const result = await runDockerSandboxCertificationCandidateV4(config(), {
    execution_id: 'exec_hostile_image_0001',
    profile: 'VALIDATION_UNTRUSTED',
    argv: ['node', '-e', source],
    working_directory: '/capsule',
    environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
    mounts: [],
    network: { mode: 'NONE' },
    timeout_ms: 20_000,
    max_output_bytes: 16_384,
  });

  assert.equal(result.exit_code, 0, result.stderr);
  const evidence = JSON.parse(result.stdout.trim()) as { uid: number; cwd: string; opencode: string; codex: string };
  assert.equal(evidence.uid, 1000);
  assert.equal(evidence.cwd, '/capsule');
  assert.match(evidence.opencode, /(?:^|\s)1\.18\.15(?:$|\s)/);
  assert.match(evidence.codex, /(?:^|\s)0\.147\.0(?:$|\s)/);
});

dockerIntegration('hostile validation cannot observe or mutate host state and hits the OS PID ceiling', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-sandbox-hostile-'));
  const capsule = join(root, 'capsule');
  const sentinel = join(root, 'outside', 'secret.txt');
  let loopbackConnections = 0;
  const loopbackServer = createTcpServer((socket) => {
    loopbackConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolvePromise, reject) => {
    loopbackServer.once('error', reject);
    loopbackServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const loopbackAddress = loopbackServer.address();
  assert.notEqual(loopbackAddress, null);
  assert.equal(typeof loopbackAddress, 'object');
  const loopbackPort = typeof loopbackAddress === 'object' && loopbackAddress !== null ? loopbackAddress.port : 0;
  try {
    await mkdir(capsule, { recursive: true });
    await mkdir(dirname(sentinel), { recursive: true });
    await copyFile(join(fixtureDirectory, 'hostile-child.mjs'), join(capsule, 'hostile-child.mjs'));
    await writeFile(sentinel, 'synthetic-outside-sentinel', 'utf8');

    const result = await runDockerSandboxCertificationCandidateV4(config(), {
      execution_id: 'exec_hostile_audit_0001',
      profile: 'VALIDATION_UNTRUSTED',
      argv: [
        'node', '/capsule/hostile-child.mjs', 'audit',
        `--outside-host-path=${sentinel}`, `--host-home=${homedir()}`,
        `--host-loopback-port=${loopbackPort}`,
      ],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [{ source: capsule, target: '/capsule', access: 'READ_ONLY' }],
      network: { mode: 'NONE' },
      timeout_ms: 30_000,
      max_output_bytes: 64 * 1024,
    });

    assert.equal(result.exit_code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(evidence.outside_sentinel_readable, false);
    assert.equal(evidence.host_home_enumerable, false);
    assert.deepEqual(evidence.credential_environment, {});
    assert.deepEqual(evidence.credential_argv, []);
    assert.equal(evidence.credential_files, false);
    assert.deepEqual(evidence.descendant_credential_environment, {});
    assert.deepEqual(evidence.descendant_credential_argv, []);
    assert.equal(evidence.outside_write_succeeded, false);
    assert.equal((evidence.pid_limit as { rejected: number }).rejected > 0, true);
    assert.equal(evidence.docker_socket_exists, false);
    assert.equal(evidence.docker_socket_connectable, false);
    assert.equal(evidence.host_loopback_connectable, false);
    assert.equal(evidence.host_loopback_port, loopbackPort);
    assert.equal(loopbackConnections, 0);
    assert.equal(await readFile(sentinel, 'utf8'), 'synthetic-outside-sentinel');
    Object.assign(observedEffects, {
      outside_sentinel_blocked: true,
      host_home_blocked: true,
      credential_environment_blocked: true,
      credential_argv_blocked: true,
      credential_files_blocked: true,
      descendant_state_blocked: true,
      outside_write_blocked: true,
      pid_limit_enforced: true,
      docker_socket_blocked: true,
      loopback_blocked: true,
    } satisfies Partial<Record<SandboxHostileEffectV4, true>>);
  } finally {
    await new Promise<void>((resolvePromise) => loopbackServer.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('timeout kills the whole container process tree before a detached grandchild can write', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-sandbox-timeout-'));
  const capsule = join(root, 'capsule');
  const scratch = join(root, 'scratch');
  const survivor = join(scratch, 'grandchild-survived.txt');
  try {
    await mkdir(capsule, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await copyFile(join(fixtureDirectory, 'hostile-child.mjs'), join(capsule, 'hostile-child.mjs'));

    const result = await runDockerSandboxCertificationCandidateV4(config(), {
      execution_id: 'exec_hostile_timeout_0001',
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '/capsule/hostile-child.mjs', 'grandchild', '/scratch/grandchild-survived.txt'],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [
        { source: capsule, target: '/capsule', access: 'READ_ONLY' },
        { source: scratch, target: '/scratch', access: 'READ_WRITE' },
      ],
      network: { mode: 'NONE' },
      timeout_ms: 500,
      max_output_bytes: 4_096,
    });

    assert.equal(result.timed_out, true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await assert.rejects(() => readFile(survivor), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    observedEffects.timeout_tree_killed = true;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('networked executor reaches only the authenticated TLS gateway and never receives the real credential', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ao-sandbox-gateway-'));
  const capsule = join(root, 'capsule');
  const certAllowed = join(root, 'cert-allowed');
  const certBlocked = join(root, 'cert-blocked');
  const executionId = 'exec_hostile_network_0001';
  const internalNetwork = 'ao-int-exec-hostile-network-0001';
  const outboundNetwork = 'ao-out-exec-hostile-network-0001';
  const allowedFixture = 'ao-upstream-allowed-0001';
  const blockedFixture = 'ao-upstream-blocked-0001';
  const gatewayContainer = 'ao-gateway-exec-hostile-network-0001';
  const executorContainer = 'ao-exec-hostile-network-0001';
  const syntheticCredential = 'synthetic-arliai-credential-task4-only';
  let lease: Awaited<ReturnType<typeof startProviderEgressGatewayV4>> | null = null;
  try {
    await Promise.all([mkdir(capsule), mkdir(certAllowed), mkdir(certBlocked)]);
    await copyFile(join(fixtureDirectory, 'network-probe.mjs'), join(capsule, 'network-probe.mjs'));
    await createTlsCertificate(certAllowed, 'api.arliai.com');
    await createTlsCertificate(certBlocked, 'blocked.example');
    await docker('network', 'create', '--driver=bridge', '--internal', '--label', `agent-orchestration.execution=${executionId}`, internalNetwork);
    await docker('network', 'create', '--driver=bridge', '--subnet=93.184.216.0/24', '--label', `agent-orchestration.execution=${executionId}`, outboundNetwork);
    await startTlsFixture({ name: allowedFixture, network: outboundNetwork, address: '93.184.216.10', alias: 'api.arliai.com', certificateDirectory: certAllowed });
    await startTlsFixture({ name: blockedFixture, network: outboundNetwork, address: '93.184.216.11', alias: 'blocked.example', certificateDirectory: certBlocked });

    lease = await startProviderEgressGatewayV4({
      docker_executable: 'docker',
      image_id: config().image_id,
      execution_id: executionId,
      internal_network: internalNetwork,
      outbound_network: outboundNetwork,
      outbound_address: '93.184.216.20',
      provider_origin: 'https://api.arliai.com',
      allowed_methods: ['POST'],
      allowed_paths: ['/v1/chat/completions'],
      real_api_key: syntheticCredential,
      ca_pem: await readFile(join(certAllowed, 'cert.pem'), 'utf8'),
      startup_timeout_ms: 10_000,
    });

    const runPromise = runDockerSandboxCertificationCandidateV4(config(), {
      execution_id: executionId,
      profile: 'EXECUTOR_NETWORKED',
      argv: [
        'node', '/capsule/network-probe.mjs', lease.gateway_base_url,
        'https://blocked.example', 'https://93.184.216.10', '2_000',
      ],
      working_directory: '/capsule',
      environment: {
        HOME: '/tmp/home', TMPDIR: '/tmp',
        ARLIAI_API_KEY: lease.non_secret_api_key_value,
        ARLIAI_BASE_URL: lease.gateway_base_url,
      },
      mounts: [{ source: capsule, target: '/capsule', access: 'READ_ONLY' }],
      network: { mode: 'INTERNAL', name: internalNetwork },
      timeout_ms: 15_000,
      max_output_bytes: 64 * 1024,
    });
    await Promise.all([waitForContainer(gatewayContainer), waitForContainer(executorContainer)]);
    const [gatewayInspection, executorInspection] = await Promise.all([
      docker('inspect', gatewayContainer),
      docker('inspect', executorContainer),
    ]);
    assert.equal(gatewayInspection.includes(syntheticCredential), false);
    assert.equal(executorInspection.includes(syntheticCredential), false);
    assert.equal(JSON.parse(gatewayInspection)[0].Mounts.length, 0);

    const result = await runPromise;
    assert.equal(result.exit_code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as {
      allowlisted: { ok: boolean; status: number; body: string };
      non_allowlisted: { ok: boolean; status: number };
      direct_ip: { ok: boolean };
    };
    assert.equal(evidence.allowlisted.ok, true);
    assert.equal(evidence.allowlisted.status, 200);
    assert.equal(
      JSON.parse(evidence.allowlisted.body).auth_hash,
      createHash('sha256').update(`Bearer ${syntheticCredential}`).digest('hex'),
    );
    assert.equal(evidence.non_allowlisted.status, 403);
    assert.equal(evidence.direct_ip.ok, false);
    assert.doesNotMatch(await docker('logs', blockedFixture), /"event":"REQUEST"/);
    const gatewayLogs = await docker('logs', gatewayContainer);
    assert.doesNotMatch(gatewayLogs, /synthetic-arliai|authorization|request_body|response_body/i);
    assert.match(gatewayLogs, /"decision":"ALLOW"/);
    assert.match(gatewayLogs, /"decision":"DENY"/);
    Object.assign(observedEffects, {
      gateway_allowlisted_success: true,
      gateway_non_allowlisted_blocked: true,
      direct_ip_blocked: true,
      gateway_credential_separated: true,
      gateway_no_repository_mount: true,
      metadata_only_logs: true,
    } satisfies Partial<Record<SandboxHostileEffectV4, true>>);
  } finally {
    await lease?.revoke().catch(() => undefined);
    await Promise.all([allowedFixture, blockedFixture, gatewayContainer, executorContainer].map(async (name) => {
      await docker('rm', '--force', name).catch(() => undefined);
    }));
    await Promise.all([internalNetwork, outboundNetwork].map(async (name) => {
      await docker('network', 'rm', name).catch(() => undefined);
    }));
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('fresh hostile evidence certifies only the exact Docker host, image, policy, and broker', { timeout: 60_000 }, async () => {
  assert.deepEqual(
    REQUIRED_SANDBOX_EFFECTS_V4.filter((effect) => observedEffects[effect] !== true),
    [],
    'every hostile effect must pass in this process before a certificate can be issued',
  );
  const identity = await inspectDockerSandboxIdentityV4(config(), 'VALIDATION_UNTRUSTED');
  const certifiedAt = new Date().toISOString();
  const certification = createSandboxCertificationV4(identity, observedEffects, config().certification_ttl_seconds, certifiedAt);
  const backend = createDockerProcessSandboxV4(config(), { certifications: [certification] });

  const probe = await backend.probe('VALIDATION_UNTRUSTED');
  assert.deepEqual(probe, {
    status: 'SUPPORTED',
    backend_id: 'docker-engine-linux-v4',
    policy_hash: identity.policy_hash,
    certification_hash: certification.certification_hash,
    expires_at: certification.expires_at,
  });
  const result = await backend.run({
    execution_id: 'exec_certified_smoke_0001',
    profile: 'VALIDATION_UNTRUSTED',
    argv: ['node', '-e', "process.stdout.write('certified')"],
    working_directory: '/capsule',
    environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
    mounts: [],
    network: { mode: 'NONE' },
    timeout_ms: 5_000,
    max_output_bytes: 4_096,
  });
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(result.stdout, 'certified');
  await backend.terminate('exec_certified_smoke_0001');
});
