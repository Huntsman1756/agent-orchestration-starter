import { randomBytes } from 'node:crypto';

import { runBoundedProcessV4 } from './bounded-process.js';
import { registerOrReproveDockerLauncherV4 } from './docker-launcher.js';
import {
  createDockerContainerRemovalControllerV4,
  type DockerContainerRemovalControllerV4,
} from './process-sandbox.js';

type ContainerKindV4 = 'executor' | 'gateway' | 'tls-fixture';

export interface BrokerOwnedContainerV4 {
  readonly container_id: string;
  readonly container_name: string;
  readonly nonce: string;
  readonly removal: DockerContainerRemovalControllerV4;
}

export interface BrokerOwnedContainerCreateRequestV4 {
  readonly docker_executable: string;
  readonly image_id: `sha256:${string}`;
  readonly execution_id: string;
  readonly kind: ContainerKindV4;
  /** Arguments after `docker create`; name and broker labels are injected here. */
  readonly create_arguments: readonly string[];
  readonly signal?: AbortSignal;
}

interface DockerResultV4 {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly terminated: boolean;
}

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TEMP', 'TMP'];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function docker(
  executable: string,
  argv: readonly string[],
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<DockerResultV4> {
  await registerOrReproveDockerLauncherV4(executable, signal);
  const result = await runBoundedProcessV4({
    executable,
    argv,
    environment: dockerEnvironment(),
    deadline_ms: deadlineMs,
    max_output_bytes: 256 * 1024,
    signal,
  });
  return {
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.stdout_truncated || result.stderr_truncated,
    terminated: result.termination !== null,
  };
}

async function exactIdPresent(executable: string, containerId: string): Promise<boolean> {
  const result = await docker(executable, [
    'container', 'ls', '--all', '--no-trunc', `--filter=id=${containerId}`, '--format', '{{.ID}}',
  ], 10_000);
  if (result.terminated || result.truncated || result.exit_code !== 0) unavailable();
  const output = result.stdout.trim();
  if (output === '') return false;
  if (output === containerId) return true;
  unavailable();
}

function removalController(executable: string, containerId: string): DockerContainerRemovalControllerV4 {
  return createDockerContainerRemovalControllerV4(containerId, {
    inspect_exact_id: async (id) => await exactIdPresent(executable, id),
    force_remove_exact_id: async (id) => {
      const result = await docker(executable, ['rm', '--force', id], 10_000);
      if (result.terminated || result.truncated || result.exit_code !== 0
        || result.stdout.trim() !== id || result.stderr !== '') unavailable();
    },
    poll_interval_ms: 25,
    absence_timeout_ms: 5_000,
  });
}

async function inspectOwnedContainer(
  request: BrokerOwnedContainerCreateRequestV4,
  containerId: string,
  name: string,
  nonce: string,
): Promise<boolean> {
  const result = await docker(request.docker_executable, ['container', 'inspect', containerId], 10_000, request.signal);
  if (result.terminated || result.truncated || result.exit_code !== 0) return false;
  try {
    const values = JSON.parse(result.stdout) as Array<{
      Id?: unknown;
      Name?: unknown;
      Config?: { Image?: unknown; Labels?: Record<string, string> };
    }>;
    const value = values[0];
    return values.length === 1
      && value?.Id === containerId
      && value.Name === `/${name}`
      && value.Config?.Image === request.image_id
      && value.Config.Labels?.['agent-orchestration.execution'] === request.execution_id
      && value.Config.Labels['agent-orchestration.nonce'] === nonce
      && value.Config.Labels['agent-orchestration.image'] === request.image_id
      && value.Config.Labels['agent-orchestration.container-kind'] === request.kind;
  } catch {
    return false;
  }
}

async function recoverByNonce(
  request: BrokerOwnedContainerCreateRequestV4,
  name: string,
  nonce: string,
  deadline: number,
): Promise<string | null> {
  do {
    const listed = await docker(request.docker_executable, [
      'container', 'ls', '--all', '--no-trunc',
      `--filter=label=agent-orchestration.nonce=${nonce}`,
      '--format', '{{.ID}}',
    ], 10_000).catch(() => unavailable());
    if (listed.terminated || listed.truncated || listed.exit_code !== 0) unavailable();
    const ids = listed.stdout.trim().split('\n').filter(Boolean);
    if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) unavailable();
    if (ids.length === 1) {
      const id = ids[0]!;
      if (!await inspectOwnedContainer(request, id, name, nonce)) unavailable();
      return id;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
}

export async function createBrokerOwnedDockerContainerV4(
  request: BrokerOwnedContainerCreateRequestV4,
): Promise<BrokerOwnedContainerV4> {
  if (!/^sha256:[a-f0-9]{64}$/.test(request.image_id)
    || !/^exec_[a-z0-9_-]{8,96}$/.test(request.execution_id)
    || request.create_arguments.some((arg) => arg === 'create' || arg.startsWith('--name')
      || arg.startsWith('--label') || arg.startsWith('-l'))) unavailable();
  const nonce = randomBytes(16).toString('hex');
  const name = `ao-${request.kind}-${randomBytes(16).toString('hex')}`;
  const argv = [
    'create', `--name=${name}`,
    '--label', `agent-orchestration.execution=${request.execution_id}`,
    '--label', `agent-orchestration.nonce=${nonce}`,
    '--label', `agent-orchestration.image=${request.image_id}`,
    '--label', `agent-orchestration.container-kind=${request.kind}`,
    ...request.create_arguments,
  ];
  let result: DockerResultV4 | null = null;
  try {
    result = await docker(request.docker_executable, argv, 15_000, request.signal);
  } catch {
    // A deadline or cancellation can race a successful daemon-side create.
  }

  const directId = result?.stdout.trim() ?? '';
  const directAuthoritative = result !== null
    && !result.terminated
    && !result.truncated
    && result.exit_code === 0
    && /^[a-f0-9]{64}$/.test(directId);
  let containerId: string | null = directAuthoritative ? directId : null;
  let removal = containerId === null ? null : removalController(request.docker_executable, containerId);
  if (containerId === null) {
    containerId = await recoverByNonce(request, name, nonce, Date.now() + 2_000);
    removal = containerId === null ? null : removalController(request.docker_executable, containerId);
  }
  if (containerId === null || removal === null) unavailable();

  try {
    if (!await inspectOwnedContainer(request, containerId, name, nonce)) unavailable();
    if (!directAuthoritative) {
      await removal.remove();
      unavailable();
    }
    return Object.freeze({ container_id: containerId, container_name: name, nonce, removal });
  } catch {
    // Remove only after the immutable broker labels and image have been proved.
    if (await inspectOwnedContainer(request, containerId, name, nonce).catch(() => false)) await removal.remove();
    unavailable();
  }
}
