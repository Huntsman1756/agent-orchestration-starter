import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

import { runBoundedProcessV4 } from './bounded-process.js';
import { dockerCliEnvironmentV4, registerOrReproveDockerLauncherV4 } from './docker-launcher.js';
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
  readonly broker_state_directory: string;
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

interface PendingContainerCreateV4 {
  readonly request: BrokerOwnedContainerCreateRequestV4;
  readonly name: string;
  readonly nonce: string;
  container_id: string | null;
  removal: DockerContainerRemovalControllerV4 | null;
  readonly record_path: string;
  readonly owner_pid: number;
}

const pendingCreates = new Map<string, PendingContainerCreateV4>();
const liveActiveCreates = new Set<string>();
const externallyActiveCreates = new Set<string>();

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

function transactionDirectory(request: BrokerOwnedContainerCreateRequestV4): string {
  return join(request.broker_state_directory, 'container-transactions-v4', launcherKey(request));
}

function launcherKey(request: BrokerOwnedContainerCreateRequestV4): string {
  return createHash('sha256').update(request.docker_executable).digest('hex');
}

function serializedPending(pending: PendingContainerCreateV4): string {
  return JSON.stringify({
    request: pending.request,
    name: pending.name,
    nonce: pending.nonce,
    container_id: pending.container_id,
    owner_pid: pending.owner_pid,
  });
}

async function persistPending(pending: PendingContainerCreateV4, exclusive = false): Promise<void> {
  await assertPhysicalTransactionDirectory(pending.request);
  const data = serializedPending(pending);
  if (exclusive) {
    await writeFile(pending.record_path, data, { encoding: 'utf8', flag: 'wx', flush: true });
    return;
  }
  const temporary = `${pending.record_path}.tmp-${randomBytes(16).toString('hex')}`;
  try {
    await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx', flush: true });
    await rename(temporary, pending.record_path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function clearPending(pending: PendingContainerCreateV4): Promise<void> {
  await assertPhysicalTransactionDirectory(pending.request);
  pendingCreates.delete(pending.nonce);
  liveActiveCreates.delete(pending.nonce);
  externallyActiveCreates.delete(pending.nonce);
  await rm(pending.record_path, { force: true });
}

async function assertPhysicalTransactionDirectory(request: BrokerOwnedContainerCreateRequestV4): Promise<void> {
  const directory = transactionDirectory(request);
  let current = directory;
  const root = parse(current).root;
  while (true) {
    const metadata = await lstat(current, { bigint: true }).catch(() => unavailable());
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev < 0n || metadata.ino <= 0n) unavailable();
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) unavailable();
    current = parent;
  }
}

async function loadDurablePending(request: BrokerOwnedContainerCreateRequestV4): Promise<void> {
  const directory = transactionDirectory(request);
  await mkdir(directory, { recursive: true });
  await assertPhysicalTransactionDirectory(request);
  for (const entry of await readdir(directory)) {
    if (!/^[a-f0-9]{32}\.json$/.test(entry)) unavailable();
    let value: {
      request?: BrokerOwnedContainerCreateRequestV4;
      name?: string;
      nonce?: string;
      container_id?: string | null;
      owner_pid?: number;
    };
    try { value = JSON.parse(await readFile(join(directory, entry), 'utf8')) as typeof value; } catch { unavailable(); }
    if (value.request?.docker_executable !== request.docker_executable
      || value.request.broker_state_directory !== request.broker_state_directory
      || value.nonce === undefined
      || entry !== `${value.nonce}.json`
      || !/^[a-f0-9]{32}$/.test(value.nonce)
      || typeof value.name !== 'string'
      || !/^ao-(executor|gateway|tls-fixture)-[a-f0-9]{32}$/.test(value.name)
      || !Number.isSafeInteger(value.owner_pid) || value.owner_pid! <= 0
      || (value.container_id !== null && value.container_id !== undefined
        && !/^[a-f0-9]{64}$/.test(value.container_id))) unavailable();
    const ownerPid = value.owner_pid!;
    const existing = pendingCreates.get(value.nonce);
    if (existing !== undefined) {
      if (existing.owner_pid !== ownerPid || existing.name !== value.name) unavailable();
      if (existing.container_id === null && value.container_id != null) {
        existing.container_id = value.container_id;
        existing.removal = removalController(request.docker_executable, value.container_id);
      } else if (existing.container_id !== (value.container_id ?? null)) unavailable();
      continue;
    }
    pendingCreates.set(value.nonce, {
      request: { ...value.request, signal: undefined },
      name: value.name,
      nonce: value.nonce,
      container_id: value.container_id ?? null,
      removal: value.container_id == null ? null : removalController(request.docker_executable, value.container_id),
      record_path: join(directory, entry),
      owner_pid: ownerPid,
    });
    if (ownerPid !== process.pid && processExists(ownerPid)) externallyActiveCreates.add(value.nonce);
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    environment: await dockerCliEnvironmentV4(executable, signal),
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
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await docker(request.docker_executable, ['container', 'inspect', containerId], 10_000, signal);
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
      && value.Config.Labels['agent-orchestration.launcher'] === launcherKey(request)
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

async function reconcilePendingCreate(pending: PendingContainerCreateV4): Promise<void> {
  let id = pending.container_id;
  if (id === null) {
    id = await recoverByNonce(pending.request, pending.name, pending.nonce, Date.now() + 8_000);
    if (id === null) {
      await clearPending(pending);
      return;
    }
    pending.container_id = id;
    pending.removal = removalController(pending.request.docker_executable, id);
    await persistPending(pending);
  }
  if (!await exactIdPresent(pending.request.docker_executable, id)) {
    await clearPending(pending);
    return;
  }
  if (!await inspectOwnedContainer(pending.request, id, pending.name, pending.nonce)) unavailable();
  await pending.removal!.remove();
  await clearPending(pending);
}

async function reconcilePendingCreates(executable: string): Promise<void> {
  for (const pending of pendingCreates.values()) {
    if (externallyActiveCreates.has(pending.nonce) && !processExists(pending.owner_pid)) {
      externallyActiveCreates.delete(pending.nonce);
    }
    if (pending.request.docker_executable === executable
      && !liveActiveCreates.has(pending.nonce)
      && !externallyActiveCreates.has(pending.nonce)) {
      await reconcilePendingCreate(pending);
    }
  }
}

async function rejectUnknownBrokerContainers(request: BrokerOwnedContainerCreateRequestV4): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    const listed = await docker(request.docker_executable, [
      'container', 'ls', '--all', '--no-trunc',
      `--filter=label=agent-orchestration.launcher=${launcherKey(request)}`, '--format', '{{.ID}}',
    ], 10_000);
    if (listed.terminated || listed.truncated || listed.exit_code !== 0) unavailable();
    const ids = listed.stdout.trim().split('\n').filter(Boolean);
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) unavailable();
    const authorized = new Set(
      [...pendingCreates.values()].flatMap((pending) => pending.container_id === null ? [] : [pending.container_id]),
    );
    if (ids.every((id) => authorized.has(id))) return;
    if (Date.now() >= deadline) unavailable();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    await loadDurablePending(request);
    await reconcilePendingCreates(request.docker_executable);
  } while (true);
}

