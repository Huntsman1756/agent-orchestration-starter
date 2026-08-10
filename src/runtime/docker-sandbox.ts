import { homedir } from 'node:os';
import { lstat, realpath } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';
import type {
  DockerContainerRemovalControllerV4,
  ProcessSandboxBackendV4,
  SandboxProbeResultV4,
  SandboxProfileV4,
  SandboxRunRequestV4,
} from './process-sandbox.js';
import { createDockerContainerRemovalControllerV4 } from './process-sandbox.js';
export { createDockerContainerRemovalControllerV4 } from './process-sandbox.js';
import {
  REQUIRED_SANDBOX_EFFECTS_V4,
  validateSandboxCertificationTranscriptV4,
  type SandboxCertificationIdentityV4,
  type SandboxCertificationTranscriptV4,
} from './sandbox-certification.js';
import { startProviderEgressGatewayV4 } from './provider-egress-gateway.js';
import { runBoundedProcessV4, startBoundedProcessV4 } from './bounded-process.js';
import { dockerCliEnvironmentV4, registerOrReproveDockerLauncherV4 } from './docker-launcher.js';
import { createBrokerOwnedDockerContainerV4 } from './docker-container-transaction.js';

export interface DockerSandboxConfigV4 {
  docker_executable: string;
  image_id: `sha256:${string}`;
  certification_ttl_seconds: number;
  provider_hosts: readonly string[];
  allowed_mount_roots: readonly string[];
  active_worktree: string;
  broker_state_directory: string;
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

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

export function validateDockerSandboxConfigV4(config: DockerSandboxConfigV4): void {
  if (process.env.DOCKER_HOST !== undefined || process.env.DOCKER_CONTEXT !== undefined) unavailable();
  if (!isAbsolute(config.docker_executable)
    || resolve(config.docker_executable) !== config.docker_executable
    || !/^docker(?:\.exe)?$/i.test(basename(config.docker_executable))
    || config.docker_executable.includes('\0')) unavailable();
  if (!/^sha256:[a-f0-9]{64}$/.test(config.image_id)) unavailable();
  if (!Number.isSafeInteger(config.certification_ttl_seconds)
    || config.certification_ttl_seconds < 1
    || config.certification_ttl_seconds > 900) unavailable();
  if (config.provider_hosts.length !== 1 || config.provider_hosts[0] !== 'api.arliai.com') unavailable();
  if (config.allowed_mount_roots.length === 0
    || config.allowed_mount_roots.length > 16
    || !isAbsolute(config.active_worktree)
    || !isAbsolute(config.broker_state_directory)
    || config.active_worktree.includes('\0')
    || config.broker_state_directory.includes('\0')) unavailable();
  const roots = new Set<string>();
  for (const root of config.allowed_mount_roots) {
    if (!isAbsolute(root) || root.includes('\0') || root.includes(',') || resolve(root) !== root || roots.has(root)) unavailable();
    roots.add(root);
  }
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
    if (!isAbsolute(mount.source)
      || resolve(mount.source) !== mount.source
      || mount.source.includes('\0')
      || mount.source.includes(',')
      || !(['/capsule', '/workspace', '/scratch'] as const).includes(mount.target)
      || !(['READ_ONLY', 'READ_WRITE'] as const).includes(mount.access)) unavailable();
    if (targets.has(mount.target)) unavailable();
    targets.add(mount.target);
    const normalized = mount.source.replaceAll('\\', '/').toLowerCase();
    if (normalized === '/var/run/docker.sock' || normalized.endsWith('/docker.sock')) unavailable();
    if (!config.allowed_mount_roots.some((root) => isWithin(root, mount.source))) unavailable();
    if (overlaps(mount.source, homedir())
      || overlaps(mount.source, config.active_worktree)
      || overlaps(mount.source, config.broker_state_directory)) unavailable();
    if (credentialLocations.some((location) => overlaps(join(homedir(), location), mount.source))) unavailable();
  }
}

interface PhysicalPathIdentityV4 {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface DockerSandboxMountProofV4 {
  readonly request_hash: `sha256:${string}`;
  readonly policy_hash: `sha256:${string}`;
  readonly sources: readonly {
    readonly source: string;
    readonly canonical_source: string;
    readonly chain: readonly PhysicalPathIdentityV4[];
  }[];
}

const issuedMountProofs = new WeakSet<object>();

function normalizedPhysicalPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function inspectPhysicalSourceV4(source: string): Promise<{
  source: string;
  canonical_source: string;
  chain: readonly PhysicalPathIdentityV4[];
}> {
  const paths: string[] = [];
  let current = resolve(source);
  const root = parse(current).root;
  while (true) {
    paths.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) unavailable();
    current = parent;
  }
  paths.reverse();
  const chain: PhysicalPathIdentityV4[] = [];
  for (const path of paths) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path, { bigint: true });
    } catch {
      unavailable();
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.ino <= 0n || metadata.dev < 0n) unavailable();
    chain.push(Object.freeze({ path, device: String(metadata.dev), inode: String(metadata.ino) }));
  }
  let canonical: string;
  try {
    canonical = await realpath(source);
  } catch {
    unavailable();
  }
  if (normalizedPhysicalPath(canonical) !== normalizedPhysicalPath(source)) unavailable();
  return Object.freeze({ source, canonical_source: canonical, chain: Object.freeze(chain) });
}

function mountRequestHashV4(request: SandboxRunRequestV4): `sha256:${string}` {
  return `sha256:${hashCanonicalV4({ mounts: request.mounts, execution_id: request.execution_id })}`;
}

function mountPolicyHashV4(config: DockerSandboxConfigV4): `sha256:${string}` {
  return `sha256:${hashCanonicalV4({
    active_worktree: config.active_worktree,
    allowed_mount_roots: config.allowed_mount_roots,
    broker_state_directory: config.broker_state_directory,
  })}`;
}

export async function proveDockerSandboxMountsV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
): Promise<DockerSandboxMountProofV4> {
  validateDockerSandboxRequestV4(config, request);
  const sources = await Promise.all(request.mounts.map(async (mount) => await inspectPhysicalSourceV4(mount.source)));
  const proof = Object.freeze({
    request_hash: mountRequestHashV4(request),
    policy_hash: mountPolicyHashV4(config),
    sources: Object.freeze(sources),
  });
  issuedMountProofs.add(proof);
  return proof;
}

