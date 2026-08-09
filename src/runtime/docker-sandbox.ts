import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { hashCanonicalV4 } from './canonical.js';
import type {
  ProcessSandboxBackendV4,
  SandboxProbeResultV4,
  SandboxProfileV4,
  SandboxRunRequestV4,
} from './process-sandbox.js';
import {
  matchesSandboxCertificationV4,
  type SandboxCertificationIdentityV4,
  type SandboxCertificationV4,
} from './sandbox-certification.js';

export interface DockerSandboxConfigV4 {
  docker_executable: string;
  image_id: `sha256:${string}`;
  certification_ttl_seconds: number;
  provider_hosts: readonly string[];
}

export const DOCKER_ISOLATION_ARGS_V4 = Object.freeze([
  'run', '--rm', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges', '--pids-limit=64',
  '--memory=1024m', '--cpus=2', '--user=1000:1000',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m',
  '--network=none',
] as const);

const commonEnvironmentKeys = new Set([
  'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'PATH', 'LANG', 'LC_ALL', 'NO_COLOR',
]);
const networkedProfiles = new Set<SandboxProfileV4>([
  'EXECUTOR_NETWORKED', 'FRONTIER_NETWORKED', 'REVIEW_CAPSULE',
]);
const credentialLocations = [
  '.ssh', '.aws', '.azure', '.config', '.docker', '.codex', '.gnupg', '.kube',
  '.git-credentials', '.npmrc',
  join('AppData', 'Roaming', 'opencode'),
  join('AppData', 'Roaming', 'codex'),
];

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

export function validateDockerSandboxConfigV4(config: DockerSandboxConfigV4): void {
  if (config.docker_executable.length === 0 || config.docker_executable.includes('\0')) unavailable();
  if (!/^sha256:[a-f0-9]{64}$/.test(config.image_id)) unavailable();
  if (!Number.isSafeInteger(config.certification_ttl_seconds)
    || config.certification_ttl_seconds < 1
    || config.certification_ttl_seconds > 86_400) unavailable();
  if (config.provider_hosts.length !== 1 || config.provider_hosts[0] !== 'api.arliai.com') unavailable();
}

export function validateDockerSandboxRequestV4(config: DockerSandboxConfigV4, request: SandboxRunRequestV4): void {
  validateDockerSandboxConfigV4(config);
  if (!/^exec_[a-z0-9_-]{8,96}$/.test(request.execution_id)) unavailable();
  if (request.argv.length === 0 || request.argv.length > 128 || request.argv.some((part) => part.length === 0 || part.length > 8_192 || part.includes('\0'))) unavailable();
  if (!/^\/(capsule|workspace|scratch)(?:\/[^.][^\0]*)?$/.test(request.working_directory) || request.working_directory.includes('/../')) unavailable();
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > 3_600_000) unavailable();
  if (!Number.isSafeInteger(request.max_output_bytes) || request.max_output_bytes < 1 || request.max_output_bytes > 16 * 1024 * 1024) unavailable();

  const networked = networkedProfiles.has(request.profile);
  if (!networked && request.network.mode !== 'NONE') unavailable();
  if (networked && (request.network.mode !== 'INTERNAL' || !/^ao-int-exec-[a-z0-9-]{4,80}$/.test(request.network.name))) unavailable();

  for (const [key, value] of Object.entries(request.environment)) {
    const isGatewayKey = networked && key === 'ARLIAI_API_KEY' && value === 'broker-gateway';
    const isGatewayUrl = networked && key === 'ARLIAI_BASE_URL' && value === 'http://provider-gateway:8080/v1';
    if ((!commonEnvironmentKeys.has(key) && !isGatewayKey && !isGatewayUrl) || value.includes('\0')) unavailable();
  }

  const targets = new Set<string>();
  for (const mount of request.mounts) {
    if (!isAbsolute(mount.source) || mount.source.includes('\0') || mount.source.includes(',')) unavailable();
    if (targets.has(mount.target)) unavailable();
    targets.add(mount.target);
    const normalized = mount.source.replaceAll('\\', '/').toLowerCase();
    if (normalized === '/var/run/docker.sock' || normalized.endsWith('/docker.sock')) unavailable();
    if (isWithin(mount.source, homedir()) || isWithin(process.cwd(), mount.source)) unavailable();
    if (credentialLocations.some((location) => isWithin(join(homedir(), location), mount.source))) unavailable();
  }
}