export async function createBrokerOwnedDockerContainerV4(
  request: BrokerOwnedContainerCreateRequestV4,
): Promise<BrokerOwnedContainerV4> {
  await registerOrReproveDockerLauncherV4(
    request.docker_executable,
    request.signal,
    request.broker_state_directory,
  );
  await loadDurablePending(request);
  await reconcilePendingCreates(request.docker_executable);
  await rejectUnknownBrokerContainers(request);
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
    '--label', `agent-orchestration.launcher=${launcherKey(request)}`,
    '--label', `agent-orchestration.container-kind=${request.kind}`,
    ...request.create_arguments,
  ];
  const pending: PendingContainerCreateV4 = {
    request: { ...request, signal: undefined },
    name,
    nonce,
    container_id: null,
    removal: null,
    record_path: join(transactionDirectory(request), `${nonce}.json`),
    owner_pid: process.pid,
  };
  await mkdir(transactionDirectory(request), { recursive: true });
  await persistPending(pending, true);
  pendingCreates.set(nonce, pending);
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
  if (containerId !== null) {
    pending.container_id = containerId;
    pending.removal = removal;
    await persistPending(pending);
  }
  if (containerId === null) {
    containerId = await recoverByNonce(request, name, nonce, Date.now() + 8_000);
    removal = containerId === null ? null : removalController(request.docker_executable, containerId);
    if (containerId !== null) {
      pending.container_id = containerId;
      pending.removal = removal;
      await persistPending(pending);
    }
  }
  if (containerId === null || removal === null) {
    await clearPending(pending);
    unavailable();
  }

  try {
    if (!await inspectOwnedContainer(request, containerId, name, nonce, directAuthoritative ? request.signal : undefined)) unavailable();
    if (!directAuthoritative) {
      await removal.remove();
      await clearPending(pending);
      unavailable();
    }
    liveActiveCreates.add(nonce);
    const retainedRemoval: DockerContainerRemovalControllerV4 = Object.freeze({
      container_id: removal.container_id,
      remove: async () => {
        await removal.remove();
        await clearPending(pending);
      },
    });
    return Object.freeze({ container_id: containerId, container_name: name, nonce, removal: retainedRemoval });
  } catch {
    // Remove only after the immutable broker labels and image have been proved.
    if (await inspectOwnedContainer(request, containerId, name, nonce).catch(() => false)) {
      await removal.remove();
      await clearPending(pending);
    }
    unavailable();
  }
}