export async function reproveDockerSandboxMountsV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
  proof: DockerSandboxMountProofV4,
): Promise<void> {
  validateDockerSandboxRequestV4(config, request);
  if (!issuedMountProofs.has(proof)
    || proof.request_hash !== mountRequestHashV4(request)
    || proof.policy_hash !== mountPolicyHashV4(config)
    || proof.sources.length !== request.mounts.length) unavailable();
  const current = await Promise.all(request.mounts.map(async (mount) => await inspectPhysicalSourceV4(mount.source)));
  if (hashCanonicalV4(current) !== hashCanonicalV4(proof.sources)) unavailable();
}

function containerName(executionId: string): string {
  return `ao-${executionId.replaceAll('_', '-')}`;
}

interface DockerCreateAuthorityV4 {
  readonly name: string;
  readonly nonce: string;
  readonly label_args: readonly string[];
}

function createDockerAuthorityV4(executionId: string, imageId: `sha256:${string}`): DockerCreateAuthorityV4 {
  const nonce = randomBytes(16).toString('hex');
  return Object.freeze({
    name: `${containerName(executionId)}-${nonce}`,
    nonce,
    label_args: Object.freeze([
      `--label=agent-orchestration.execution=${executionId}`,
      `--label=agent-orchestration.nonce=${nonce}`,
      `--label=agent-orchestration.image=${imageId}`,
    ]),
  });
}