function containerName(executionId: string): string {
  return `ao-${executionId.replaceAll('_', '-')}`;
}

export function buildDockerRunArgvV4(config: DockerSandboxConfigV4, request: SandboxRunRequestV4): readonly string[] {
  validateDockerSandboxRequestV4(config, request);
  const argv: string[] = [
    ...DOCKER_ISOLATION_ARGS_V4,
    `--name=${containerName(request.execution_id)}`,
    '--init',
    `--workdir=${request.working_directory}`,
  ];
  for (const [key, value] of Object.entries(request.environment).sort(([left], [right]) => left.localeCompare(right))) {
    argv.push(`--env=${key}=${value}`);
  }
  for (const mount of request.mounts) {
    const readonly = mount.access === 'READ_ONLY' ? ',readonly' : '';
    argv.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${readonly}`);
  }
  argv.push(config.image_id, ...request.argv);
  return Object.freeze(argv);
}

export function dockerSandboxPolicyHashV4(config: DockerSandboxConfigV4, profile: SandboxProfileV4): `sha256:${string}` {
  return `sha256:${hashCanonicalV4({
    backend: 'docker-engine-linux-v4',
    broker_version: '0.1.0-v4',
    image_id: config.image_id,
    isolation_args: DOCKER_ISOLATION_ARGS_V4,
    profile,
    provider_hosts: [...config.provider_hosts],
  })}`;
}

function dockerCliEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TEMP', 'TMP',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
}

interface CapturedProcessV4 {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

function appendBounded(current: Buffer[], size: number, chunk: Buffer, limit: number): { size: number; truncated: boolean } {
  if (size >= limit) return { size, truncated: true };
  const available = limit - size;
  const accepted = chunk.subarray(0, available);
  if (accepted.length > 0) current.push(accepted);
  return { size: size + accepted.length, truncated: accepted.length < chunk.length };
}

async function runDockerCliV4(
  executable: string,
  argv: readonly string[],
  maxOutputBytes: number,
): Promise<CapturedProcessV4> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...argv], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerCliEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdoutBytes = appended.size;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(stderr, stderrBytes, chunk, maxOutputBytes);
      stderrBytes = appended.size;
      stderrTruncated ||= appended.truncated;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolvePromise({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdoutTruncated,
      stderrTruncated,
    }));
  });
}

async function forceRemoveContainerV4(config: DockerSandboxConfigV4, name: string): Promise<void> {
  await runDockerCliV4(config.docker_executable, ['rm', '--force', name], 4_096).catch(() => undefined);
}

function mountArgs(request: SandboxRunRequestV4): string[] {
  return request.mounts.flatMap((mount) => {
    const readonly = mount.access === 'READ_ONLY' ? ',readonly' : '';
    return ['--mount', `type=bind,src=${mount.source},dst=${mount.target}${readonly}`];
  });
}

function environmentArgs(request: SandboxRunRequestV4): string[] {
  return Object.entries(request.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `--env=${key}=${value}`);
}

async function assertInternalNetworkV4(config: DockerSandboxConfigV4, request: SandboxRunRequestV4): Promise<void> {
  if (request.network.mode !== 'INTERNAL') unavailable();
  const inspected = await runDockerCliV4(config.docker_executable, ['network', 'inspect', request.network.name], 256 * 1024).catch(() => unavailable());
  if (inspected.exitCode !== 0 || inspected.stdoutTruncated) unavailable();
  try {
    const value = JSON.parse(inspected.stdout) as Array<{ Driver?: unknown; Internal?: unknown; Labels?: Record<string, string> }>;
    const network = value[0];
    if (value.length !== 1
      || network?.Driver !== 'bridge'
      || network.Internal !== true
      || network.Labels?.['agent-orchestration.execution'] !== request.execution_id) unavailable();
  } catch {
    unavailable();
  }
}

async function runAttachedContainerProcessV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
  name: string,
  executableArgs: readonly string[],
): Promise<import('./process-sandbox.js').SandboxRunResultV4> {
  const startedAt = Date.now();
  const child = spawn(config.docker_executable, [...executableArgs], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: dockerCliEnvironment(),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  child.stdout.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const appended = appendBounded(stdout, stdoutBytes, chunk, request.max_output_bytes);
    stdoutBytes = appended.size;
    stdoutTruncated ||= appended.truncated;
  });
  child.stderr.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const appended = appendBounded(stderr, stderrBytes, chunk, request.max_output_bytes);
    stderrBytes = appended.size;
    stderrTruncated ||= appended.truncated;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void forceRemoveContainerV4(config, name).finally(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
  }, request.timeout_ms);
  timeout.unref();
  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    outcome = await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
  } catch {
    clearTimeout(timeout);
    await forceRemoveContainerV4(config, name);
    unavailable();
  }
  clearTimeout(timeout);
  if (timedOut) await forceRemoveContainerV4(config, name);
  return Object.freeze({
    execution_id: request.execution_id,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    timed_out: timedOut,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    duration_ms: Date.now() - startedAt,
  });
}

export async function runDockerSandboxCertificationCandidateV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
): Promise<import('./process-sandbox.js').SandboxRunResultV4> {
  validateDockerSandboxRequestV4(config, request);
  const name = containerName(request.execution_id);
  if (request.network.mode === 'NONE') {
    return await runAttachedContainerProcessV4(config, request, name, buildDockerRunArgvV4(config, request));
  }

  await assertInternalNetworkV4(config, request);
  const bootstrap = [
    ...DOCKER_ISOLATION_ARGS_V4,
    `--name=${name}`,
    '--init',
    `--workdir=${request.working_directory}`,
    ...mountArgs(request),
    '--detach',
    config.image_id,
    'node', '-e', 'setInterval(()=>{},2147483647)',
  ];
  const launched = await runDockerCliV4(config.docker_executable, bootstrap, 16_384).catch(() => unavailable());
  if (launched.exitCode !== 0 || launched.stdoutTruncated || launched.stderrTruncated) unavailable();
  try {
    const disconnected = await runDockerCliV4(config.docker_executable, ['network', 'disconnect', 'none', name], 16_384);
    if (disconnected.exitCode !== 0) unavailable();
    const connected = await runDockerCliV4(config.docker_executable, ['network', 'connect', request.network.name, name], 16_384);
    if (connected.exitCode !== 0) unavailable();
    return await runAttachedContainerProcessV4(config, request, name, [
      'exec',
      `--workdir=${request.working_directory}`,
      ...environmentArgs(request),
      name,
      ...request.argv,
    ]);
  } finally {
    await forceRemoveContainerV4(config, name);
  }
}

function normalizedArchitecture(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'amd64';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'arm64';
  unavailable();
}

export async function inspectDockerSandboxIdentityV4(
  config: DockerSandboxConfigV4,
  profile: SandboxProfileV4,
): Promise<SandboxCertificationIdentityV4> {
  validateDockerSandboxConfigV4(config);
  const [serverOutput, imageOutput] = await Promise.all([
    runDockerCliV4(config.docker_executable, ['info', '--format', '{{json .}}'], 1024 * 1024).catch(() => unavailable()),
    runDockerCliV4(config.docker_executable, ['image', 'inspect', config.image_id], 1024 * 1024).catch(() => unavailable()),
  ]);
  if (serverOutput.exitCode !== 0
    || imageOutput.exitCode !== 0
    || serverOutput.stdoutTruncated
    || imageOutput.stdoutTruncated) unavailable();
  try {
    const server = JSON.parse(serverOutput.stdout) as {
      ID?: unknown;
      ServerVersion?: unknown;
      OSType?: unknown;
      Architecture?: unknown;
      CgroupVersion?: unknown;
      SecurityOptions?: unknown;
    };
    const images = JSON.parse(imageOutput.stdout) as Array<{
      Id?: unknown;
      Os?: unknown;
      Architecture?: unknown;
    }>;
    const image = images[0];
    const securityOptions = Array.isArray(server.SecurityOptions) ? server.SecurityOptions : [];
    if (typeof server.ID !== 'string'
      || server.ID.length === 0
      || typeof server.ServerVersion !== 'string'
      || server.ServerVersion.length === 0
      || server.OSType !== 'linux'
      || typeof server.Architecture !== 'string'
      || (server.CgroupVersion !== '1' && server.CgroupVersion !== '2')
      || !securityOptions.some((option) => typeof option === 'string' && option.startsWith('name=seccomp'))
      || !securityOptions.some((option) => typeof option === 'string' && option.startsWith('name=cgroupns'))
      || images.length !== 1
      || image?.Id !== config.image_id
      || image.Os !== 'linux'
      || typeof image.Architecture !== 'string') unavailable();
    const serverArchitecture = normalizedArchitecture(server.Architecture);
    const imageArchitecture = normalizedArchitecture(image.Architecture);
    const brokerArchitecture = normalizedArchitecture(process.arch);
    if (serverArchitecture !== imageArchitecture || brokerArchitecture !== imageArchitecture) unavailable();
    return Object.freeze({
      backend_id: 'docker-engine-linux-v4',
      docker_server_id: server.ID,
      docker_server_version: server.ServerVersion,
      docker_server_os: 'linux',
      docker_server_architecture: serverArchitecture,
      image_id: config.image_id,
      image_os: 'linux',
      image_architecture: imageArchitecture,
      profile,
      policy_hash: dockerSandboxPolicyHashV4(config, profile),
      broker_version: '0.1.0-v4',
    });
  } catch {
    unavailable();
  }
}

export interface DockerProcessSandboxDependenciesV4 {
  readonly certifications: readonly SandboxCertificationV4[];
  readonly now?: () => string;
}

const unsupportedResult: SandboxProbeResultV4 = Object.freeze({
  status: 'UNSUPPORTED',
  failure: 'PROCESS_SANDBOX_UNAVAILABLE',
});

export function createDockerProcessSandboxV4(
  config: DockerSandboxConfigV4,
  dependencies: DockerProcessSandboxDependenciesV4,
): ProcessSandboxBackendV4 {
  validateDockerSandboxConfigV4(config);
  const certifications = Object.freeze([...dependencies.certifications]);
  const active = new Set<string>();
  const probe = async (profile: SandboxProfileV4): Promise<SandboxProbeResultV4> => {
    try {
      const identity = await inspectDockerSandboxIdentityV4(config, profile);
      const now = dependencies.now?.() ?? new Date().toISOString();
      const certification = certifications.find((candidate) => matchesSandboxCertificationV4(candidate, identity, now));
      if (certification === undefined) return unsupportedResult;
      return Object.freeze({
        status: 'SUPPORTED',
        backend_id: 'docker-engine-linux-v4',
        policy_hash: identity.policy_hash,
        certification_hash: certification.certification_hash,
        expires_at: certification.expires_at,
      });
    } catch {
      return unsupportedResult;
    }
  };
  return Object.freeze({
    id: 'docker-engine-linux-v4',
    probe,
    run: async (request: SandboxRunRequestV4) => {
      if ((await probe(request.profile)).status !== 'SUPPORTED' || active.has(request.execution_id)) unavailable();
      active.add(request.execution_id);
      try {
        return await runDockerSandboxCertificationCandidateV4(config, request);
      } finally {
        active.delete(request.execution_id);
      }
    },
    terminate: async (executionId: string) => {
      if (!active.has(executionId)) return;
      await forceRemoveContainerV4(config, containerName(executionId));
    },
  });
}
