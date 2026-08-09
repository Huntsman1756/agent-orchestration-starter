import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createDockerProcessSandboxV4,
  inspectDockerSandboxIdentityV4,
  runDockerSandboxCertificationCandidateV4,
  runDockerSandboxHostileCertificationV4,
  type DockerSandboxConfigV4,
} from '../src/runtime/docker-sandbox.js';
import { startProviderEgressGatewayV4 } from '../src/runtime/provider-egress-gateway.js';
import {
  REQUIRED_SANDBOX_EFFECTS_V4,
  validateSandboxCertificationTranscriptV4,
} from '../src/runtime/sandbox-certification.js';

const imageId = process.env.AO_SANDBOX_IMAGE;
const dockerIntegration = imageId?.startsWith('sha256:') ? test : test.skip;
const fixtureDirectory = dirname(fileURLToPath(new URL('./fixtures/sandbox/hostile-child.mjs', import.meta.url)));
const execFileAsync = promisify(execFile);

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

function config(allowedMountRoots: readonly string[] = [dirname(process.cwd())]): DockerSandboxConfigV4 {
  return {
    docker_executable: 'docker',
    image_id: imageId as `sha256:${string}`,
    certification_ttl_seconds: 900,
    provider_hosts: ['api.arliai.com'],
    allowed_mount_roots: allowedMountRoots,
    active_worktree: process.cwd(),
    broker_state_directory: join(dirname(process.cwd()), '.ao-broker-state-not-mounted'),
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

dockerIntegration('production-owned hostile runner records all 17 effects in one bounded live transcript', { timeout: 120_000 }, async () => {
  const identity = await inspectDockerSandboxIdentityV4(config(), 'VALIDATION_UNTRUSTED');
  const transcript = await runDockerSandboxHostileCertificationV4(config(), identity);
  const evidence = validateSandboxCertificationTranscriptV4(
    transcript,
    identity,
    config().certification_ttl_seconds,
    new Date().toISOString(),
  );

  assert.match(evidence.evidence_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    transcript.observations.map((observation) => observation.effect).sort(),
    [...REQUIRED_SANDBOX_EFFECTS_V4].sort(),
  );
  assert.deepEqual(
    [...new Set(transcript.artifacts.map((artifact) => artifact.kind))].sort(),
    ['DOCKER_IDENTITY_RESULT', 'GATEWAY_NETWORK_RESULT', 'HOSTILE_PROCESS_RESULT', 'TIMEOUT_TREE_RESULT'],
  );
});

dockerIntegration('Docker effects reject a mount alias introduced before create and preserve its target', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-sandbox-mount-alias-'));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  const alias = join(allowed, 'capsule');
  const sentinel = join(outside, 'sentinel.txt');
  try {
    await Promise.all([mkdir(allowed, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(sentinel, 'mount-alias-sentinel', 'utf8');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      () => runDockerSandboxCertificationCandidateV4(config([allowed]), {
        execution_id: 'exec_hostile_mount_alias_0001',
        profile: 'VALIDATION_UNTRUSTED',
        argv: ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/capsule/sentinel.txt','utf8'))"],
        working_directory: '/capsule',
        environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
        mounts: [{ source: alias, target: '/capsule', access: 'READ_ONLY' }],
        network: { mode: 'NONE' },
        timeout_ms: 5_000,
        max_output_bytes: 4_096,
      }),
      /PROCESS_SANDBOX_UNAVAILABLE/,
    );
    assert.equal(await readFile(sentinel, 'utf8'), 'mount-alias-sentinel');
    await assert.rejects(() => docker('inspect', 'ao-exec-hostile-mount-alias-0001'));
  } finally {
    await docker('rm', '--force', 'ao-exec-hostile-mount-alias-0001').catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('timeout removes the immutable container ID and preserves a name replacement', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-sandbox-timeout-id-'));
  const capsule = join(root, 'capsule');
  const scratch = join(root, 'scratch');
  const survivor = join(scratch, 'grandchild-survived.txt');
  const name = 'ao-exec-hostile-timeout-id-0001';
  const preserved = `${name}-preserved`;
  let originalId = '';
  let replacementId = '';
  try {
    await Promise.all([mkdir(capsule, { recursive: true }), mkdir(scratch, { recursive: true })]);
    await copyFile(join(fixtureDirectory, 'hostile-child.mjs'), join(capsule, 'hostile-child.mjs'));
    const running = runDockerSandboxCertificationCandidateV4(config([root]), {
      execution_id: 'exec_hostile_timeout_id_0001',
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '/capsule/hostile-child.mjs', 'grandchild', '/scratch/grandchild-survived.txt'],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [
        { source: capsule, target: '/capsule', access: 'READ_ONLY' },
        { source: scratch, target: '/scratch', access: 'READ_WRITE' },
      ],
      network: { mode: 'NONE' },
      timeout_ms: 750,
      max_output_bytes: 4_096,
    });
    await waitForContainer(name);
    originalId = await docker('inspect', '--format', '{{.Id}}', name);
    await docker('rename', name, preserved);
    replacementId = await docker(
      'create', `--name=${name}`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--network=none', config().image_id,
      'node', '-e', 'setInterval(()=>{},2147483647)',
    );

    const result = await running;
    assert.equal(result.timed_out, true);
    await assert.rejects(() => docker('inspect', originalId), 'timeout must remove the original exact ID');
    assert.equal(await docker('inspect', '--format', '{{.Id}}', replacementId), replacementId);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await assert.rejects(() => readFile(survivor), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await Promise.all([name, preserved, originalId, replacementId].filter((value) => value !== '').map(async (value) => {
      await docker('rm', '--force', value).catch(() => undefined);
    }));
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('networked executor reaches only the authenticated TLS gateway and never receives the real credential', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-sandbox-gateway-'));
  const capsule = join(root, 'capsule');
  const certAllowed = join(root, 'cert-allowed');
  const certBlocked = join(root, 'cert-blocked');
  const executionId = 'exec_hostile_network_0001';
  const internalNetwork = 'ao-int-exec-hostile-network-0001';
  const outboundNetwork = 'ao-out-exec-hostile-network-0001';
  const allowedFixture = 'ao-upstream-allowed-0001';
  const blockedFixture = 'ao-upstream-blocked-0001';
  const gatewayContainer = 'ao-gateway-exec-hostile-network-0001';
  const preservedGatewayContainer = `${gatewayContainer}-preserved`;
  const executorContainer = 'ao-exec-hostile-network-0001';
  const syntheticCredential = 'synthetic-arliai-credential-task4-only';
  let lease: Awaited<ReturnType<typeof startProviderEgressGatewayV4>> | null = null;
  let gatewayOriginalId = '';
  let replacementId = '';
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

    const runPromise = runDockerSandboxCertificationCandidateV4(config([root]), {
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
    const outboundIngress = JSON.parse(await docker(
      'exec', blockedFixture, 'node', '-e',
      "fetch('http://93.184.216.20:8080/v1/chat/completions',{method:'POST',body:'{}',signal:AbortSignal.timeout(1500)}).then((response)=>console.log(JSON.stringify({connected:true,status:response.status}))).catch(()=>console.log(JSON.stringify({connected:false})))",
    )) as { connected: boolean; status?: number };
    assert.equal(outboundIngress.connected, false, 'gateway ingress must not listen on its outbound-network interface');
    assert.doesNotMatch(await docker('logs', blockedFixture), /"event":"REQUEST"/);
    const gatewayLogs = await docker('logs', gatewayContainer);
    assert.doesNotMatch(gatewayLogs, /synthetic-arliai|authorization|request_body|response_body/i);
    assert.match(gatewayLogs, /"decision":"ALLOW"/);
    assert.match(gatewayLogs, /"decision":"DENY"/);
    gatewayOriginalId = await docker('inspect', '--format', '{{.Id}}', gatewayContainer);
    await docker('rename', gatewayContainer, preservedGatewayContainer);
    replacementId = await docker(
      'create', `--name=${gatewayContainer}`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--network=none', config().image_id,
      'node', '-e', 'setInterval(()=>{},2147483647)',
    );
    await Promise.all([lease.revoke(), lease.revoke(), lease.revoke()]);
    lease = null;
    await assert.rejects(() => docker('inspect', gatewayOriginalId), 'the exact leased gateway ID must be absent');
    assert.equal(
      await docker('inspect', '--format', '{{.Id}}', replacementId),
      replacementId,
      'a replacement that acquired the old name must remain untouched',
    );
  } finally {
    await lease?.revoke().catch(() => undefined);
    await Promise.all([
      allowedFixture, blockedFixture, gatewayContainer, preservedGatewayContainer,
      executorContainer, gatewayOriginalId, replacementId,
    ].filter((name) => name !== '').map(async (name) => {
      await docker('rm', '--force', name).catch(() => undefined);
    }));
    await Promise.all([internalNetwork, outboundNetwork].map(async (name) => {
      await docker('network', 'rm', name).catch(() => undefined);
    }));
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('fresh hostile evidence certifies only the exact Docker host, image, policy, and broker', { timeout: 60_000 }, async () => {
  const identity = await inspectDockerSandboxIdentityV4(config(), 'VALIDATION_UNTRUSTED');
  const probeStartedAt = Date.now();
  const backend = createDockerProcessSandboxV4(config());

  const probe = await backend.probe('VALIDATION_UNTRUSTED');
  assert.equal(probe.status, 'SUPPORTED', 'production probe must run and validate the built-in hostile runner');
  if (probe.status !== 'SUPPORTED') assert.fail('production hostile certification is required');
  assert.equal(probe.backend_id, 'docker-engine-linux-v4');
  assert.equal(probe.policy_hash, identity.policy_hash);
  assert.match(probe.certification_hash, /^sha256:[a-f0-9]{64}$/);
  const expiresAt = new Date(probe.expires_at).getTime();
  assert.equal(expiresAt > probeStartedAt, true);
  assert.equal(expiresAt <= Date.now() + config().certification_ttl_seconds * 1_000, true);
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

  const terminatingName = 'ao-exec-certified-terminate-0001';
  const preservedName = `${terminatingName}-preserved`;
  let terminatingId = '';
  let replacementId = '';
  try {
    const terminating = backend.run({
      execution_id: 'exec_certified_terminate_0001',
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '-e', 'setInterval(()=>{},2147483647)'],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [],
      network: { mode: 'NONE' },
      timeout_ms: 10_000,
      max_output_bytes: 4_096,
    });
    await waitForContainer(terminatingName);
    terminatingId = await docker('inspect', '--format', '{{.Id}}', terminatingName);
    await docker('rename', terminatingName, preservedName);
    replacementId = await docker(
      'create', `--name=${terminatingName}`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--network=none', config().image_id,
      'node', '-e', 'setInterval(()=>{},2147483647)',
    );
    await Promise.all([
      backend.terminate('exec_certified_terminate_0001'),
      backend.terminate('exec_certified_terminate_0001'),
      backend.terminate('exec_certified_terminate_0001'),
    ]);
    await assert.rejects(() => docker('inspect', terminatingId));
    await terminating;
    assert.equal(await docker('inspect', '--format', '{{.Id}}', replacementId), replacementId);
    await backend.terminate('exec_certified_terminate_0001');
  } finally {
    await Promise.all([terminatingName, preservedName, terminatingId, replacementId].filter((value) => value !== '').map(async (value) => {
      await docker('rm', '--force', value).catch(() => undefined);
    }));
  }
});