export function buildDockerRunArgvV4(config: DockerSandboxConfigV4, request: SandboxRunRequestV4): readonly string[] {
  validateDockerSandboxRequestV4(config, request);
  const authority = createDockerAuthorityV4(request.execution_id, config.image_id);
  const argv: string[] = [
    ...DOCKER_ISOLATION_ARGS_V4,
    `--name=${authority.name}`,
    ...authority.label_args,
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
    docker_endpoint: {
      context: null,
      host: process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock',
      config_directory: join(config.broker_state_directory, 'docker-cli-v4-empty'),
      config_state: 'ABSENT',
    },
    docker_executable: config.docker_executable,
    image_id: config.image_id,
    isolation_args: DOCKER_ISOLATION_ARGS_V4,
    profile,
    provider_hosts: [...config.provider_hosts],
    mount_policy: {
      active_worktree: config.active_worktree,
      allowed_mount_roots: [...config.allowed_mount_roots],
      broker_state_directory: config.broker_state_directory,
    },
  })}`;
}

interface CapturedProcessV4 {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

type DockerCommandClassV4 = 'IDENTITY' | 'CREATE' | 'CONTROL' | 'CLEANUP' | 'NETWORK';
const DOCKER_COMMAND_DEADLINES_V4: Readonly<Record<DockerCommandClassV4, number>> = Object.freeze({
  IDENTITY: 10_000,
  CREATE: 15_000,
  CONTROL: 10_000,
  CLEANUP: 10_000,
  NETWORK: 10_000,
});

interface DockerCliOptionsV4 {
  readonly command_class?: DockerCommandClassV4;
  readonly signal?: AbortSignal;
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
  options: DockerCliOptionsV4 = {},
): Promise<CapturedProcessV4> {
  await registerOrReproveDockerLauncherV4(executable, options.signal);
  const result = await runBoundedProcessV4({
    executable,
    argv,
    environment: await dockerCliEnvironmentV4(executable, options.signal),
    deadline_ms: DOCKER_COMMAND_DEADLINES_V4[options.command_class ?? 'CONTROL'],
    max_output_bytes: maxOutputBytes,
    signal: options.signal,
  });
  if (result.termination !== null) unavailable();
  return {
    exitCode: result.exit_code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdout_truncated,
    stderrTruncated: result.stderr_truncated,
  };
}

async function exactContainerIdPresentV4(config: DockerSandboxConfigV4, containerId: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runDockerCliV4(config.docker_executable, [
    'container', 'ls', '--all', '--no-trunc', `--filter=id=${containerId}`, '--format', '{{.ID}}',
  ], 4_096, { command_class: 'CONTROL', signal }).catch(() => unavailable());
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) unavailable();
  const output = result.stdout.trim();
  if (output === '') return false;
  if (output === containerId) return true;
  unavailable();
}

function removalControllerV4(config: DockerSandboxConfigV4, containerId: string) {
  return createDockerContainerRemovalControllerV4(containerId, {
    inspect_exact_id: async (id) => await exactContainerIdPresentV4(config, id),
    force_remove_exact_id: async (id) => {
      const result = await runDockerCliV4(config.docker_executable, ['rm', '--force', id], 4_096).catch(() => unavailable());
      if (result.exitCode !== 0
        || result.stdoutTruncated
        || result.stderrTruncated
        || result.stdout.trim() !== id) unavailable();
    },
    poll_interval_ms: 25,
    absence_timeout_ms: 5_000,
  });
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

async function assertInternalNetworkV4(config: DockerSandboxConfigV4, request: SandboxRunRequestV4, signal?: AbortSignal): Promise<void> {
  if (request.network.mode !== 'INTERNAL') unavailable();
  const inspected = await runDockerCliV4(config.docker_executable, ['network', 'inspect', request.network.name], 256 * 1024, {
    command_class: 'NETWORK', signal,
  }).catch(() => unavailable());
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
  removal: DockerContainerRemovalControllerV4,
  executableArgs: readonly string[],
  signal?: AbortSignal,
): Promise<import('./process-sandbox.js').SandboxRunResultV4> {
  const startedAt = Date.now();
  await registerOrReproveDockerLauncherV4(config.docker_executable, signal, config.broker_state_directory);
  const processHandle = startBoundedProcessV4({
    executable: config.docker_executable,
    argv: executableArgs,
    environment: await dockerCliEnvironmentV4(config.docker_executable, signal),
    deadline_ms: request.timeout_ms,
    max_output_bytes: request.max_output_bytes,
    signal,
  });
  processHandle.child.stdin.end();
  let outcome: Awaited<typeof processHandle.completion>;
  try {
    outcome = await processHandle.completion;
  } catch {
    await removal.remove();
    unavailable();
  }
  const timedOut = outcome.termination === 'TIMEOUT';
  if (outcome.termination !== null) {
    await removal.remove().catch(() => unavailable());
    if (!timedOut) unavailable();
  }
  return Object.freeze({
    execution_id: request.execution_id,
    exit_code: outcome.exit_code,
    signal: outcome.signal,
    timed_out: timedOut,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    stdout_truncated: outcome.stdout_truncated,
    stderr_truncated: outcome.stderr_truncated,
    duration_ms: Date.now() - startedAt,
  });
}

interface DockerExecutionLifecycleV4 {
  cancelled: boolean;
  controller: DockerContainerRemovalControllerV4 | null;
  cleanup_error: unknown | null;
  readonly abort_controller: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

function createDockerExecutionLifecycleV4(): DockerExecutionLifecycleV4 {
  let settle!: () => void;
  const settled = new Promise<void>((resolvePromise) => { settle = resolvePromise; });
  return { cancelled: false, controller: null, cleanup_error: null, abort_controller: new AbortController(), settled, settle };
}

async function cancellationCheckpointV4(lifecycle?: DockerExecutionLifecycleV4): Promise<void> {
  if (lifecycle?.cancelled !== true) return;
  if (lifecycle.controller !== null) {
    try {
      await lifecycle.controller.remove();
    } catch (error) {
      lifecycle.cleanup_error = error;
      throw error;
    }
  }
  unavailable();
}

async function recoverCreatedContainerV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
  authority: DockerCreateAuthorityV4,
): Promise<DockerContainerRemovalControllerV4 | null> {
  const listed = await runDockerCliV4(config.docker_executable, [
    'container', 'ls', '--all', '--no-trunc',
    `--filter=label=agent-orchestration.nonce=${authority.nonce}`,
    '--format', '{{.ID}}',
  ], 4_096, { command_class: 'CLEANUP' }).catch(() => unavailable());
  if (listed.exitCode !== 0 || listed.stdoutTruncated || listed.stderrTruncated) unavailable();
  const ids = listed.stdout.trim().split('\n').filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) unavailable();
  const containerId = ids[0]!;
  const inspected = await runDockerCliV4(config.docker_executable, ['container', 'inspect', containerId], 256 * 1024, {
    command_class: 'CLEANUP',
  }).catch(() => unavailable());
  if (inspected.exitCode !== 0 || inspected.stdoutTruncated || inspected.stderrTruncated) unavailable();
  try {
    const values = JSON.parse(inspected.stdout) as Array<{
      Id?: unknown;
      Config?: { Image?: unknown; Labels?: Record<string, string> };
    }>;
    const value = values[0];
    if (values.length !== 1
      || value?.Id !== containerId
      || value.Config?.Image !== config.image_id
      || value.Config?.Labels?.['agent-orchestration.execution'] !== request.execution_id
      || value.Config.Labels['agent-orchestration.nonce'] !== authority.nonce
      || value.Config.Labels['agent-orchestration.image'] !== config.image_id) unavailable();
    return removalControllerV4(config, containerId);
  } catch {
    unavailable();
  }
}

async function runDockerSandboxCandidateOwnedV4(
  config: DockerSandboxConfigV4,
  request: SandboxRunRequestV4,
  lifecycle?: DockerExecutionLifecycleV4,
  onController?: (controller: DockerContainerRemovalControllerV4) => void,
): Promise<import('./process-sandbox.js').SandboxRunResultV4> {
  validateDockerSandboxRequestV4(config, request);
  await cancellationCheckpointV4(lifecycle);
  const mountProof = await proveDockerSandboxMountsV4(config, request);
  await cancellationCheckpointV4(lifecycle);
  if (request.network.mode === 'INTERNAL') {
    await cancellationCheckpointV4(lifecycle);
    await assertInternalNetworkV4(config, request, lifecycle?.abort_controller.signal);
    await cancellationCheckpointV4(lifecycle);
  }
  await cancellationCheckpointV4(lifecycle);
  await reproveDockerSandboxMountsV4(config, request, mountProof);
  await cancellationCheckpointV4(lifecycle);
  const networkless = request.network.mode === 'NONE';
  const createArgs = [
    ...DOCKER_ISOLATION_ARGS_V4.slice(1),
    '--init',
    `--workdir=${request.working_directory}`,
    ...(networkless ? environmentArgs(request) : []),
    ...mountArgs(request),
    config.image_id,
    ...(networkless ? request.argv : ['node', '-e', 'setInterval(()=>{},2147483647)']),
  ];
  await cancellationCheckpointV4(lifecycle);
  let owned: Awaited<ReturnType<typeof createBrokerOwnedDockerContainerV4>>;
  try {
    owned = await createBrokerOwnedDockerContainerV4({
      docker_executable: config.docker_executable,
      broker_state_directory: config.broker_state_directory,
      image_id: config.image_id,
      execution_id: request.execution_id,
      kind: 'executor',
      create_arguments: createArgs,
      signal: lifecycle?.abort_controller.signal,
    });
  } catch {
    unavailable();
  }
  const containerId = owned.container_id;
  const removal = owned.removal;
  if (lifecycle !== undefined) lifecycle.controller = removal;
  onController?.(removal);
  try {
    if (!await exactContainerIdPresentV4(config, containerId, lifecycle?.abort_controller.signal)) unavailable();
    await cancellationCheckpointV4(lifecycle);
    if (networkless) {
      await cancellationCheckpointV4(lifecycle);
      const result = await runAttachedContainerProcessV4(
        config, request, removal, ['start', '--attach', containerId], lifecycle?.abort_controller.signal,
      );
      await cancellationCheckpointV4(lifecycle);
      return result;
    }
    const disconnected = await runDockerCliV4(config.docker_executable, ['network', 'disconnect', 'none', containerId], 16_384, {
      command_class: 'NETWORK', signal: lifecycle?.abort_controller.signal,
    });
    await cancellationCheckpointV4(lifecycle);
    if (disconnected.exitCode !== 0) unavailable();
    const connected = await runDockerCliV4(config.docker_executable, ['network', 'connect', request.network.name, containerId], 16_384, {
      command_class: 'NETWORK', signal: lifecycle?.abort_controller.signal,
    });
    await cancellationCheckpointV4(lifecycle);
    if (connected.exitCode !== 0) unavailable();
    await cancellationCheckpointV4(lifecycle);
    const started = await runDockerCliV4(config.docker_executable, ['start', containerId], 16_384, {
      command_class: 'CONTROL', signal: lifecycle?.abort_controller.signal,
    });
    await cancellationCheckpointV4(lifecycle);
    if (started.exitCode !== 0 || started.stdout.trim() !== containerId) unavailable();
    await cancellationCheckpointV4(lifecycle);
    const result = await runAttachedContainerProcessV4(config, request, removal, [
      'exec',
      `--workdir=${request.working_directory}`,
      ...environmentArgs(request),
      containerId,
      ...request.argv,
    ], lifecycle?.abort_controller.signal);
    await cancellationCheckpointV4(lifecycle);
    return result;
  } finally {
    try {
      await removal.remove();
    } catch (error) {
      if (lifecycle !== undefined) lifecycle.cleanup_error = error;
      throw error;
    } finally {
      if (lifecycle !== undefined && lifecycle.controller === removal) lifecycle.controller = null;
    }
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
  signal?: AbortSignal,
): Promise<SandboxCertificationIdentityV4> {
  validateDockerSandboxConfigV4(config);
  const launcher = await registerOrReproveDockerLauncherV4(config.docker_executable, signal, config.broker_state_directory);
  const [serverOutput, imageOutput] = await Promise.all([
    runDockerCliV4(config.docker_executable, ['info', '--format', '{{json .}}'], 1024 * 1024, { command_class: 'IDENTITY', signal }).catch(() => unavailable()),
    runDockerCliV4(config.docker_executable, ['image', 'inspect', config.image_id], 1024 * 1024, { command_class: 'IDENTITY', signal }).catch(() => unavailable()),
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
      policy_hash: `sha256:${hashCanonicalV4({
        launcher,
        policy_hash: dockerSandboxPolicyHashV4(config, profile),
      })}`,
      broker_version: '0.1.0-v4',
    });
  } catch {
    unavailable();
  }
}

async function requiredDockerOutputV4(
  config: DockerSandboxConfigV4,
  argv: readonly string[],
  limit = 1024 * 1024,
): Promise<string> {
  const result = await runDockerCliV4(config.docker_executable, argv, limit).catch(() => unavailable());
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) unavailable();
  return result.stdout.trim();
}

export function isDockerNetworkSubnetOverlapV4(stderr: string): boolean {
  return /^Error response from daemon: (?:invalid pool request: )?Pool overlaps with other one on this address space\r?\n?$/.test(stderr);
}

export function isDockerNetworkAbsentV4(
  networkId: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): boolean {
  return exitCode === 1
    && stdout === '[]\n'
    && stderr === `Error response from daemon: network ${networkId} not found\n`;
}

interface CertificationNetworkAuthorityV4 {
  readonly execution_id: string;
  readonly image_id: `sha256:${string}`;
  readonly internal: boolean;
  readonly kind: 'internal' | 'outbound';
  readonly name: string;
  readonly nonce: string;
  readonly subnet?: string;
}

const pendingCertificationNetworkCleanupV4 = new Map<string, {
  readonly config: DockerSandboxConfigV4;
  readonly network_id: string;
  readonly authority: CertificationNetworkAuthorityV4;
}>();

function certificationNetworkCleanupKeyV4(config: DockerSandboxConfigV4, networkId: string): string {
  return `${config.docker_executable}\0${networkId}`;
}

function retainCertificationNetworkCleanupV4(
  config: DockerSandboxConfigV4,
  networkId: string,
  authority: CertificationNetworkAuthorityV4,
): void {
  pendingCertificationNetworkCleanupV4.set(
    certificationNetworkCleanupKeyV4(config, networkId),
    { config, network_id: networkId, authority },
  );
}

async function retryPendingCertificationNetworkCleanupV4(config: DockerSandboxConfigV4): Promise<void> {
  for (const pending of [...pendingCertificationNetworkCleanupV4.values()]) {
    if (pending.config.docker_executable === config.docker_executable) {
      await removeCertificationNetworkV4(pending.config, pending.network_id);
    }
  }
}

async function recoverCertificationNetworkV4(
  config: DockerSandboxConfigV4,
  authority: CertificationNetworkAuthorityV4,
): Promise<string | null> {
  const listed = await runDockerCliV4(config.docker_executable, [
    'network', 'ls', '--no-trunc',
    '--filter', `label=agent-orchestration.execution=${authority.execution_id}`,
    '--filter', `label=agent-orchestration.nonce=${authority.nonce}`,
    '--filter', `label=agent-orchestration.network-kind=${authority.kind}`,
    '--format', '{{.ID}}',
  ], 16_384, { command_class: 'NETWORK' });
  if (listed.exitCode !== 0 || listed.stdoutTruncated || listed.stderrTruncated) unavailable();
  const ids = listed.stdout.trim().split('\n').filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!)) unavailable();

  const networkId = ids[0]!;
  if (await inspectCertificationNetworkV4(config, authority, networkId) !== true) unavailable();
  return networkId;
}

async function inspectCertificationNetworkV4(
  config: DockerSandboxConfigV4,
  authority: CertificationNetworkAuthorityV4,
  networkId: string,
): Promise<true | 'ABSENT'> {
  const inspected = await runDockerCliV4(
    config.docker_executable,
    ['network', 'inspect', networkId],
    256 * 1024,
    { command_class: 'NETWORK' },
  );
  if (inspected.stdoutTruncated || inspected.stderrTruncated) unavailable();
  if (isDockerNetworkAbsentV4(networkId, inspected.exitCode, inspected.stdout, inspected.stderr)) return 'ABSENT';
  if (inspected.exitCode !== 0) unavailable();
  let record: {
    Id?: unknown;
    Name?: unknown;
    Driver?: unknown;
    Internal?: unknown;
    Labels?: Record<string, unknown> | null;
  };
  try {
    const parsed = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) unavailable();
    record = parsed[0] as typeof record;
  } catch {
    unavailable();
  }
  if (record.Id !== networkId
    || record.Name !== authority.name
    || record.Driver !== 'bridge'
    || record.Internal !== authority.internal
    || record.Labels?.['agent-orchestration.execution'] !== authority.execution_id
    || record.Labels?.['agent-orchestration.nonce'] !== authority.nonce
    || record.Labels?.['agent-orchestration.image'] !== authority.image_id
    || record.Labels?.['agent-orchestration.network-kind'] !== authority.kind) unavailable();
  return true;
}

async function createCertificationNetworkV4(
  config: DockerSandboxConfigV4,
  authority: CertificationNetworkAuthorityV4,
  overlapRetryMs = 0,
  register: (networkId: string) => void,
): Promise<string> {
  const deadline = Date.now() + overlapRetryMs;
  const argv = [
    '--driver=bridge',
    ...(authority.internal ? ['--internal'] : []),
    ...(authority.subnet === undefined ? [] : [`--subnet=${authority.subnet}`]),
    '--label', `agent-orchestration.execution=${authority.execution_id}`,
    '--label', `agent-orchestration.nonce=${authority.nonce}`,
    '--label', `agent-orchestration.image=${authority.image_id}`,
    '--label', `agent-orchestration.network-kind=${authority.kind}`,
    authority.name,
  ];
  do {
    let created: Awaited<ReturnType<typeof runDockerCliV4>> | null = null;
    try {
      created = await runDockerCliV4(config.docker_executable, ['network', 'create', ...argv], 16_384, {
        command_class: 'NETWORK',
      });
      const networkId = created.stdout.trim();
      if (created.exitCode === 0
        && !created.stdoutTruncated
        && !created.stderrTruncated
        && /^[a-f0-9]{64}$/.test(networkId)) {
        retainCertificationNetworkCleanupV4(config, networkId, authority);
        register(networkId);
        const proved = await recoverCertificationNetworkV4(config, authority);
        if (proved !== networkId) unavailable();
        return networkId;
      }
    } catch {
      // A timed out or interrupted create may still have changed Docker state.
    }

    const recovered = await recoverCertificationNetworkV4(config, authority);
    if (recovered !== null) {
      retainCertificationNetworkCleanupV4(config, recovered, authority);
      register(recovered);
      await removeCertificationNetworkV4(config, recovered);
      unavailable();
    }
    if (created === null || !isDockerNetworkSubnetOverlapV4(created.stderr)) unavailable();
    if (Date.now() >= deadline) unavailable();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (true);
}

async function removeCertificationNetworkV4(config: DockerSandboxConfigV4, networkId: string): Promise<void> {
  const key = certificationNetworkCleanupKeyV4(config, networkId);
  const pending = pendingCertificationNetworkCleanupV4.get(key);
  if (pending === undefined) unavailable();
  const before = await inspectCertificationNetworkV4(config, pending.authority, networkId);
  if (before === 'ABSENT') {
    pendingCertificationNetworkCleanupV4.delete(key);
    return;
  }
  const removed = await runDockerCliV4(
    config.docker_executable,
    ['network', 'rm', networkId],
    16_384,
    { command_class: 'CLEANUP' },
  ).catch(() => null);
  const deadline = Date.now() + 5_000;
  do {
    const state = await inspectCertificationNetworkV4(config, pending.authority, networkId);
    if (state === 'ABSENT') {
      pendingCertificationNetworkCleanupV4.delete(key);
      return;
    }
    if (removed === null
      || removed.exitCode !== 0
      || removed.stdoutTruncated
      || removed.stderrTruncated
      || removed.stdout.trim() !== networkId
      || removed.stderr !== '') unavailable();
    if (Date.now() >= deadline) unavailable();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  } while (true);
}

async function waitForExactContainerRunningV4(config: DockerSandboxConfigV4, containerId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await runDockerCliV4(
      config.docker_executable,
      ['inspect', '--format', '{{.State.Running}}', containerId],
      4_096,
    ).catch(() => unavailable());
    if (state.exitCode === 0 && state.stdout.trim() === 'true') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  unavailable();
}

async function startCertificationTlsFixtureV4(
  config: DockerSandboxConfigV4,
  networkId: string,
  address: string,
  certificateDirectory: string,
  suffix: string,
): Promise<DockerContainerRemovalControllerV4> {
  const source = [
    "const https=require('node:https'),fs=require('node:fs'),crypto=require('node:crypto');",
    "const server=https.createServer({key:fs.readFileSync('/scratch/key.pem'),cert:fs.readFileSync('/scratch/cert.pem')},(req,res)=>{",
    "let bytes=0;req.on('data',(chunk)=>{bytes+=chunk.length});req.on('end',()=>{",
    "const authHash=crypto.createHash('sha256').update(req.headers.authorization??'').digest('hex');",
    "res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({auth_hash:authHash,bytes}));});});",
    "server.listen(443,'0.0.0.0');",
  ].join('');
  const createArgs = [
    '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=256m', '--cpus=1',
    '--user=1000:1000', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m', '--network=none',
    '--mount', `type=bind,src=${certificateDirectory},dst=/scratch,readonly`,
    config.image_id, 'node', '-e', source,
  ];
  const owned = await createBrokerOwnedDockerContainerV4({
    docker_executable: config.docker_executable,
    broker_state_directory: config.broker_state_directory,
    image_id: config.image_id,
    execution_id: `exec_cert_${suffix}_network`,
    kind: 'tls-fixture',
    create_arguments: createArgs,
  });
  const containerId = owned.container_id;
  const removal = owned.removal;
  try {
    await requiredDockerOutputV4(config, ['network', 'disconnect', 'none', containerId], 16_384);
    await requiredDockerOutputV4(config, ['network', 'connect', '--alias=api.arliai.com', `--ip=${address}`, networkId, containerId], 16_384);
    const started = await requiredDockerOutputV4(config, ['start', containerId], 16_384);
    if (started !== containerId) unavailable();
    await waitForExactContainerRunningV4(config, containerId);
    return removal;
  } catch {
    await removal.remove();
    unavailable();
  }
}

function transcriptArtifactV4(
  artifactId: string,
  executionId: string,
  kind: import('./sandbox-certification.js').SandboxCertificationArtifactKindV4,
  startedAt: string,
  completedAt: string,
  content: string,
) {
  const bytes = Buffer.from(content);
  return Object.freeze({
    artifact_id: artifactId,
    execution_id: executionId,
    kind,
    started_at: startedAt,
    completed_at: completedAt,
    content_base64: bytes.toString('base64'),
    content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
  });
}

export async function runDockerSandboxHostileCertificationV4(
  config: DockerSandboxConfigV4,
  identity: SandboxCertificationIdentityV4,
): Promise<SandboxCertificationTranscriptV4> {
  await retryPendingCertificationNetworkCleanupV4(config).catch(() => unavailable());
  const runSuffix = randomBytes(16).toString('hex');
  const root = await mkdtemp(join(config.allowed_mount_roots[0]!, `.ao-cert-${runSuffix}-`)).catch(() => unavailable());
  if (overlaps(root, homedir()) || overlaps(root, config.active_worktree) || overlaps(root, config.broker_state_directory)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    unavailable();
  }
  const startedAt = new Date().toISOString();
  const certificateDirectory = join(root, 'certificate');
  const scratchDirectory = join(root, 'scratch');
  const sentinel = join(root, 'outside-sentinel.txt');
  const survivor = join(scratchDirectory, 'grandchild-survived.txt');
  const internalName = `ao-int-exec-cert-${runSuffix}`;
  const outboundName = `ao-out-exec-cert-${runSuffix}`;
  const executionPrefix = `exec_cert_${runSuffix}`;
  const syntheticCredential = `synthetic-arliai-certification-${runSuffix}`;
  let loopbackConnections = 0;
  const loopbackServer = createTcpServer((socket) => {
    loopbackConnections += 1;
    socket.destroy();
  });
  let internalNetworkId = '';
  let outboundNetworkId = '';
  let upstream: DockerContainerRemovalControllerV4 | null = null;
  let gateway: Awaited<ReturnType<typeof startProviderEgressGatewayV4>> | null = null;
  let cleanupFailure = false;
  try {
    await Promise.all([
      mkdir(certificateDirectory, { recursive: true }),
      mkdir(scratchDirectory, { recursive: true }),
      import('node:fs/promises').then(async ({ writeFile }) => await writeFile(sentinel, 'synthetic-outside-sentinel', 'utf8')),
    ]);
    await new Promise<void>((resolvePromise, reject) => {
      loopbackServer.once('error', reject);
      loopbackServer.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = loopbackServer.address();
    if (address === null || typeof address === 'string') unavailable();

    const processResult = await runDockerSandboxCandidateOwnedV4(config, {
      execution_id: `${executionPrefix}_process`,
      profile: 'VALIDATION_UNTRUSTED',
      argv: [
        'node', '/broker/certification/hostile-child.mjs', 'audit',
        `--outside-host-path=${sentinel}`, `--host-home=${homedir()}`,
        `--host-loopback-port=${address.port}`,
      ],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [],
      network: { mode: 'NONE' },
      timeout_ms: 30_000,
      max_output_bytes: 64 * 1024,
    });
    if (processResult.exit_code !== 0 || processResult.timed_out) unavailable();
    const processEvidence = JSON.parse(processResult.stdout) as Record<string, unknown>;
    const pidLimit = processEvidence.pid_limit as { rejected?: unknown };
    if (processEvidence.outside_sentinel_readable !== false
      || processEvidence.host_home_enumerable !== false
      || hashCanonicalV4(processEvidence.credential_environment) !== hashCanonicalV4({})
      || hashCanonicalV4(processEvidence.credential_argv) !== hashCanonicalV4([])
      || processEvidence.credential_files !== false
      || hashCanonicalV4(processEvidence.descendant_credential_environment) !== hashCanonicalV4({})
      || hashCanonicalV4(processEvidence.descendant_credential_argv) !== hashCanonicalV4([])
      || processEvidence.outside_write_succeeded !== false
      || typeof pidLimit?.rejected !== 'number'
      || pidLimit.rejected <= 0
      || processEvidence.docker_socket_exists !== false
      || processEvidence.docker_socket_connectable !== false
      || processEvidence.host_loopback_connectable !== false
      || processEvidence.host_loopback_port !== address.port
      || loopbackConnections !== 0
      || await readFile(sentinel, 'utf8') !== 'synthetic-outside-sentinel') unavailable();

    const timeoutResult = await runDockerSandboxCandidateOwnedV4(config, {
      execution_id: `${executionPrefix}_timeout`,
      profile: 'VALIDATION_UNTRUSTED',
      argv: ['node', '/broker/certification/hostile-child.mjs', 'grandchild', '/scratch/grandchild-survived.txt'],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [{ source: scratchDirectory, target: '/scratch', access: 'READ_WRITE' }],
      network: { mode: 'NONE' },
      timeout_ms: 500,
      max_output_bytes: 4_096,
    });
    if (!timeoutResult.timed_out) unavailable();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
    if (await readFile(survivor).then(() => true, () => false)) unavailable();

    const certificateResult = await runDockerSandboxCandidateOwnedV4(config, {
      execution_id: `${executionPrefix}_openssl`,
      profile: 'VALIDATION_UNTRUSTED',
      argv: [
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
        '-keyout', '/scratch/key.pem', '-out', '/scratch/cert.pem', '-subj', '/CN=api.arliai.com',
        '-addext', 'subjectAltName=DNS:api.arliai.com',
      ],
      working_directory: '/capsule',
      environment: { HOME: '/tmp/home', TMPDIR: '/tmp' },
      mounts: [{ source: certificateDirectory, target: '/scratch', access: 'READ_WRITE' }],
      network: { mode: 'NONE' },
      timeout_ms: 15_000,
      max_output_bytes: 16_384,
    });
    if (certificateResult.exit_code !== 0 || certificateResult.timed_out) unavailable();
    const caPem = await readFile(join(certificateDirectory, 'cert.pem'), 'utf8');

    const internalNonce = randomBytes(16).toString('hex');
    internalNetworkId = await createCertificationNetworkV4(config, {
      execution_id: `${executionPrefix}_network`,
      image_id: config.image_id,
      internal: true,
      kind: 'internal',
      name: internalName,
      nonce: internalNonce,
    }, 0, (networkId) => { internalNetworkId = networkId; });
    const outboundNonce = randomBytes(16).toString('hex');
    outboundNetworkId = await createCertificationNetworkV4(config, {
      execution_id: `${executionPrefix}_network`,
      image_id: config.image_id,
      internal: false,
      kind: 'outbound',
      name: outboundName,
      nonce: outboundNonce,
      subnet: '93.184.216.0/24',
    }, 30_000, (networkId) => { outboundNetworkId = networkId; });
    upstream = await startCertificationTlsFixtureV4(
      config,
      outboundNetworkId,
      '93.184.216.10',
      certificateDirectory,
      runSuffix,
    );
    gateway = await startProviderEgressGatewayV4({
      docker_executable: config.docker_executable,
      broker_state_directory: config.broker_state_directory,
      image_id: config.image_id,
      execution_id: `${executionPrefix}_network`,
      internal_network: internalName,
      outbound_network: outboundName,
      outbound_address: '93.184.216.20',
      provider_origin: 'https://api.arliai.com',
      allowed_methods: ['POST'],
      allowed_paths: ['/v1/chat/completions'],
      real_api_key: syntheticCredential,
      ca_pem: caPem,
      startup_timeout_ms: 10_000,
    });
    let executorId = '';
    const executorResultPromise = runDockerSandboxCandidateOwnedV4(config, {
      execution_id: `${executionPrefix}_network`,
      profile: 'EXECUTOR_NETWORKED',
      argv: [
        'node', '/broker/certification/network-probe.mjs', gateway.gateway_base_url,
        'https://blocked.example', 'https://93.184.216.10', '1500',
      ],
      working_directory: '/capsule',
      environment: {
        HOME: '/tmp/home', TMPDIR: '/tmp',
        ARLIAI_API_KEY: gateway.non_secret_api_key_value,
        ARLIAI_BASE_URL: gateway.gateway_base_url,
      },
      mounts: [],
      network: { mode: 'INTERNAL', name: internalName },
      timeout_ms: 15_000,
      max_output_bytes: 64 * 1024,
    }, undefined, (controller) => {
      executorId = controller.container_id;
    });
    const executorDeadline = Date.now() + 5_000;
    while (executorId === '' && Date.now() < executorDeadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    if (executorId === '') unavailable();
    const [gatewayInspection, executorInspection] = await Promise.all([
      requiredDockerOutputV4(config, ['inspect', gateway.container_id]),
      requiredDockerOutputV4(config, ['inspect', executorId]),
    ]);
    if (gatewayInspection.includes(syntheticCredential)
      || executorInspection.includes(syntheticCredential)
      || (JSON.parse(gatewayInspection) as Array<{ Mounts?: unknown[] }>)[0]?.Mounts?.length !== 0) unavailable();
    const executorResult = await executorResultPromise;
    if (executorResult.exit_code !== 0 || executorResult.timed_out) unavailable();
    const gatewayEvidence = JSON.parse(executorResult.stdout) as {
      allowlisted?: { ok?: unknown; status?: unknown; body?: unknown };
      non_allowlisted?: { status?: unknown };
      direct_ip?: { ok?: unknown };
    };
    if (gatewayEvidence.allowlisted?.ok !== true
      || gatewayEvidence.allowlisted.status !== 200
      || typeof gatewayEvidence.allowlisted.body !== 'string'
      || (JSON.parse(gatewayEvidence.allowlisted.body) as { auth_hash?: unknown }).auth_hash
        !== createHash('sha256').update(`Bearer ${syntheticCredential}`).digest('hex')
      || gatewayEvidence.non_allowlisted?.status !== 403
      || gatewayEvidence.direct_ip?.ok !== false) unavailable();
    const outboundIngress = await requiredDockerOutputV4(config, [
      'exec', upstream.container_id, 'node', '-e',
      "fetch('http://93.184.216.20:8080/v1/chat/completions',{method:'POST',body:'{}',signal:AbortSignal.timeout(1500)}).then(()=>process.stdout.write('connected')).catch(()=>process.stdout.write('blocked'))",
    ], 4_096);
    if (outboundIngress !== 'blocked') unavailable();
    const gatewayLogs = await requiredDockerOutputV4(config, ['logs', gateway.container_id], 64 * 1024);
    if (/synthetic-arliai|authorization|request_body|response_body/i.test(gatewayLogs)
      || !gatewayLogs.includes('"decision":"ALLOW"')
      || !gatewayLogs.includes('"decision":"DENY"')) unavailable();

    const completedAt = new Date().toISOString();
    const artifacts = [
      transcriptArtifactV4('artifact_identity_0001', `${executionPrefix}_identity`, 'DOCKER_IDENTITY_RESULT', startedAt, completedAt, JSON.stringify(identity)),
      transcriptArtifactV4('artifact_process_0001', `${executionPrefix}_process`, 'HOSTILE_PROCESS_RESULT', startedAt, completedAt, JSON.stringify({ processResult, processEvidence })),
      transcriptArtifactV4('artifact_timeout_0001', `${executionPrefix}_timeout`, 'TIMEOUT_TREE_RESULT', startedAt, completedAt, JSON.stringify({ timeoutResult, survivor_absent: true })),
      transcriptArtifactV4('artifact_gateway_0001', `${executionPrefix}_network`, 'GATEWAY_NETWORK_RESULT', startedAt, completedAt, JSON.stringify({
        gatewayEvidence,
        outbound_ingress_blocked: true,
        gateway_inspection_hash: createHash('sha256').update(gatewayInspection).digest('hex'),
        executor_inspection_hash: createHash('sha256').update(executorInspection).digest('hex'),
        gateway_logs_hash: createHash('sha256').update(gatewayLogs).digest('hex'),
      })),
    ];
    const artifactByKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact.artifact_id]));
    return Object.freeze({
      run_id: `cert_run_${runSuffix}`,
      identity,
      started_at: startedAt,
      completed_at: completedAt,
      artifacts: Object.freeze(artifacts),
      observations: Object.freeze(REQUIRED_SANDBOX_EFFECTS_V4.map((effect) => Object.freeze({
        effect,
        passed: true as const,
        artifact_ids: Object.freeze([artifactByKind.get(effect === 'timeout_tree_killed'
          ? 'TIMEOUT_TREE_RESULT'
          : effect.startsWith('gateway_') || effect === 'direct_ip_blocked' || effect === 'metadata_only_logs'
            ? 'GATEWAY_NETWORK_RESULT'
            : 'HOSTILE_PROCESS_RESULT')!]),
      }))),
    });
  } catch {
    unavailable();
  } finally {
    const cleanups: Array<() => Promise<void>> = [];
    if (gateway !== null) cleanups.push(async () => await gateway!.revoke());
    if (upstream !== null) cleanups.push(async () => await upstream!.remove());
    if (internalNetworkId !== '') cleanups.push(async () => await removeCertificationNetworkV4(config, internalNetworkId));
    if (outboundNetworkId !== '') cleanups.push(async () => await removeCertificationNetworkV4(config, outboundNetworkId));
    cleanups.push(async () => await new Promise<void>((resolvePromise) => loopbackServer.close(() => resolvePromise())));
    cleanups.push(async () => await rm(root, { recursive: true, force: true }));
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        cleanupFailure = true;
      }
    }
    if (cleanupFailure) unavailable();
  }
  unavailable();
}

const unsupportedResult: SandboxProbeResultV4 = Object.freeze({
  status: 'UNSUPPORTED',
  failure: 'PROCESS_SANDBOX_UNAVAILABLE',
});

const hostileCertificationFlightsV4 = new Map<string, Promise<SandboxCertificationTranscriptV4>>();
const hostileCertificationEvidenceV4 = new Map<string, SandboxCertificationTranscriptV4>();

async function runSingleFlightHostileCertificationV4(
  config: DockerSandboxConfigV4,
  identity: SandboxCertificationIdentityV4,
  signal?: AbortSignal,
): Promise<SandboxCertificationTranscriptV4> {
  const key = hashCanonicalV4(identity);
  const cached = hostileCertificationEvidenceV4.get(key);
  if (cached !== undefined
    && new Date(cached.completed_at).getTime() + config.certification_ttl_seconds * 1_000 >= Date.now()) return cached;
  hostileCertificationEvidenceV4.delete(key);
  const existing = hostileCertificationFlightsV4.get(key);
  const awaitForCaller = async (flight: Promise<SandboxCertificationTranscriptV4>): Promise<SandboxCertificationTranscriptV4> => {
    if (signal === undefined) return await flight;
    if (signal.aborted) unavailable();
    return await new Promise((resolvePromise, reject) => {
      const aborted = () => {
        signal.removeEventListener('abort', aborted);
        reject(new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      void flight.then(
        (value) => { signal.removeEventListener('abort', aborted); resolvePromise(value); },
        (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error); },
      );
    });
  };
  if (existing !== undefined) return await awaitForCaller(existing);
  const flight = runDockerSandboxHostileCertificationV4(config, identity).then((transcript) => {
    hostileCertificationEvidenceV4.set(key, transcript);
    return transcript;
  });
  hostileCertificationFlightsV4.set(key, flight);
  void flight.finally(() => {
    if (hostileCertificationFlightsV4.get(key) === flight) hostileCertificationFlightsV4.delete(key);
  }).catch(() => undefined);
  return await awaitForCaller(flight);
}

export function createDockerProcessSandboxV4(
  config: DockerSandboxConfigV4,
): ProcessSandboxBackendV4 {
  validateDockerSandboxConfigV4(config);
  if (arguments.length !== 1) unavailable();
  interface IssuedCertificationV4 {
    readonly identity: SandboxCertificationIdentityV4;
    readonly evidence_hash: `sha256:${string}`;
    readonly certified_at: string;
    readonly expires_at: string;
    readonly certification_hash: `sha256:${string}`;
  }
  const issued = new WeakSet<object>();
  const cache = new Map<SandboxProfileV4, IssuedCertificationV4>();
  const issue = (identity: SandboxCertificationIdentityV4, transcript: SandboxCertificationTranscriptV4, now: string): IssuedCertificationV4 => {
    const evidence = validateSandboxCertificationTranscriptV4(
      transcript,
      identity,
      config.certification_ttl_seconds,
      now,
    );
    const record = Object.freeze({
      identity: Object.freeze({ ...identity }),
      evidence_hash: evidence.evidence_hash,
      certified_at: evidence.certified_at,
      expires_at: evidence.expires_at,
      certification_hash: `sha256:${hashCanonicalV4({
        certified_at: evidence.certified_at,
        evidence_hash: evidence.evidence_hash,
        expires_at: evidence.expires_at,
        identity,
      })}` as const,
    });
    issued.add(record);
    return record;
  };
  const matches = (
    certification: IssuedCertificationV4,
    identity: SandboxCertificationIdentityV4,
    now: string,
  ): boolean => {
    if (!issued.has(certification) || !/^sha256:[a-f0-9]{64}$/.test(certification.certification_hash)) return false;
    const checked = new Date(now);
    const certified = new Date(certification.certified_at);
    const expires = new Date(certification.expires_at);
    if (!Number.isFinite(checked.getTime())
      || checked.toISOString() !== now
      || !Number.isFinite(certified.getTime())
      || !Number.isFinite(expires.getTime())
      || checked.getTime() < certified.getTime()
      || checked.getTime() > expires.getTime()
      || expires.getTime() - certified.getTime() !== config.certification_ttl_seconds * 1_000
      || hashCanonicalV4(certification.identity) !== hashCanonicalV4(identity)) return false;
    return certification.certification_hash === `sha256:${hashCanonicalV4({
      certified_at: certification.certified_at,
      evidence_hash: certification.evidence_hash,
      expires_at: certification.expires_at,
      identity: certification.identity,
    })}`;
  };
  const executions = new Map<string, DockerExecutionLifecycleV4>();
  const probeOwned = async (profile: SandboxProfileV4, signal?: AbortSignal): Promise<SandboxProbeResultV4> => {
    try {
      const identity = await inspectDockerSandboxIdentityV4(config, profile, signal);
      const checkedAt = new Date().toISOString();
      let certification = cache.get(profile);
      if (certification === undefined || !matches(certification, identity, checkedAt)) {
        const transcript = await runSingleFlightHostileCertificationV4(config, identity, signal);
        const issuedAt = new Date().toISOString();
        certification = issue(identity, transcript, issuedAt);
        if (!matches(certification, identity, issuedAt)) return unsupportedResult;
        cache.set(profile, certification);
      }
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
  const probe = async (profile: SandboxProfileV4): Promise<SandboxProbeResultV4> => await probeOwned(profile);
  return Object.freeze({
    id: 'docker-engine-linux-v4',
    probe,
    run: async (request: SandboxRunRequestV4) => {
      if (executions.has(request.execution_id)) unavailable();
      const lifecycle = createDockerExecutionLifecycleV4();
      executions.set(request.execution_id, lifecycle);
      try {
        await cancellationCheckpointV4(lifecycle);
        const supported = await probeOwned(request.profile, lifecycle.abort_controller.signal);
        await cancellationCheckpointV4(lifecycle);
        if (supported.status !== 'SUPPORTED') unavailable();
        const result = await runDockerSandboxCandidateOwnedV4(config, request, lifecycle);
        await cancellationCheckpointV4(lifecycle);
        return result;
      } finally {
        lifecycle.settle();
        if (executions.get(request.execution_id) === lifecycle) executions.delete(request.execution_id);
      }
    },
    terminate: async (executionId: string) => {
      const lifecycle = executions.get(executionId);
      if (lifecycle === undefined) return;
      lifecycle.cancelled = true;
      lifecycle.abort_controller.abort();
      if (lifecycle.controller !== null) {
        try {
          await lifecycle.controller.remove();
        } catch (error) {
          lifecycle.cleanup_error = error;
        }
      }
      await lifecycle.settled;
      if (lifecycle.cleanup_error !== null) throw lifecycle.cleanup_error;
    },
  });
}
