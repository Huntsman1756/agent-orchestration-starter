import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createDockerProcessSandboxV4,
  inspectDockerSandboxIdentityV4,
  runDockerSandboxHostileCertificationV4,
  type DockerSandboxConfigV4,
} from '../src/runtime/docker-sandbox.js';
import { startProviderEgressGatewayV4 } from '../src/runtime/provider-egress-gateway.js';
import {
  REQUIRED_SANDBOX_EFFECTS_V4,
  validateSandboxCertificationTranscriptV4,
} from '../src/runtime/sandbox-certification.js';

const imageId = process.env.AO_SANDBOX_IMAGE;
const dockerConfigured = imageId?.startsWith('sha256:') ?? false;
const dockerIntegration = dockerConfigured ? test : test.skip;
const fixtureDirectory = dirname(fileURLToPath(new URL('./fixtures/sandbox/hostile-child.mjs', import.meta.url)));
const execFileAsync = promisify(execFile);
const dockerExecutable = dockerConfigured
  ? process.env.AO_DOCKER_EXECUTABLE ?? (process.platform === 'win32'
    ? execFileSync('where.exe', ['docker.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!
    : execFileSync('which', ['docker'], { encoding: 'utf8' }).trim())
  : '';

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

async function waitForExecutionContainer(executionId: string): Promise<{ id: string; name: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const output = await docker(
      'ps', '--all', '--no-trunc', `--filter=label=agent-orchestration.execution=${executionId}`,
      '--format', '{{.ID}} {{.Names}}',
    ).catch(() => '');
    const entries = output.split('\n').filter(Boolean);
    if (entries.length === 1) {
      const [id, name] = entries[0]!.split(' ');
      if (/^[a-f0-9]{64}$/.test(id ?? '') && name
        && await docker('inspect', '--format', '{{.State.Running}}', id!).catch(() => 'false') === 'true') {
        return { id: id!, name };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('execution container did not become inspectable');
}

async function waitForCertificationContainer(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const output = await docker(
      'ps', '--all',
      '--filter=label=agent-orchestration.container-kind=executor',
      '--format', '{{.Label "agent-orchestration.execution"}}',
    ).catch(() => '');
    if (output.split('\n').some((executionId) => executionId.startsWith('exec_cert_'))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('hostile certification did not begin');
}

async function writeDockerForwarder(
  directory: string,
  blockedExecutionId: string,
  weakenCertification = false,
): Promise<void> {
  const source = [
    "import {spawnSync} from 'node:child_process';import {basename,dirname} from 'node:path';import {appendFileSync,writeSync} from 'node:fs';",
    "const command=basename(process.argv[1]),args=process.argv.slice(2);",
    `if(${String(weakenCertification)}&&command==='create'&&args.some((arg)=>/^--label=agent-orchestration\.execution=exec_cert_.+_process$/.test(arg))){const image=args.findIndex((arg)=>/^sha256:[a-f0-9]{64}$/.test(arg));if(image>=0)args.splice(image,0,'--env=OPENAI_API_KEY=wrapper-leak');}`,
    "appendFileSync(dirname(process.argv[1])+'/commands.log',command+' '+args.join(' ')+'\\n');",
    `const child=spawnSync(${JSON.stringify(dockerExecutable)},[command,...args],{encoding:'utf8',windowsHide:true,maxBuffer:1048576});appendFileSync(dirname(process.argv[1])+'/commands.log','=> '+String(child.status)+' '+JSON.stringify(child.stdout??'')+' '+JSON.stringify(child.stderr??'')+'\\n');writeSync(1,child.stdout??'');writeSync(2,child.stderr??'');`,
    `const block=command==='create'&&args.some((arg)=>arg==='--label=agent-orchestration.execution=${blockedExecutionId}');`,
    "if(block)setTimeout(()=>process.exit(child.status??1),2000);else process.exit(child.status??1);",
  ].join('');
  await Promise.all([
    'info', 'image', 'container', 'rm', 'network', 'create', 'start', 'exec', 'inspect', 'ps', 'version',
  ].map(async (command) => await writeFile(join(directory, command), source)));
}

async function writeNetworkCreateForwarder(directory: string, mode: 'AMBIGUOUS' | 'UNRELATED_ERROR'): Promise<void> {
  const source = [
    "import {spawnSync} from 'node:child_process';import {basename,dirname} from 'node:path';import {appendFileSync,readFileSync,writeFileSync,writeSync} from 'node:fs';",
    "const command=basename(process.argv[1]),args=process.argv.slice(2),root=dirname(process.argv[1]);",
    "appendFileSync(root+'/commands.log',command+' '+args.join(' ')+'\\n');",
    "const internalCreate=command==='network'&&args[0]==='create'&&args.includes('--internal');",
    `if(internalCreate&&${JSON.stringify(mode)}==='UNRELATED_ERROR'){writeSync(2,'Error response from daemon: permission denied\\n');process.exit(1);}`,
    `const child=spawnSync(${JSON.stringify(dockerExecutable)},[command,...args],{encoding:'utf8',windowsHide:true,maxBuffer:1048576});writeSync(1,child.stdout??'');writeSync(2,child.stderr??'');`,
    "if(internalCreate&&child.status===0){const id=(child.stdout??'').trim(),name=args.at(-1),execution=args.find((arg)=>arg.startsWith('agent-orchestration.execution='))?.split('=')[1];writeFileSync(root+'/created-network.json',JSON.stringify({id,name,execution}));setTimeout(()=>process.exit(0),12000);}",
    `else if(command==='network'&&args[0]==='rm'&&child.status===0){try{const state=JSON.parse(readFileSync(root+'/created-network.json','utf8'));spawnSync(${JSON.stringify(dockerExecutable)},['network','create','--driver=bridge','--label','agent-orchestration.execution=unrelated',state.name],{encoding:'utf8',windowsHide:true,maxBuffer:1048576});}catch{}process.exit(0);}`,
    "else process.exit(child.status??1);",
  ].join('');
  await Promise.all([
    'info', 'image', 'container', 'rm', 'network', 'create', 'start', 'exec', 'inspect', 'ps', 'version',
  ].map(async (command) => await writeFile(join(directory, command), source)));
}

async function writeNetworkRemovalForwarder(directory: string): Promise<void> {
  const source = [
    "import {spawnSync} from 'node:child_process';import {basename,dirname} from 'node:path';import {appendFileSync,existsSync,writeFileSync,writeSync} from 'node:fs';",
    "const command=basename(process.argv[1]),args=process.argv.slice(2),root=dirname(process.argv[1]),marker=root+'/denied-once';",
    "appendFileSync(root+'/commands.log',command+' '+args.join(' ')+'\\n');",
    "if(command==='network'&&args[0]==='rm'&&!existsSync(marker)){writeFileSync(marker,'1');writeSync(2,'Error response from daemon: permission denied\\n');process.exit(1);}",
    `const child=spawnSync(${JSON.stringify(dockerExecutable)},[command,...args],{encoding:'utf8',windowsHide:true,maxBuffer:1048576});appendFileSync(root+'/commands.log','=> '+child.status+' '+JSON.stringify(child.stdout??'')+' '+JSON.stringify(child.stderr??'')+'\\n');writeSync(1,child.stdout??'');writeSync(2,child.stderr??'');process.exit(child.status??1);`,
  ].join('');
  await Promise.all([
    'info', 'image', 'container', 'rm', 'network', 'create', 'start', 'exec', 'inspect', 'ps', 'version', 'logs',
  ].map(async (command) => await writeFile(join(directory, command), source)));
}

async function waitForJsonFile<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(path, 'utf8').then((raw) => JSON.parse(raw) as T, () => null);
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected JSON evidence was not written within ${timeoutMs}ms`);
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
    docker_executable: dockerExecutable,
    image_id: imageId as `sha256:${string}`,
    certification_ttl_seconds: 900,
    provider_hosts: ['api.arliai.com'],
    allowed_mount_roots: allowedMountRoots,
    active_worktree: process.cwd(),
    broker_state_directory: join(dirname(process.cwd()), '.ao-broker-state-not-mounted'),
  };
}

const certifiedBackend = imageId?.startsWith('sha256:') ? createDockerProcessSandboxV4(config()) : null;

dockerIntegration('trusted sandbox image runs as uid 1000 with the exact pinned harness versions', { timeout: 30_000 }, async () => {
  const source = [
    "const {execFileSync}=require('node:child_process');",
    "const read=(name)=>execFileSync(name,['--version'],{encoding:'utf8'}).trim();",
    "console.log(JSON.stringify({uid:process.getuid(),cwd:process.cwd(),opencode:read('opencode'),codex:read('codex')}));",
  ].join('');
  const result = await certifiedBackend!.run({
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
      () => certifiedBackend!.run({
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
    assert.equal(await docker(
      'ps', '--all', '--quiet', '--no-trunc',
      '--filter=label=agent-orchestration.execution=exec_hostile_mount_alias_0001',
    ), '');
  } finally {
    const leaked = await docker(
      'ps', '--all', '--quiet', '--no-trunc',
      '--filter=label=agent-orchestration.execution=exec_hostile_mount_alias_0001',
    ).catch(() => '');
    await Promise.all(leaked.split('\n').filter(Boolean).map(async (id) => {
      await docker('rm', '--force', id).catch(() => undefined);
    }));
    await rm(root, { recursive: true, force: true });
  }
});

dockerIntegration('timeout removes the immutable container ID and preserves a name replacement', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(dirname(process.cwd()), 'ao-sandbox-timeout-id-'));
  const capsule = join(root, 'capsule');
  const scratch = join(root, 'scratch');
  const survivor = join(scratch, 'grandchild-survived.txt');
  let name = '';
  let preserved = '';
  let originalId = '';
  let replacementId = '';
  try {
    await Promise.all([mkdir(capsule, { recursive: true }), mkdir(scratch, { recursive: true })]);
    await copyFile(join(fixtureDirectory, 'hostile-child.mjs'), join(capsule, 'hostile-child.mjs'));
    const running = certifiedBackend!.run({
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
    const original = await waitForExecutionContainer('exec_hostile_timeout_id_0001');
    originalId = original.id;
    name = original.name;
    preserved = `${name}-preserved`;
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
  let executorContainer = '';
  const syntheticCredential = 'synthetic-arliai-credential-task4-only';
  let lease: Awaited<ReturnType<typeof startProviderEgressGatewayV4>> | null = null;
  let gatewayOriginalId = '';
  let gatewayOriginalName = '';
  let replacementId = '';
  try {
    assert.equal(
      (await certifiedBackend!.probe('EXECUTOR_NETWORKED')).status,
      'SUPPORTED',
      'the real networked certification must complete before the fixture reserves its fixed subnet',
    );
    await Promise.all([mkdir(capsule), mkdir(certAllowed), mkdir(certBlocked)]);
    await copyFile(join(fixtureDirectory, 'network-probe.mjs'), join(capsule, 'network-probe.mjs'));
    await createTlsCertificate(certAllowed, 'api.arliai.com');
    await createTlsCertificate(certBlocked, 'blocked.example');
    await docker('network', 'create', '--driver=bridge', '--internal', '--label', `agent-orchestration.execution=${executionId}`, internalNetwork);
    await docker('network', 'create', '--driver=bridge', '--subnet=93.184.216.0/24', '--label', `agent-orchestration.execution=${executionId}`, outboundNetwork);
    await startTlsFixture({ name: allowedFixture, network: outboundNetwork, address: '93.184.216.10', alias: 'api.arliai.com', certificateDirectory: certAllowed });
    await startTlsFixture({ name: blockedFixture, network: outboundNetwork, address: '93.184.216.11', alias: 'blocked.example', certificateDirectory: certBlocked });

    lease = await startProviderEgressGatewayV4({
      docker_executable: dockerExecutable,
      broker_state_directory: config().broker_state_directory,
      image_id: config().image_id,
      execution_id: executionId,
      internal_network: internalNetwork,
      outbound_network: outboundNetwork,
      outbound_address: '93.184.216.20',
      provider_origin: 'https://api.arliai.com',
      allowed_provider_hosts: ['api.arliai.com'],
      allowed_methods: ['POST'],
      allowed_paths: ['/v1/chat/completions'],
      real_api_key: syntheticCredential,
      ca_pem: await readFile(join(certAllowed, 'cert.pem'), 'utf8'),
      startup_timeout_ms: 10_000,
    });
    const createdGateway = JSON.parse(await docker('inspect', lease.container_id))[0] as {
      Name?: string;
      Config?: { Labels?: Record<string, string> };
    };
    assert.notEqual(createdGateway.Name, `/${gatewayContainer}`, 'the broker must generate an unguessable gateway name');
    gatewayOriginalName = (createdGateway.Name ?? '').replace(/^\//, '');
    assert.match(createdGateway.Config?.Labels?.['agent-orchestration.nonce'] ?? '', /^[a-f0-9]{32}$/);
    assert.equal(createdGateway.Config?.Labels?.['agent-orchestration.container-kind'], 'gateway');

    const runPromise = certifiedBackend!.run({
      execution_id: executionId,
      profile: 'EXECUTOR_NETWORKED',
      argv: [
        'node', '/capsule/network-probe.mjs', lease.gateway_base_url,
        'https://blocked.example', 'https://93.184.216.10', '2_000',
      ],
      working_directory: '/capsule',
      environment: {
        HOME: '/tmp/home', TMPDIR: '/tmp',
        PROVIDER_GATEWAY_TOKEN: lease.non_secret_api_key_value,
        PROVIDER_BASE_URL: lease.gateway_base_url,
      },
      mounts: [{ source: capsule, target: '/capsule', access: 'READ_ONLY' }],
      network: { mode: 'INTERNAL', name: internalNetwork },
      timeout_ms: 15_000,
      max_output_bytes: 64 * 1024,
    });
    const executor = await waitForExecutionContainer(executionId);
    executorContainer = executor.name;
    const [gatewayInspection, executorInspection] = await Promise.all([
      docker('inspect', lease.container_id),
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
    const gatewayLogs = await docker('logs', lease.container_id);
    assert.doesNotMatch(gatewayLogs, /synthetic-arliai|authorization|request_body|response_body/i);
    assert.match(gatewayLogs, /"decision":"ALLOW"/);
    assert.match(gatewayLogs, /"decision":"DENY"/);
    gatewayOriginalId = await docker('inspect', '--format', '{{.Id}}', lease.container_id);
    await docker('rename', lease.container_id, preservedGatewayContainer);
    replacementId = await docker(
      'create', `--name=${gatewayOriginalName}`, '--read-only', '--cap-drop=ALL',
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
      allowedFixture, blockedFixture, gatewayContainer, gatewayOriginalName, preservedGatewayContainer,
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

  let terminatingName = '';
  let preservedName = '';
  let terminatingId = '';
  let replacementId = '';
  try {
    const terminating = assert.rejects(() => backend.run({
      execution_id: 'exec_certified_terminate_0001',
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '-e', 'setInterval(()=>{},2147483647)'],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [],
      network: { mode: 'NONE' },
      timeout_ms: 10_000,
      max_output_bytes: 4_096,
    }), /PROCESS_SANDBOX_UNAVAILABLE/);
    const original = await waitForExecutionContainer('exec_certified_terminate_0001');
    terminatingId = original.id;
    terminatingName = original.name;
    preservedName = `${terminatingName}-preserved`;
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

dockerIntegration('terminate persists cancellation while the production probe is still starting', { timeout: 60_000 }, async () => {
  const backend = createDockerProcessSandboxV4(config());
  const executionId = 'exec_cancel_during_probe_0001';
  const running = backend.run({
    execution_id: executionId,
    profile: 'VALIDATION_UNTRUSTED',
    argv: ['node', '-e', "process.stdout.write('must-not-run')"],
    working_directory: '/capsule',
    environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
    mounts: [],
    network: { mode: 'NONE' },
    timeout_ms: 5_000,
    max_output_bytes: 4_096,
  });

  await backend.terminate(executionId);
  await assert.rejects(() => running, /PROCESS_SANDBOX_UNAVAILABLE/);
  assert.equal(await docker(
    'ps', '--all', '--quiet', '--no-trunc',
    `--filter=label=agent-orchestration.execution=${executionId}`,
  ), '');
});

dockerIntegration('concurrent production probes share one exact hostile certification run', { timeout: 90_000 }, async () => {
  const firstBackend = createDockerProcessSandboxV4(config());
  const secondBackend = createDockerProcessSandboxV4(config());
  const [first, second] = await Promise.all([
    firstBackend.probe('VALIDATION_UNTRUSTED'),
    secondBackend.probe('VALIDATION_UNTRUSTED'),
  ]);

  assert.equal(first.status, 'SUPPORTED');
  assert.equal(second.status, 'SUPPORTED');
  if (first.status !== 'SUPPORTED' || second.status !== 'SUPPORTED') assert.fail('both probes require the shared live certification');
  assert.equal(second.certification_hash, first.certification_hash, 'one in-process flight must issue from one exact transcript');
});

dockerIntegration('independent hostile runners wait out fixed-subnet overlap without false failure', { timeout: 120_000 }, async () => {
  const encodedConfig = Buffer.from(JSON.stringify(config())).toString('base64');
  const source = [
    "const runtime=await import('./dist/runtime/docker-sandbox.js');",
    "const config=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));",
    "const identity=await runtime.inspectDockerSandboxIdentityV4(config,'VALIDATION_UNTRUSTED');",
    'await runtime.runDockerSandboxHostileCertificationV4(config,identity);',
  ].join('');
  const launch = async () => await execFileAsync(process.execPath, ['--input-type=module', '-e', source, encodedConfig], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 110_000,
    maxBuffer: 1024 * 1024,
  });

  await Promise.all([launch(), launch()]);
});

dockerIntegration('an uncertified forwarding launcher cannot reach Docker create authority', { timeout: 120_000 }, async () => {
  const executionId = 'exec_ambiguous_create_0001';
  const wrapperRoot = await mkdtemp(join(dirname(process.cwd()), 'ao-docker-wrapper-'));
  const originalCwd = process.cwd();
  const baseConfig = config();
  let originalId = '';
  let replacementId = '';
  let replacementName = '';
  try {
    await writeDockerForwarder(wrapperRoot, executionId);
    const wrapperExecutable = join(wrapperRoot, process.platform === 'win32' ? 'docker.exe' : 'docker');
    await copyFile(process.execPath, wrapperExecutable);
    assert.equal((await createDockerProcessSandboxV4(baseConfig).probe('VALIDATION_UNTRUSTED')).status, 'SUPPORTED');
    process.chdir(wrapperRoot);
    const backend = createDockerProcessSandboxV4({ ...baseConfig, docker_executable: wrapperExecutable });
    const warmed = await backend.probe('VALIDATION_UNTRUSTED');
    if (warmed.status !== 'SUPPORTED') {
      assert.equal(warmed.status, 'UNSUPPORTED', 'an untrusted forwarding launcher must not reach create authority');
      return;
    }
    const running = assert.rejects(() => backend.run({
      execution_id: executionId,
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '-e', "process.stdout.write('must-not-run')"],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [],
      network: { mode: 'NONE' },
      timeout_ms: 5_000,
      max_output_bytes: 4_096,
    }), /PROCESS_SANDBOX_UNAVAILABLE/);
    const original = await waitForExecutionContainer(executionId).catch(async (error) => {
      const commands = await readFile(join(wrapperRoot, 'commands.log'), 'utf8').catch(() => '<no commands>');
      throw new Error(`${String(error)}\n${commands}`);
    });
    originalId = original.id;
    replacementName = original.name;
    await docker('rename', original.id, `${original.name}-preserved`);
    replacementId = await docker(
      'create', `--name=${original.name}`, '--label=agent-orchestration.execution=unrelated',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none',
      baseConfig.image_id, 'node', '-e', 'setInterval(()=>{},2147483647)',
    );
    await backend.terminate(executionId);
    await running;
    const survivor = await docker('inspect', originalId).then((raw) => JSON.parse(raw)[0], () => null) as null | {
      Id?: string; Config?: { Image?: string; Labels?: Record<string, string> };
    };
    if (survivor !== null) {
      const commands = await readFile(join(wrapperRoot, 'commands.log'), 'utf8').catch(() => '<no commands>');
      assert.fail(`broker container survived recovery: ${JSON.stringify({ Id: survivor.Id, Config: survivor.Config })}\n${commands}`);
    }
    assert.equal(await docker('inspect', '--format', '{{.Id}}', replacementId), replacementId);
  } finally {
    process.chdir(originalCwd);
    await Promise.all([originalId, replacementId, replacementName, `${replacementName}-preserved`].filter(Boolean).map(async (target) => {
      await docker('rm', '--force', target).catch(() => undefined);
    }));
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

dockerIntegration('ambiguous network create removes the exact effect, preserves its replacement, and unrelated errors do not retry', { timeout: 120_000 }, async () => {
  const baseConfig = config();
  const identity = await inspectDockerSandboxIdentityV4(baseConfig, 'VALIDATION_UNTRUSTED');
  const originalCwd = process.cwd();

  for (const mode of ['AMBIGUOUS', 'UNRELATED_ERROR'] as const) {
    const wrapperRoot = await mkdtemp(join(dirname(process.cwd()), 'ao-network-wrapper-'));
    let replacementName = '';
    try {
      await writeNetworkCreateForwarder(wrapperRoot, mode);
      const wrapperExecutable = join(wrapperRoot, process.platform === 'win32' ? 'docker.exe' : 'docker');
      await copyFile(process.execPath, wrapperExecutable);
      process.chdir(wrapperRoot);
      const rejected = assert.rejects(
        () => runDockerSandboxHostileCertificationV4(
          { ...baseConfig, docker_executable: wrapperExecutable },
          identity,
        ),
        /PROCESS_SANDBOX_UNAVAILABLE/,
      );

      if (mode === 'AMBIGUOUS') {
        let created: { id: string; name: string; execution: string };
        try {
          created = await waitForJsonFile<{ id: string; name: string; execution: string }>(
            join(wrapperRoot, 'created-network.json'),
            30_000,
          );
        } catch (error) {
          const commands = await readFile(join(wrapperRoot, 'commands.log'), 'utf8').catch(() => '<no commands>');
          throw new Error(`${String(error)}\nforwarder transcript:\n${commands}`);
        }
        replacementName = created.name;
        await rejected;
        await assert.rejects(() => docker('network', 'inspect', created.id), 'the exact ambiguous network ID must be absent');
        const replacement = JSON.parse(await docker('network', 'inspect', created.name))[0] as {
          Id: string;
          Labels: Record<string, string>;
        };
        assert.notEqual(replacement.Id, created.id);
        assert.equal(replacement.Labels['agent-orchestration.execution'], 'unrelated');
        assert.equal(await docker(
          'network', 'ls', '--quiet', '--no-trunc',
          `--filter=label=agent-orchestration.execution=${created.execution}`,
        ), '');
      } else {
        await rejected;
        const commands = await readFile(join(wrapperRoot, 'commands.log'), 'utf8');
        assert.equal(
          commands.split('\n').filter((line) => line.startsWith('network create ') && line.includes('--internal')).length,
          1,
          'an unrelated network-create failure must not be retried',
        );
      }
    } finally {
      process.chdir(originalCwd);
      if (replacementName !== '') await docker('network', 'rm', replacementName).catch(() => undefined);
      await rm(wrapperRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

dockerIntegration('network cleanup propagates permission denial and a later certification retries the exact retained ID', { timeout: 180_000 }, async () => {
  const wrapperRoot = await mkdtemp(join(dirname(process.cwd()), 'ao-network-cleanup-wrapper-'));
  const wrapperExecutable = join(wrapperRoot, process.platform === 'win32' ? 'docker.exe' : 'docker');
  const originalCwd = process.cwd();
  const baseConfig = config();
  const identity = await inspectDockerSandboxIdentityV4(baseConfig, 'VALIDATION_UNTRUSTED');
  let retainedNetworkId = '';
  try {
    await writeNetworkRemovalForwarder(wrapperRoot);
    await copyFile(process.execPath, wrapperExecutable);
    process.chdir(wrapperRoot);
    const wrapperConfig = { ...baseConfig, docker_executable: wrapperExecutable };
    await assert.rejects(
      () => runDockerSandboxHostileCertificationV4(wrapperConfig, identity),
      /PROCESS_SANDBOX_UNAVAILABLE/,
      'permission denial must surface instead of being treated as absence',
    );
    const commands = (await readFile(join(wrapperRoot, 'commands.log'), 'utf8')).split('\n');
    const internalCreate = commands.findIndex((line) => line.startsWith('network create ') && line.includes('--internal'));
    const createdId = commands.slice(internalCreate + 1).find((line) => /^=> 0 "[a-f0-9]{64}\\n"/.test(line));
    const retainedMatch = createdId?.match(/^=> 0 "([a-f0-9]{64})\\n"/);
    assert.notEqual(internalCreate, -1, 'the wrapper must observe its own internal network creation');
    assert.ok(retainedMatch, 'the exact wrapper-owned network remains retryable after cleanup denial');
    retainedNetworkId = retainedMatch[1]!;

    await assert.rejects(
      () => runDockerSandboxHostileCertificationV4(wrapperConfig, identity),
      /PROCESS_SANDBOX_UNAVAILABLE/,
      'the stateful wrapper remains a non-certifying launcher even after the retained cleanup is retried',
    );
    await assert.rejects(() => docker('network', 'inspect', retainedNetworkId), 'the retained exact ID must be absent after retry');
    retainedNetworkId = '';
  } finally {
    process.chdir(originalCwd);
    if (retainedNetworkId !== '') await docker('network', 'rm', retainedNetworkId).catch(() => undefined);
    await rm(wrapperRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

dockerIntegration('certification binds the immutable Docker launcher and rejects a weakening wrapper or executable replacement', { timeout: 120_000 }, async () => {
  const baseConfig = config();
  assert.equal((await createDockerProcessSandboxV4(baseConfig).probe('VALIDATION_UNTRUSTED')).status, 'SUPPORTED');
  const originalCwd = process.cwd();

  for (const mode of ['WEAKENED', 'REPLACED'] as const) {
    const wrapperRoot = await mkdtemp(join(dirname(process.cwd()), 'ao-launcher-wrapper-'));
    const wrapperExecutable = join(wrapperRoot, process.platform === 'win32' ? 'docker.exe' : 'docker');
    const backupExecutable = `${wrapperExecutable}.original`;
    try {
      if (mode === 'WEAKENED') await writeDockerForwarder(wrapperRoot, 'exec_never_block_0001', true);
      await copyFile(mode === 'WEAKENED' ? process.execPath : dockerExecutable, wrapperExecutable);
      process.chdir(wrapperRoot);
      const backend = createDockerProcessSandboxV4({ ...baseConfig, docker_executable: wrapperExecutable });
      const first = await backend.probe('VALIDATION_UNTRUSTED');
      if (mode === 'WEAKENED') {
        assert.equal(first.status, 'UNSUPPORTED', 'a wrapper that leaks a credential into the hostile process cannot reuse a real Docker certificate');
      } else {
        if (first.status !== 'SUPPORTED') {
          const commands = await readFile(join(wrapperRoot, 'commands.log'), 'utf8').catch(() => '<no commands>');
          assert.fail(`the forwarding launcher must first earn its own live certificate\n${commands}`);
        }
        await copyFile(wrapperExecutable, backupExecutable);
        await rm(wrapperExecutable);
        await copyFile(dockerExecutable, wrapperExecutable);
        assert.equal(
          (await backend.probe('VALIDATION_UNTRUSTED')).status,
          'UNSUPPORTED',
          'replacement at the certified executable path must invalidate the backend cache',
        );
      }
    } finally {
      process.chdir(originalCwd);
      await rm(wrapperRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

dockerIntegration('caller cancellation detaches from a genuinely uncached shared certification flight', { timeout: 120_000 }, async () => {
  const wrapperRoot = await mkdtemp(join(dirname(process.cwd()), 'ao-flight-launcher-'));
  const wrapperExecutable = join(wrapperRoot, process.platform === 'win32' ? 'docker.exe' : 'docker');
  try {
    await copyFile(dockerExecutable, wrapperExecutable);
    const backend = createDockerProcessSandboxV4({ ...config(), docker_executable: wrapperExecutable });
    const executionId = 'exec_cancel_uncached_flight_0001';
    const running = assert.rejects(() => backend.run({
      execution_id: executionId,
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '-e', "process.stdout.write('must-not-run')"],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [],
      network: { mode: 'NONE' },
      timeout_ms: 5_000,
      max_output_bytes: 4_096,
    }), /PROCESS_SANDBOX_UNAVAILABLE/);
    await waitForCertificationContainer();
    const started = Date.now();
    await backend.terminate(executionId);
    assert.equal(Date.now() - started < 1_500, true, 'caller termination must not await the shared hostile flight');
    await running;
    assert.equal((await backend.probe('VALIDATION_UNTRUSTED')).status, 'SUPPORTED', 'the bounded shared flight remains reusable');
  } finally {
    await rm(wrapperRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
