import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { createConnection, createServer, Server, type Socket } from 'node:net';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { BrokerDaemonV4, BrokerReplyV4 } from './broker-daemon.js';
import { RUNTIME_FAILURE_CODES_V4, type RuntimeFailureCodeV4 } from './failures.js';
import type { ReclamationCoordinatorV4 } from './repository-lock.js';
import { loadRuntimeResultV4, loadRuntimeTaskRequestV4 } from './load.js';
import type { BrokerCommandV4 } from './run-state.js';

const MAX_FRAME_BYTES_V4 = 1_048_576;
const TOKEN_FILE_V4 = 'broker.token';
const MAX_LINUX_BROKER_QUARANTINES_V4 = 64;
const SERVER_CLOSE_DEADLINE_MS_V4 = 250;
const LINUX_BINDER_EXIT_DEADLINE_MS_V4 = 250;
const BROKER_REPLY_STATES_V4 = new Set([
  'READY_FOR_EXECUTOR',
  'EXECUTION_STARTED',
  'AWAITING_REINSPECTION',
  'FAILED',
  'ABORTED',
  'FINALIZED',
]);

export interface BrokerIpcRequestV4 {
  token: string;
  command: BrokerCommandV4;
}

export interface BrokerIpcResponseV4 {
  ok: boolean;
  reply?: BrokerReplyV4;
  error?: string;
}

export interface BrokerIpcDependenciesV4 {
  daemon: BrokerDaemonV4;
  stateDirectory: string;
  endpoint?: string;
  platform?: NodeJS.Platform;
  platformVerifier?: BrokerIpcPlatformVerifierV4;
  requestDeadlineMs?: number;
  loadToken?: (directory: string, platform: NodeJS.Platform) => Promise<string>;
  closeServer?: (server: Server) => Promise<void>;
  endpointCoordinator: ReclamationCoordinatorV4;
  allowInProcessCoordinatorForTests?: boolean;
  unixPhysicalPathBackend?: UnixPhysicalPathBackendV4;
  allowInProcessPhysicalPathBackendForTests?: boolean;
  unixQuarantineLimitForTests?: number;
  afterLinuxListenerReceivedForTests?(): Promise<void>;
  afterLinuxQuarantineReservationForTests?(): Promise<void>;
}

export interface BrokerIpcPlatformVerifierV4 {
  verifyOwnerOnlyPath(input: { path: string; kind: 'state-directory' | 'token-file' | 'endpoint'; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
  verifyPeer(input: { socket?: Socket; endpoint: string; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
}

export type UnixPhysicalPathComponentKindV4 = 'directory' | 'symbolic-link' | 'reparse-alias' | 'other' | 'unknown';

export interface UnixPhysicalPathComponentV4 {
  kind: UnixPhysicalPathComponentKindV4;
  object_identity: string | null;
  owner_identity: string | null;
  owner_trusted: boolean;
  writable_by_untrusted: boolean;
  owner_only: boolean;
}

export interface UnixPhysicalPathInspectionV4 {
  operation_path: string;
  chain_complete: boolean;
  components: readonly UnixPhysicalPathComponentV4[];
}

export interface UnixOwnedEndpointCleanupDependenciesV4 {
  metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>;
  rename?(from: string, to: string): Promise<void>;
  remove(endpoint: string): Promise<void>;
  restoreQuarantine?(from: string, endpoint: string): Promise<void>;
  afterMetadataForTests?(): Promise<void>;
}

export interface UnixBrokerListenerBindingV4 {
  readonly kind: 'unix-broker-listener-binding';
  readonly server: Server;
  release(): Promise<void>;
}

export interface UnixPhysicalDirectoryCapabilityV4 {
  readonly inspection: UnixPhysicalPathInspectionV4;
  loadToken(input: { platform: NodeJS.Platform; loadToken?: (directory: string, platform: NodeJS.Platform) => Promise<string> }): Promise<string>;
  verifyOwnerOnlyPath(input: {
    kind: 'state-directory' | 'token-file';
    expected_owner_identity: string;
    verifier: BrokerIpcPlatformVerifierV4;
  }): Promise<{ owner_identity: string } | null>;
  reclaimBrokerSocket(expectedOwnerIdentity: string, quarantineLimit?: number): Promise<void>;
  listenBrokerSocket(server: Server, quarantineLimit?: number, afterListenerReceivedForTests?: () => Promise<void>): Promise<UnixBrokerListenerBindingV4>;
  publishBrokerSocket(input: {
    binding: UnixBrokerListenerBindingV4;
    expected_owner_identity: string;
    verifier: BrokerIpcPlatformVerifierV4;
  }, quarantineLimit?: number): Promise<string>;
  withConnectedBrokerSocket<T>(
    connect: ((endpoint: string) => Socket) | undefined,
    operation: (socket: Socket) => Promise<T>,
  ): Promise<T>;
  removeOwnedBrokerSocket(ownedObjectIdentity: string, testDependencies?: UnixOwnedEndpointCleanupDependenciesV4, quarantineLimit?: number, afterReservationForTests?: () => Promise<void>): Promise<void>;
}

/**
 * Trusted Unix boundary. A native implementation must walk every existing
 * component with no-follow metadata and keep the proven physical directory
 * binding valid for the complete callback. If it cannot bind that identity
 * across the callback's syscall, it must reject instead of invoking it.
 */
export interface UnixPhysicalPathBackendV4 {
  certification: { kind: 'native-physical-path' | 'in-process-test'; identity: string };
  certifyStateDirectory(input: { state_directory: string; expected_owner_identity: string }): Promise<UnixPhysicalPathInspectionV4>;
  withReprovedStateDirectory<T>(
    input: { operation_path: string; expected_owner_identity: string; component_identities: readonly string[] },
    operation: (capability: UnixPhysicalDirectoryCapabilityV4) => Promise<T>,
  ): Promise<T>;
}

export interface UnixPhysicalPathSecurityV4 {
  stateDirectory: string;
  expectedOwnerIdentity: string;
  unixPhysicalPathBackend: UnixPhysicalPathBackendV4;
  allowInProcessPhysicalPathBackendForTests?: boolean;
  allowInProcessCoordinatorForTests?: boolean;
}

export interface UnixSocketMetadataV4 { kind: 'socket' | 'other'; owner_identity: string; owner_only: boolean; object_identity: string }
export interface UnixSocketReclaimDependenciesV4 {
  metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>;
  probe(endpoint: string): Promise<'live' | 'stale' | 'unknown'>;
  rename(from: string, to: string): Promise<void>;
  removeQuarantine(path: string): Promise<void>;
  restoreQuarantine(from: string, endpoint: string): Promise<void>;
}

export interface BrokerIpcServerV4 {
  endpoint: string;
  close(): Promise<void>;
  exchangeFrameForTest(payload: Buffer): Promise<BrokerIpcResponseV4>;
}

export interface BrokerIpcClientConfigV4 {
  endpoint: string;
  stateDirectory?: string;
  token: string;
  requestDeadlineMs?: number;
  platform?: NodeJS.Platform;
  serverIdentityVerifier?: BrokerIpcServerIdentityVerifierV4;
  connect?: (endpoint: string) => Socket;
  endpointCoordinator?: ReclamationCoordinatorV4;
  allowInProcessCoordinatorForTests?: boolean;
  unixPhysicalPathBackend?: UnixPhysicalPathBackendV4;
  allowInProcessPhysicalPathBackendForTests?: boolean;
}

export interface BrokerIpcServerIdentityVerifierV4 {
  verifyServer(input: { socket: Socket; endpoint: string; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
}

export interface BrokerIpcClientV4 {
  submit(command: BrokerCommandV4): Promise<BrokerReplyV4>;
  close(): Promise<void>;
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
}

function callAdapter<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}

function userIdentityHash(): string {
  const info = userInfo();
  const identity = `${info.username}\0${info.uid}\0${info.homedir || homedir()}`;
  return createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
}

function platformOwnerIdentity(platform: NodeJS.Platform): string {
  if (platform !== 'win32' && typeof process.getuid === 'function') return `uid:${process.getuid()}`;
  return `user:${userIdentityHash()}`;
}

export function defaultBrokerEndpointV4(stateDirectory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\agent-orchestration-${userIdentityHash()}`
    : join(stateDirectory, 'broker.sock');
}

function canonicalWindowsNamedPipeEndpointV4(endpoint: string): string {
  const normalized = win32.normalize(endpoint);
  const canonical = normalized.toLowerCase();
  const prefix = '\\\\.\\pipe\\';
  if (endpoint.includes('\0') || !canonical.startsWith(prefix) || canonical.length === prefix.length) {
    throw new Error('AUTHENTICATION_FAILED: broker named-pipe endpoint is invalid');
  }
  return canonical;
}

function loadBrokerIpcLocationV4(
  stateDirectory: string,
  configuredEndpoint: string | undefined,
  platform: NodeJS.Platform,
  certifiedUnixOperationPath?: string,
): { stateDirectory: string; endpoint: string } {
  if (platform === 'win32') {
    const canonicalStateDirectory = resolve(stateDirectory);
    const requestedEndpoint = configuredEndpoint ?? defaultBrokerEndpointV4(canonicalStateDirectory, platform);
    return { stateDirectory: canonicalStateDirectory, endpoint: canonicalWindowsNamedPipeEndpointV4(requestedEndpoint) };
  }
  const requestedStateDirectory = posix.resolve(stateDirectory);
  const requestedEndpoint = posix.resolve(configuredEndpoint ?? posix.join(requestedStateDirectory, 'broker.sock'));
  const relativeEndpoint = posix.relative(requestedStateDirectory, requestedEndpoint);
  if (relativeEndpoint !== 'broker.sock') {
    throw new Error('AUTHENTICATION_FAILED: Unix socket must be the direct broker.sock state child');
  }
  const operationStateDirectory = certifiedUnixOperationPath ?? requestedStateDirectory;
  return { stateDirectory: operationStateDirectory, endpoint: posix.join(operationStateDirectory, relativeEndpoint) };
}

interface CertifiedUnixPhysicalPathV4 {
  display_path: string;
  operation_path: string;
  expected_owner_identity: string;
  component_identities: readonly string[];
  coordinator_key: string;
}

interface UnixPhysicalCriticalSectionV4 {
  runSensitive<T>(operation: (capability: UnixPhysicalDirectoryCapabilityV4) => Promise<T>): Promise<T>;
}

function physicalPathRejected(): never {
  throw new Error('AUTHENTICATION_FAILED: Unix physical state path verification failed');
}

function loadLinuxQuarantineLimitV4(value: number | undefined, allowTestOverride: boolean | undefined): number {
  if (value === undefined) return MAX_LINUX_BROKER_QUARANTINES_V4;
  if (
    allowTestOverride !== true
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_LINUX_BROKER_QUARANTINES_V4
  ) throw new Error('AUTHENTICATION_FAILED: Linux quarantine limit override is invalid');
  return value;
}

function loadUnixPhysicalInspectionV4(inspection: UnixPhysicalPathInspectionV4, expectedOwnerIdentity: string): UnixPhysicalPathInspectionV4 {
  if (inspection === null || typeof inspection !== 'object' || inspection.chain_complete !== true || !posix.isAbsolute(inspection.operation_path) || inspection.operation_path.includes('\0')) {
    physicalPathRejected();
  }
  if (!Array.isArray(inspection.components) || inspection.components.length === 0) physicalPathRejected();
  const identities = new Set<string>();
  for (const component of inspection.components) {
    if (component === null || typeof component !== 'object' || component.kind !== 'directory') physicalPathRejected();
    if (typeof component.object_identity !== 'string' || component.object_identity.length < 1 || component.object_identity.length > 256 || /[\0\r\n]/.test(component.object_identity)) physicalPathRejected();
    if (identities.has(component.object_identity)) physicalPathRejected();
    identities.add(component.object_identity);
    if (typeof component.owner_identity !== 'string' || component.owner_identity.length < 1 || component.owner_identity.length > 256 || /[\0\r\n]/.test(component.owner_identity)) physicalPathRejected();
    if (component.owner_trusted !== true || component.writable_by_untrusted !== false) physicalPathRejected();
  }
  const stateDirectory = inspection.components.at(-1)!;
  if (stateDirectory.owner_identity !== expectedOwnerIdentity || stateDirectory.owner_only !== true) physicalPathRejected();
  return Object.freeze({
    operation_path: inspection.operation_path,
    chain_complete: true,
    components: Object.freeze(inspection.components.map((component) => Object.freeze({ ...component }))),
  });
}

const linuxNativePhysicalBackendBrandV4 = new WeakSet<object>();
const linuxNativeListenerBindingBrandV4 = new WeakSet<object>();

function linuxObjectIdentityV4(metadata: { dev: bigint; ino: bigint }): string {
  return `linux:dev:${metadata.dev.toString()}:ino:${metadata.ino.toString()}`;
}

function linuxOwnerIdentityV4(uid: bigint): string {
  return `uid:${uid.toString()}`;
}

interface TrackedServerConnectionsV4 {
  closing: boolean;
  readonly sockets: Set<Socket>;
  readonly listener: (socket: Socket) => void;
}

const trackedServerConnectionsV4 = new WeakMap<Server, TrackedServerConnectionsV4>();

function trackServerConnectionsV4(server: Server): TrackedServerConnectionsV4 {
  const existing = trackedServerConnectionsV4.get(server);
  if (existing !== undefined) return existing;
  const sockets = new Set<Socket>();
  const state: TrackedServerConnectionsV4 = {
    closing: false,
    sockets,
    listener: (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (state.closing) socket.destroy();
    },
  };
  trackedServerConnectionsV4.set(server, state);
  server.prependListener('connection', state.listener);
  return state;
}

function destroyTrackedServerConnectionsV4(server: Server, state: TrackedServerConnectionsV4): void {
  for (const socket of state.sockets) socket.destroy();
  (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
}

async function closeServerHandleV4(server: Server): Promise<void> {
  const state = trackServerConnectionsV4(server);
  state.closing = true;
  if (!server.listening) {
    destroyTrackedServerConnectionsV4(server, state);
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolveClose();
      else rejectClose(error);
    };
    const timeout = setTimeout(() => {
      destroyTrackedServerConnectionsV4(server, state);
      finish(new Error('UNKNOWN_FAILURE: local IPC close deadline exceeded'));
    }, SERVER_CLOSE_DEADLINE_MS_V4);
    try {
      server.close((error) => finish(error));
      destroyTrackedServerConnectionsV4(server, state);
    } catch (error) {
      destroyTrackedServerConnectionsV4(server, state);
      finish(error as Error);
    }
  });
}

// A libuv Pipe remembers its bind pathname and pathname-unlinks it on close.
// The short-lived binder transfers the listening fd over SCM_RIGHTS and then
// kills itself without libuv cleanup; the receiver therefore owns a listener
// handle with no pathname cleanup authority.
const LINUX_LISTENER_BINDER_SCRIPT_V4 = String.raw`
const { lstatSync } = require('node:fs');
const { createServer } = require('node:net');
const die = () => process.kill(process.pid, 'SIGKILL');
process.umask(0o177);
const endpoint = '/proc/self/fd/4/broker.sock';
const server = createServer((socket) => socket.destroy());
server.once('error', () => {
  if (!process.connected) die();
  process.send({ kind: 'error' }, () => die());
});
server.listen(endpoint, () => {
  const metadata = lstatSync(endpoint, { bigint: true });
  process.send({
    kind: 'bound',
    object_identity: 'linux:dev:' + metadata.dev.toString() + ':ino:' + metadata.ino.toString(),
    owner_identity: 'uid:' + metadata.uid.toString(),
    owner_only: (metadata.mode & 0o077n) === 0n,
  }, server, { keepOpen: true }, (error) => {
    if (error) die();
  });
});
process.once('message', (message) => {
  if (message && message.kind === 'terminate-without-cleanup') die();
});
process.once('disconnect', die);
setTimeout(die, 10_000);
`;

interface LinuxAdoptedListenerV4 {
  server: Server;
  objectIdentity: string;
}

interface LinuxBinderExitV4 {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForLinuxBinderExitV4(child: ChildProcess, deadlineMs: number): Promise<LinuxBinderExitV4 | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  if (child.pid === undefined) return Promise.resolve({ code: null, signal: null });
  return new Promise((resolveExit) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(null);
    }, deadlineMs);
    child.once('exit', onExit);
  });
}

function killLinuxBinderV4(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try { child.kill('SIGKILL'); } catch { /* the bounded exit wait below remains authoritative */ }
}

async function terminateLinuxBinderV4(child: ChildProcess, requestPathlessShutdown: boolean): Promise<LinuxBinderExitV4> {
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    if (requestPathlessShutdown) {
      await new Promise<void>((resolveSend, rejectSend) => {
        try {
          child.send({ kind: 'terminate-without-cleanup' }, (error) => error === null ? resolveSend() : rejectSend(error));
        } catch (error) {
          rejectSend(error);
        }
      }).catch(() => killLinuxBinderV4(child));
    } else {
      killLinuxBinderV4(child);
    }
  }
  let exited = await waitForLinuxBinderExitV4(child, LINUX_BINDER_EXIT_DEADLINE_MS_V4);
  if (exited === null) {
    killLinuxBinderV4(child);
    exited = await waitForLinuxBinderExitV4(child, LINUX_BINDER_EXIT_DEADLINE_MS_V4);
  }
  if (exited === null) throw new Error('AUTHENTICATION_FAILED: native Linux listener binder did not exit');
  return exited;
}

async function waitForLinuxBinderCloseV4(closed: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const completed = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), LINUX_BINDER_EXIT_DEADLINE_MS_V4);
    }),
  ]);
  if (timeout !== null) clearTimeout(timeout);
  if (!completed) throw new Error('AUTHENTICATION_FAILED: native Linux listener binder handle did not close');
}

function receiveLinuxBinderListenerV4<T>(child: ChildProcess, prepare: (message: unknown, handle: unknown) => T): Promise<T> {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => finish(new Error('native Linux listener binder timed out')), 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (error: Error | null, prepared?: T) => {
      cleanup();
      if (error !== null) rejectMessage(error);
      else resolveMessage(prepared!);
    };
    const onMessage = (message: unknown, handle: unknown) => {
      try { finish(null, prepare(message, handle)); }
      catch (error) { finish(error as Error); }
    };
    const onError = () => finish(new Error('native Linux listener binder failed'));
    const onExit = () => finish(new Error('native Linux listener binder exited early'));
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function adoptPathlessLinuxListenerV4(
  directoryFd: number,
  sourceServer: Server,
  afterListenerReceivedForTests?: () => Promise<void>,
): Promise<LinuxAdoptedListenerV4> {
  const child = spawn(process.execPath, ['-e', LINUX_LISTENER_BINDER_SCRIPT_V4], {
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', directoryFd],
  });
  let childLifecycleError: Error | null = null;
  const onChildLifecycleError = (error: Error) => { childLifecycleError = error; };
  child.on('error', onChildLifecycleError);
  const childClosed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()));
  let adoptedServer: Server | null = null;
  try {
    const received = await receiveLinuxBinderListenerV4(child, (message, handle): LinuxAdoptedListenerV4 => {
      const candidate = message as Record<string, unknown> | null;
      if (
        candidate === null
        || typeof candidate !== 'object'
        || candidate.kind !== 'bound'
        || typeof candidate.object_identity !== 'string'
        || !/^linux:dev:[0-9]+:ino:[0-9]+$/.test(candidate.object_identity)
        || candidate.owner_identity !== linuxOwnerIdentityV4(BigInt(process.getuid!()))
        || candidate.owner_only !== true
        || !(handle instanceof Server)
        || !handle.listening
      ) throw new Error('native Linux listener binder response was invalid');
      adoptedServer = handle;
      trackServerConnectionsV4(handle);
      const sourceTracking = trackedServerConnectionsV4.get(sourceServer);
      for (const listener of sourceServer.listeners('connection') as Array<(socket: Socket) => void>) {
        if (listener !== sourceTracking?.listener) handle.on('connection', listener);
      }
      return { server: handle, objectIdentity: candidate.object_identity };
    });
    if (afterListenerReceivedForTests !== undefined) await afterListenerReceivedForTests();
    const binderExit = await terminateLinuxBinderV4(child, true);
    if (binderExit.signal !== 'SIGKILL') throw new Error('native Linux listener binder exit was invalid');
    await waitForLinuxBinderCloseV4(childClosed);
    if (childLifecycleError !== null) throw childLifecycleError;
    child.off('error', onChildLifecycleError);
    return received;
  } catch {
    await terminateLinuxBinderV4(child, false).catch(() => undefined);
    await waitForLinuxBinderCloseV4(childClosed).catch(() => undefined);
    child.off('error', onChildLifecycleError);
    await (adoptedServer === null ? Promise.resolve() : closeServerHandleV4(adoptedServer).catch(() => undefined));
    throw new Error('AUTHENTICATION_FAILED: native Linux listener adoption failed');
  }
}

async function openLinuxPhysicalStateDirectoryV4(input: {
  state_directory: string;
  expected_owner_identity: string;
}): Promise<{ handle: FileHandle; inspection: UnixPhysicalPathInspectionV4 }> {
  if (process.platform !== 'linux' || !/^uid:[0-9]+$/.test(input.expected_owner_identity)) physicalPathRejected();
  const operationPath = posix.resolve(input.state_directory);
  if (!posix.isAbsolute(operationPath) || operationPath.includes('\0')) physicalPathRejected();
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  let current: FileHandle | null = null;
  const components: UnixPhysicalPathComponentV4[] = [];
  const inspectHandle = async (handle: FileHandle): Promise<void> => {
    const metadata = await handle.stat({ bigint: true });
    const ownerIdentity = linuxOwnerIdentityV4(metadata.uid);
    components.push({
      kind: metadata.isDirectory() ? 'directory' : 'other',
      object_identity: linuxObjectIdentityV4(metadata),
      owner_identity: ownerIdentity,
      owner_trusted: ownerIdentity === 'uid:0' || ownerIdentity === input.expected_owner_identity,
      writable_by_untrusted: (metadata.mode & 0o022n) !== 0n,
      owner_only: (metadata.mode & 0o077n) === 0n,
    });
  };
  try {
    current = await open('/', flags);
    await inspectHandle(current);
    for (const segment of operationPath.split('/').filter((entry) => entry.length > 0)) {
      if (segment === '.' || segment === '..' || segment.includes('\0')) physicalPathRejected();
      const next = await open(`/proc/self/fd/${current.fd}/${segment}`, flags);
      await current.close();
      current = next;
      await inspectHandle(current);
    }
    return {
      handle: current,
      inspection: {
        operation_path: operationPath,
        chain_complete: true,
        components,
      },
    };
  } catch (error) {
    await current?.close().catch(() => undefined);
    throw error;
  }
}

class LinuxNativeBrokerListenerBindingV4 implements UnixBrokerListenerBindingV4 {
  readonly kind = 'unix-broker-listener-binding' as const;
  readonly directoryIdentity: string;
  readonly endpointIdentity: string;
  readonly handle: FileHandle;
  readonly server: Server;
  #released = false;

  constructor(handle: FileHandle, directoryIdentity: string, endpointIdentity: string, server: Server) {
    this.handle = handle;
    this.directoryIdentity = directoryIdentity;
    this.endpointIdentity = endpointIdentity;
    this.server = server;
    linuxNativeListenerBindingBrandV4.add(this);
  }

  get released(): boolean { return this.#released; }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.handle.close();
  }
}

interface LinuxQuarantineReservationV4 {
  readonly name: string;
  readonly handle: FileHandle;
  readonly directoryIdentity: string;
}

class LinuxNativePhysicalDirectoryCapabilityV4 implements UnixPhysicalDirectoryCapabilityV4 {
  readonly inspection: UnixPhysicalPathInspectionV4;
  readonly #handle: FileHandle;
  readonly #expectedOwnerIdentity: string;
  #transferred = false;
  #closed = false;

  constructor(handle: FileHandle, inspection: UnixPhysicalPathInspectionV4, expectedOwnerIdentity: string) {
    this.#handle = handle;
    this.inspection = inspection;
    this.#expectedOwnerIdentity = expectedOwnerIdentity;
  }

  async closeUnlessTransferred(): Promise<void> {
    if (this.#closed || this.#transferred) return;
    this.#closed = true;
    await this.#handle.close();
  }

  #statePath(): string {
    if (this.#closed || this.#transferred) physicalPathRejected();
    return `/proc/self/fd/${this.#handle.fd}`;
  }

  #childPath(name: string): string {
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(name) || name === '.' || name === '..') physicalPathRejected();
    return `${this.#statePath()}/${name}`;
  }

  async #metadataAtPath(path: string): Promise<UnixSocketMetadataV4 | null> {
    const metadata = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata === null) return null;
    return {
      kind: metadata.isSocket() ? 'socket' : 'other',
      owner_identity: linuxOwnerIdentityV4(metadata.uid),
      owner_only: (metadata.mode & 0o077n) === 0n,
      object_identity: linuxObjectIdentityV4(metadata),
    };
  }

  #metadata(name: string): Promise<UnixSocketMetadataV4 | null> {
    return this.#metadataAtPath(this.#childPath(name));
  }

  async #syncDirectory(): Promise<void> {
    await this.#handle.sync();
  }

  #reservationPath(reservation: LinuxQuarantineReservationV4): string {
    return `/proc/self/fd/${reservation.handle.fd}`;
  }

  async #validatedQuarantineCount(
    endpointIdentity: string | null,
    expectedReservation?: LinuxQuarantineReservationV4,
  ): Promise<number> {
    const readNames = async () => (await readdir(this.#statePath()))
      .filter((name) => name.startsWith('.broker.sock.quarantine-'))
      .sort();
    const names = await readNames();
    const socketIdentities = new Set<string>();
    let expectedReservationFound = false;
    const validateSocket = (metadata: BigIntStats): string => {
      const identity = linuxObjectIdentityV4(metadata);
      if (
        !metadata.isSocket()
        || linuxOwnerIdentityV4(metadata.uid) !== this.#expectedOwnerIdentity
        || (metadata.mode & 0o077n) !== 0n
        || identity === endpointIdentity
        || socketIdentities.has(identity)
      ) physicalPathRejected();
      socketIdentities.add(identity);
      return identity;
    };
    for (const name of names) {
      if (!/^\.broker\.sock\.quarantine-[1-9][0-9]*-[a-f0-9]{32}$/.test(name)) physicalPathRejected();
      const path = this.#childPath(name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSocket()) {
        validateSocket(metadata);
        if (expectedReservation?.name === name) physicalPathRejected();
        continue;
      }
      if (!metadata.isDirectory()) physicalPathRejected();
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try {
        const bound = await handle.stat({ bigint: true });
        const boundIdentity = linuxObjectIdentityV4(bound);
        if (
          !bound.isDirectory()
          || linuxOwnerIdentityV4(bound.uid) !== this.#expectedOwnerIdentity
          || (bound.mode & 0o077n) !== 0n
          || boundIdentity !== `linux:dev:${metadata.dev}:ino:${metadata.ino}`
        ) physicalPathRejected();
        const contents = (await readdir(`/proc/self/fd/${handle.fd}`)).sort();
        if (contents.length > 1 || contents.length === 1 && contents[0] !== 'broker.sock') physicalPathRejected();
        if (contents.length === 1) validateSocket(await lstat(`/proc/self/fd/${handle.fd}/broker.sock`, { bigint: true }));
        const rebound = await lstat(path, { bigint: true });
        if (!rebound.isDirectory() || linuxObjectIdentityV4(rebound) !== boundIdentity) physicalPathRejected();
        if (expectedReservation?.name === name) {
          if (boundIdentity !== expectedReservation.directoryIdentity || contents.length !== 0) physicalPathRejected();
          expectedReservationFound = true;
        }
      } finally {
        await handle.close();
      }
    }
    if (!expectedReservationFound && expectedReservation !== undefined) physicalPathRejected();
    if ((await readNames()).join('\0') !== names.join('\0')) physicalPathRejected();
    return names.length;
  }

  async #assertQuarantineCapacity(quarantineLimit: number, requiredSlots: number, endpointIdentity: string | null): Promise<void> {
    const count = await this.#validatedQuarantineCount(endpointIdentity);
    if (count + requiredSlots > quarantineLimit) {
      throw new Error('REPOSITORY_BUSY: broker quarantine capacity exhausted');
    }
  }

  async #reserveQuarantineSlot(
    endpointIdentity: string,
    quarantineLimit: number,
    reserveSlotsAfter: number,
  ): Promise<LinuxQuarantineReservationV4> {
    await this.#assertQuarantineCapacity(quarantineLimit, 1 + reserveSlotsAfter, endpointIdentity);
    let name = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      name = `.broker.sock.quarantine-${process.pid}-${randomBytes(16).toString('hex')}`;
      const created = await mkdir(this.#childPath(name), { mode: 0o700 }).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'EEXIST') return false;
          throw error;
        },
      );
      if (created) break;
      name = '';
    }
    if (name.length === 0) throw new Error('REPOSITORY_BUSY: broker quarantine reservation failed');
    await this.#syncDirectory();
    const handle = await open(this.#childPath(name), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat({ bigint: true });
      const directoryIdentity = linuxObjectIdentityV4(metadata);
      const linked = await lstat(this.#childPath(name), { bigint: true });
      if (
        !metadata.isDirectory()
        || linuxOwnerIdentityV4(metadata.uid) !== this.#expectedOwnerIdentity
        || (metadata.mode & 0o077n) !== 0n
        || !linked.isDirectory()
        || linuxObjectIdentityV4(linked) !== directoryIdentity
        || (await readdir(`/proc/self/fd/${handle.fd}`)).length !== 0
      ) physicalPathRejected();
      return { name, handle, directoryIdentity };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #restoreWithoutOverwrite(reservation: LinuxQuarantineReservationV4): Promise<void> {
    try {
      // Keep the quarantine link: Node has no identity-conditional unlink, so
      // deleting this pathname after a separate metadata read is unsafe.
      await link(`${this.#reservationPath(reservation)}/broker.sock`, this.#childPath('broker.sock'));
      await this.#syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw new Error('REPOSITORY_BUSY: quarantined broker endpoint was preserved');
    }
  }

  async #quarantineOwnedEndpoint(
    expectedIdentity: string,
    afterMetadataForTests?: () => Promise<void>,
    quarantineLimit = MAX_LINUX_BROKER_QUARANTINES_V4,
    reserveSlotsAfter = 0,
    afterReservationForTests?: () => Promise<void>,
  ): Promise<'absent' | 'removed'> {
    const current = await this.#metadata('broker.sock');
    if (current === null || current.kind !== 'socket' || current.object_identity !== expectedIdentity) return 'absent';
    if (afterMetadataForTests !== undefined) await afterMetadataForTests();
    const reservation = await this.#reserveQuarantineSlot(expectedIdentity, quarantineLimit, reserveSlotsAfter);
    try {
      if (afterReservationForTests !== undefined) await afterReservationForTests();
      const rechecked = await this.#metadata('broker.sock');
      if (rechecked?.kind !== 'socket' || rechecked.object_identity !== expectedIdentity) {
        throw new Error('REPOSITORY_BUSY: broker endpoint changed during quarantine');
      }
      const count = await this.#validatedQuarantineCount(expectedIdentity, reservation);
      if (count + reserveSlotsAfter > quarantineLimit) {
        throw new Error('REPOSITORY_BUSY: broker quarantine capacity exhausted');
      }
      try {
        await rename(this.#childPath('broker.sock'), `${this.#reservationPath(reservation)}/broker.sock`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
      }
      await reservation.handle.sync();
      await this.#syncDirectory();
      const quarantined = await this.#metadataAtPath(`${this.#reservationPath(reservation)}/broker.sock`);
      if (quarantined?.object_identity !== expectedIdentity) {
        await this.#restoreWithoutOverwrite(reservation);
        throw new Error('REPOSITORY_BUSY: broker endpoint changed during quarantine');
      }
      return 'removed';
    } finally {
      await reservation.handle.close();
    }
  }

  async loadToken(input: { platform: NodeJS.Platform; loadToken?: (directory: string, platform: NodeJS.Platform) => Promise<string> }): Promise<string> {
    if (input.loadToken !== undefined) return callAdapter(() => input.loadToken!(this.#statePath(), input.platform));
    const tokenPath = this.#childPath(TOKEN_FILE_V4);
    const freshToken = randomBytes(32).toString('hex');
    const created = await open(
      tokenPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null;
      throw error;
    });
    if (created !== null) {
      try {
        await created.writeFile(`${freshToken}\n`, 'utf8');
        await created.sync();
        const metadata = await created.stat({ bigint: true });
        if (!metadata.isFile() || linuxOwnerIdentityV4(metadata.uid) !== this.#expectedOwnerIdentity || (metadata.mode & 0o077n) !== 0n) physicalPathRejected();
      } finally {
        await created.close();
      }
      return freshToken;
    }
    const existing = await open(tokenPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await existing.stat({ bigint: true });
      if (!metadata.isFile() || linuxOwnerIdentityV4(metadata.uid) !== this.#expectedOwnerIdentity || (metadata.mode & 0o077n) !== 0n) physicalPathRejected();
      const token = (await existing.readFile('utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('AUTHENTICATION_FAILED: broker token bytes are invalid');
      return token;
    } finally {
      await existing.close();
    }
  }

  verifyOwnerOnlyPath(input: {
    kind: 'state-directory' | 'token-file';
    expected_owner_identity: string;
    verifier: BrokerIpcPlatformVerifierV4;
  }): Promise<{ owner_identity: string } | null> {
    const path = input.kind === 'state-directory' ? this.#statePath() : this.#childPath(TOKEN_FILE_V4);
    return callAdapter(() => input.verifier.verifyOwnerOnlyPath({ path, kind: input.kind, expected_owner_identity: input.expected_owner_identity }));
  }

  async reclaimBrokerSocket(
    expectedOwnerIdentity: string,
    quarantineLimit = MAX_LINUX_BROKER_QUARANTINES_V4,
  ): Promise<void> {
    const metadata = await this.#metadata('broker.sock');
    if (metadata === null) {
      await this.#assertQuarantineCapacity(quarantineLimit, 1, null);
      return;
    }
    if (metadata.kind !== 'socket' || metadata.owner_identity !== expectedOwnerIdentity || !metadata.owner_only) {
      throw new Error('AUTHENTICATION_FAILED: existing broker endpoint ownership or mode is invalid');
    }
    await this.#validatedQuarantineCount(metadata.object_identity);
    const status = await defaultUnixProbe(this.#childPath('broker.sock')).catch(() => 'unknown' as const);
    if (status !== 'stale') throw new Error('REPOSITORY_BUSY: broker endpoint is live or unverifiable');
    await this.#quarantineOwnedEndpoint(metadata.object_identity, undefined, quarantineLimit, 1);
  }

  async listenBrokerSocket(
    server: Server,
    quarantineLimit = MAX_LINUX_BROKER_QUARANTINES_V4,
    afterListenerReceivedForTests?: () => Promise<void>,
  ): Promise<UnixBrokerListenerBindingV4> {
    let adopted: LinuxAdoptedListenerV4 | null = null;
    try {
      adopted = await adoptPathlessLinuxListenerV4(this.#handle.fd, server, afterListenerReceivedForTests);
      const endpoint = await this.#metadata('broker.sock');
      if (
        endpoint === null
        || endpoint.kind !== 'socket'
        || endpoint.owner_identity !== this.#expectedOwnerIdentity
        || !endpoint.owner_only
        || endpoint.object_identity !== adopted.objectIdentity
      ) physicalPathRejected();
      const directoryIdentity = this.inspection.components.at(-1)?.object_identity;
      if (typeof directoryIdentity !== 'string') physicalPathRejected();
      this.#transferred = true;
      return new LinuxNativeBrokerListenerBindingV4(this.#handle, directoryIdentity, endpoint.object_identity, adopted.server);
    } catch (error) {
      if (adopted !== null) {
        await closeServerHandleV4(adopted.server).catch(() => undefined);
        await this.#quarantineOwnedEndpoint(adopted.objectIdentity, undefined, quarantineLimit).catch(() => undefined);
      }
      throw error;
    }
  }

  async publishBrokerSocket(input: {
    binding: UnixBrokerListenerBindingV4;
    expected_owner_identity: string;
    verifier: BrokerIpcPlatformVerifierV4;
  }, quarantineLimit = MAX_LINUX_BROKER_QUARANTINES_V4): Promise<string> {
    if (!linuxNativeListenerBindingBrandV4.has(input.binding) || !(input.binding instanceof LinuxNativeBrokerListenerBindingV4) || input.binding.released) physicalPathRejected();
    const directoryIdentity = this.inspection.components.at(-1)?.object_identity;
    if (directoryIdentity !== input.binding.directoryIdentity) physicalPathRejected();
    try {
      const endpoint = await this.#metadata('broker.sock');
      if (endpoint === null || endpoint.kind !== 'socket' || endpoint.object_identity !== input.binding.endpointIdentity || endpoint.owner_identity !== input.expected_owner_identity || !endpoint.owner_only) physicalPathRejected();
      const proof = await callAdapter(() => input.verifier.verifyOwnerOnlyPath({
        path: this.#childPath('broker.sock'),
        kind: 'endpoint',
        expected_owner_identity: input.expected_owner_identity,
      })).catch(() => null);
      if (proof?.owner_identity !== input.expected_owner_identity) throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
      const verified = await this.#metadata('broker.sock');
      if (verified?.object_identity !== input.binding.endpointIdentity) physicalPathRejected();
      return input.binding.endpointIdentity;
    } catch (error) {
      await this.#quarantineOwnedEndpoint(input.binding.endpointIdentity, undefined, quarantineLimit).catch(() => undefined);
      throw error;
    }
  }

  async withConnectedBrokerSocket<T>(
    connect: ((endpoint: string) => Socket) | undefined,
    operation: (socket: Socket) => Promise<T>,
  ): Promise<T> {
    const socket = (connect ?? createConnection)(this.#childPath('broker.sock'));
    return operation(socket);
  }

  async removeOwnedBrokerSocket(
    ownedObjectIdentity: string,
    testDependencies?: UnixOwnedEndpointCleanupDependenciesV4,
    quarantineLimit = MAX_LINUX_BROKER_QUARANTINES_V4,
    afterReservationForTests?: () => Promise<void>,
  ): Promise<void> {
    await this.#quarantineOwnedEndpoint(ownedObjectIdentity, testDependencies?.afterMetadataForTests, quarantineLimit, 0, afterReservationForTests);
  }
}

class LinuxNativeUnixPhysicalPathBackendV4 implements UnixPhysicalPathBackendV4 {
  readonly certification = Object.freeze({ kind: 'native-physical-path' as const, identity: 'linux-procfd-v1' });

  async certifyStateDirectory(input: { state_directory: string; expected_owner_identity: string }): Promise<UnixPhysicalPathInspectionV4> {
    let opened: Awaited<ReturnType<typeof openLinuxPhysicalStateDirectoryV4>>;
    try { opened = await openLinuxPhysicalStateDirectoryV4(input); }
    catch { physicalPathRejected(); }
    try {
      return loadUnixPhysicalInspectionV4(opened.inspection, input.expected_owner_identity);
    } finally {
      await opened.handle.close();
    }
  }

  async withReprovedStateDirectory<T>(
    input: { operation_path: string; expected_owner_identity: string; component_identities: readonly string[] },
    operation: (capability: UnixPhysicalDirectoryCapabilityV4) => Promise<T>,
  ): Promise<T> {
    let opened: Awaited<ReturnType<typeof openLinuxPhysicalStateDirectoryV4>>;
    try {
      opened = await openLinuxPhysicalStateDirectoryV4({
        state_directory: input.operation_path,
        expected_owner_identity: input.expected_owner_identity,
      });
    } catch {
      physicalPathRejected();
    }
    const inspection = loadUnixPhysicalInspectionV4(opened.inspection, input.expected_owner_identity);
    if (!samePhysicalComponentIdentitiesV4(input.component_identities, inspection.components)) {
      await opened.handle.close().catch(() => undefined);
      physicalPathRejected();
    }
    const capability = new LinuxNativePhysicalDirectoryCapabilityV4(opened.handle, inspection, input.expected_owner_identity);
    try {
      return await operation(capability);
    } finally {
      await capability.closeUnlessTransferred();
    }
  }
}

Object.freeze(LinuxNativeUnixPhysicalPathBackendV4.prototype);

export function createLinuxNativeUnixPhysicalPathBackendV4(): UnixPhysicalPathBackendV4 {
  if (process.platform !== 'linux') throw new Error('AUTHENTICATION_FAILED: Linux native physical-path backend is unavailable');
  const backend = new LinuxNativeUnixPhysicalPathBackendV4();
  linuxNativePhysicalBackendBrandV4.add(backend);
  return Object.freeze(backend);
}

function assertUnixPhysicalBackendV4(
  backend: UnixPhysicalPathBackendV4 | undefined,
  allowInProcessForTests: boolean | undefined,
  platform: NodeJS.Platform,
): UnixPhysicalPathBackendV4 {
  if (backend === undefined || backend === null || typeof backend !== 'object') throw new Error('AUTHENTICATION_FAILED: certified Unix physical-path backend is required');
  const certification = backend.certification;
  if (certification === null || typeof certification !== 'object' || certification.kind !== 'native-physical-path' && certification.kind !== 'in-process-test') {
    throw new Error('AUTHENTICATION_FAILED: Unix physical-path backend certification is invalid');
  }
  if (certification.kind === 'native-physical-path' && !linuxNativePhysicalBackendBrandV4.has(backend)) {
    throw new Error('AUTHENTICATION_FAILED: Unix physical-path backend brand is invalid');
  }
  if (certification.kind === 'native-physical-path' && (platform !== 'linux' || process.platform !== 'linux')) {
    throw new Error('AUTHENTICATION_FAILED: Linux physical-path backend cannot serve this platform');
  }
  if (certification.kind !== 'native-physical-path' && !allowInProcessForTests) {
    throw new Error('AUTHENTICATION_FAILED: native Unix physical-path backend is required');
  }
  if (typeof certification.identity !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(certification.identity)) throw new Error('AUTHENTICATION_FAILED: Unix physical-path backend identity is invalid');
  if (typeof backend.certifyStateDirectory !== 'function' || typeof backend.withReprovedStateDirectory !== 'function') {
    throw new Error('AUTHENTICATION_FAILED: Unix physical-path backend contract is invalid');
  }
  return backend;
}

async function certifyUnixPhysicalPathV4(
  stateDirectory: string,
  expectedOwnerIdentity: string,
  backend: UnixPhysicalPathBackendV4,
): Promise<CertifiedUnixPhysicalPathV4> {
  let inspection: UnixPhysicalPathInspectionV4;
  try {
    inspection = loadUnixPhysicalInspectionV4(
      await callAdapter(() => backend.certifyStateDirectory({ state_directory: stateDirectory, expected_owner_identity: expectedOwnerIdentity })),
      expectedOwnerIdentity,
    );
  } catch {
    physicalPathRejected();
  }
  const componentIdentities = Object.freeze(inspection.components.map((component) => component.object_identity!));
  return Object.freeze({
    display_path: stateDirectory,
    operation_path: inspection.operation_path,
    expected_owner_identity: expectedOwnerIdentity,
    component_identities: componentIdentities,
    coordinator_key: `ipc-state-physical:${hashCanonicalV4({ component_identities: componentIdentities })}`,
  });
}

function samePhysicalComponentIdentitiesV4(expected: readonly string[], observed: readonly UnixPhysicalPathComponentV4[]): boolean {
  return expected.length === observed.length && expected.every((identity, index) => identity === observed[index]?.object_identity);
}

async function runUnixPhysicalCriticalSectionV4<T>(
  certified: CertifiedUnixPhysicalPathV4,
  backend: UnixPhysicalPathBackendV4,
  coordinator: ReclamationCoordinatorV4,
  operation: (critical: UnixPhysicalCriticalSectionV4) => Promise<T>,
): Promise<T> {
  return callAdapter(() => coordinator.runExclusive(certified.coordinator_key, async () => operation({
    runSensitive: async <U>(sensitiveOperation: (capability: UnixPhysicalDirectoryCapabilityV4) => Promise<U>): Promise<U> => {
      let sensitiveOperationEntered = false;
      try {
        return await callAdapter(() => backend.withReprovedStateDirectory(
          {
            operation_path: certified.operation_path,
            expected_owner_identity: certified.expected_owner_identity,
            component_identities: certified.component_identities,
          },
          async (capability) => {
            const observed = loadUnixPhysicalInspectionV4(capability.inspection, certified.expected_owner_identity);
            if (!samePhysicalComponentIdentitiesV4(certified.component_identities, observed.components)) physicalPathRejected();
            sensitiveOperationEntered = true;
            return sensitiveOperation(capability);
          },
        ));
      } catch (error) {
        if (!sensitiveOperationEntered) physicalPathRejected();
        throw error;
      }
    },
  })));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(`${name} has unknown or missing properties`);
}

function loadSubmittedCommand(value: unknown): Extract<BrokerCommandV4, { type: 'RUN_CODING_TASK' }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('command must be an object');
  const command = value as Record<string, unknown>;
  exactKeys(command, ['type', 'command_id', 'request'], 'command');
  if (command.type !== 'RUN_CODING_TASK') invalid(`unknown command ${String(command.type)}`);
  if (typeof command.command_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.command_id)) invalid('command_id is invalid');
  return Object.freeze({ type: 'RUN_CODING_TASK', command_id: command.command_id, request: loadRuntimeTaskRequestV4(command.request) });
}

function equalToken(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const suppliedBytes = Buffer.from(supplied, 'hex');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

const PUBLIC_FAILURE_MESSAGES_V4: Readonly<Record<RuntimeFailureCodeV4, string>> = Object.freeze({
  INVALID_CONTRACT: 'request contract rejected',
  REPOSITORY_NOT_ALLOWED: 'repository is not allowed',
  REPOSITORY_BUSY: 'repository is busy',
  BROKER_STATE_CORRUPT: 'broker state is corrupt',
  BASE_SHA_INVALID: 'base revision is invalid',
  WORKTREE_CREATION_FAILED: 'worktree creation failed',
  CAPABILITY_UNVERIFIED: 'required capability is unverified',
  SOURCE_SENSITIVITY_UNSUPPORTED: 'source sensitivity is unsupported',
  PROCESS_SANDBOX_UNAVAILABLE: 'process sandbox is unavailable',
  REVIEW_SANDBOX_UNAVAILABLE: 'review sandbox is unavailable',
  AUTHENTICATION_FAILED: 'authentication failed',
  PROVIDER_UNAVAILABLE: 'provider is unavailable',
  EXECUTOR_INVALID_OUTPUT: 'executor output is invalid',
  EXECUTOR_POLICY_VIOLATION: 'executor policy was violated',
  OUT_OF_SCOPE_CHANGE: 'change is outside the allowed scope',
  VALIDATION_FAILED: 'validation failed',
  REVIEW_REJECTED: 'review rejected the result',
  REVIEW_ATTESTATION_INVALID: 'review attestation is invalid',
  EVIDENCE_HASH_MISMATCH: 'evidence hash does not match',
  FINALIZATION_ISOLATION_FAILED: 'finalization isolation failed',
  FINALIZATION_FAILED: 'finalization failed',
  ABORTED: 'operation was aborted',
  UNKNOWN_FAILURE: 'broker request failed',
});

function failureCode(value: unknown): RuntimeFailureCodeV4 {
  const message = value instanceof Error ? value.message : value;
  const code = typeof message === 'string' ? /^([A-Z_]+):/.exec(message)?.[1] : undefined;
  return code !== undefined && RUNTIME_FAILURE_CODES_V4.includes(code as RuntimeFailureCodeV4)
    ? code as RuntimeFailureCodeV4
    : 'UNKNOWN_FAILURE';
}

function normalizedBoundaryMessage(error: unknown): string {
  const code = failureCode(error);
  return `${code}: ${PUBLIC_FAILURE_MESSAGES_V4[code]}`;
}

function isSafeOwnerProofFailureV4(error: unknown): error is Error {
  return error instanceof Error && (
    error.message === 'AUTHENTICATION_FAILED: native state-directory ownership/ACL proof failed'
    || error.message === 'AUTHENTICATION_FAILED: native token-file ownership/ACL proof failed'
  );
}

export function normalizeBrokerResponseErrorV4(value: unknown): string {
  return normalizedBoundaryMessage(value);
}

function responseRejected(): never {
  throw new Error('UNKNOWN_FAILURE: broker response rejected');
}

export function loadBrokerIpcResponseV4(payload: string): BrokerIpcResponseV4 {
  if (Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES_V4) responseRejected();
  let decoded: unknown;
  try { decoded = JSON.parse(payload); } catch { responseRejected(); }
  try {
    if (canonicalJsonV4(decoded) !== payload || decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) responseRejected();
    const response = decoded as Record<string, unknown>;
    if (response.ok === false) {
      exactKeys(response, ['ok', 'error'], 'response');
      if (typeof response.error !== 'string') responseRejected();
      return Object.freeze({ ok: false, error: normalizeBrokerResponseErrorV4(response.error) });
    }
    if (response.ok !== true) responseRejected();
    exactKeys(response, ['ok', 'reply'], 'response');
    if (response.reply === null || typeof response.reply !== 'object' || Array.isArray(response.reply)) responseRejected();
    const reply = response.reply as Record<string, unknown>;
    exactKeys(reply, ['request_id', 'run_id', 'state', 'status_token'], 'reply');
    if (typeof reply.request_id !== 'string' || !/^req_[A-Za-z0-9_-]{16,96}$/.test(reply.request_id)) responseRejected();
    if (typeof reply.run_id !== 'string' || !/^run_[A-Za-z0-9_-]{16,96}$/.test(reply.run_id)) responseRejected();
    if (typeof reply.state !== 'string' || !BROKER_REPLY_STATES_V4.has(reply.state)) responseRejected();
    if (typeof reply.status_token !== 'string' || !/^[a-f0-9]{64}$/.test(reply.status_token)) responseRejected();
    return Object.freeze({ ok: true, reply: Object.freeze(reply as unknown as BrokerReplyV4) });
  } catch {
    responseRejected();
  }
}

async function verifyDaemonReplyV4(command: Extract<BrokerCommandV4, { type: 'RUN_CODING_TASK' }>, reply: BrokerReplyV4, daemon: BrokerDaemonV4): Promise<void> {
  if (reply.request_id !== command.request.request_id) responseRejected();
  let status;
  try {
    status = loadRuntimeResultV4(await callAdapter(() => daemon.status(reply.run_id)));
  } catch {
    responseRejected();
  }
  if (status.request_id !== command.request.request_id || status.run_id !== reply.run_id || status.state !== reply.state) responseRejected();
  const expectedStatusToken = hashCanonicalV4({
    run_id: status.run_id,
    state: status.state,
    artifact_manifest_hash: status.artifact_manifest_hash,
  });
  if (reply.status_token !== expectedStatusToken) responseRejected();
}

async function defaultUnixMetadata(endpoint: string): Promise<UnixSocketMetadataV4 | null> {
  const metadata = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata === null) return null;
  return { kind: metadata.isSocket() ? 'socket' : 'other', owner_identity: `uid:${metadata.uid}`, owner_only: (metadata.mode & 0o077) === 0, object_identity: `${metadata.dev}:${metadata.ino}` };
}

async function defaultUnixProbe(endpoint: string): Promise<'live' | 'stale' | 'unknown'> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(endpoint);
    const finish = (result: 'live' | 'stale' | 'unknown') => { socket.destroy(); resolveProbe(result); };
    socket.setTimeout(250, () => finish('unknown'));
    socket.once('connect', () => finish('live'));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? 'stale' : 'unknown'));
  });
}

export async function reclaimUnixSocketV4(
  endpoint: string,
  expectedOwnerIdentity: string,
  deps: UnixSocketReclaimDependenciesV4 = {
    metadata: defaultUnixMetadata,
    probe: defaultUnixProbe,
    rename,
    removeQuarantine: unlink,
    restoreQuarantine: async (from, to) => {
      if (await defaultUnixMetadata(to) !== null) throw new Error('REPOSITORY_BUSY: broker endpoint was replaced during restore');
      await rename(from, to);
    },
  },
): Promise<void> {
  const metadata = await callAdapter(() => deps.metadata(endpoint)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker endpoint metadata unavailable'); });
  if (metadata === null) return;
  if (metadata.kind !== 'socket' || metadata.owner_identity !== expectedOwnerIdentity || !metadata.owner_only) {
    throw new Error('AUTHENTICATION_FAILED: existing broker endpoint ownership or mode is invalid');
  }
  const status = await callAdapter(() => deps.probe(endpoint)).catch(() => 'unknown' as const);
  if (status !== 'stale') throw new Error('REPOSITORY_BUSY: broker endpoint is live or unverifiable');
  const quarantine = `${endpoint}.stale-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await callAdapter(() => deps.rename(endpoint, quarantine));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const rechecked = await callAdapter(() => deps.metadata(endpoint)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker endpoint metadata unavailable'); });
      if (rechecked === null) return;
      throw new Error('REPOSITORY_BUSY: broker endpoint changed during stale reclamation');
    }
    throw new Error('UNKNOWN_FAILURE: stale broker endpoint quarantine failed');
  }
  const quarantined = await callAdapter(() => deps.metadata(quarantine)).catch(() => null);
  if (quarantined?.object_identity !== metadata.object_identity) {
    await callAdapter(() => deps.restoreQuarantine(quarantine, endpoint)).catch(() => { throw new Error('REPOSITORY_BUSY: live replacement could not be restored'); });
    throw new Error('REPOSITORY_BUSY: broker endpoint was replaced during stale reclamation');
  }
  await callAdapter(() => deps.removeQuarantine(quarantine)).catch(() => { throw new Error('UNKNOWN_FAILURE: stale broker endpoint cleanup failed'); });
}

async function removeOwnedUnixEndpointInsideCoordinatorV4(
  endpoint: string,
  ownedObjectIdentity: string,
  deps: { metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>; remove(endpoint: string): Promise<void> } = {
    metadata: defaultUnixMetadata,
    remove: unlink,
  },
): Promise<void> {
  const current = await callAdapter(() => deps.metadata(endpoint)).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed'); });
  if (current === null || current.kind !== 'socket' || current.object_identity !== ownedObjectIdentity) return;
  await callAdapter(() => deps.remove(endpoint)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed');
  });
}

export async function removeOwnedUnixEndpointV4(
  endpoint: string,
  ownedObjectIdentity: string,
  deps: UnixOwnedEndpointCleanupDependenciesV4,
  coordinator: ReclamationCoordinatorV4,
  security: UnixPhysicalPathSecurityV4,
): Promise<void> {
  try {
    if (coordinator.certification.kind !== 'native-cross-process' && !security.allowInProcessCoordinatorForTests) {
      throw new Error('AUTHENTICATION_FAILED: native endpoint coordinator is required');
    }
    if (coordinator.certification.identity.length === 0) throw new Error('AUTHENTICATION_FAILED: endpoint coordinator identity is invalid');
    const backend = assertUnixPhysicalBackendV4(security.unixPhysicalPathBackend, security.allowInProcessPhysicalPathBackendForTests, 'linux');
    const requestedLocation = loadBrokerIpcLocationV4(security.stateDirectory, endpoint, 'linux');
    const certified = await certifyUnixPhysicalPathV4(requestedLocation.stateDirectory, security.expectedOwnerIdentity, backend);
    const location = loadBrokerIpcLocationV4(security.stateDirectory, endpoint, 'linux', certified.operation_path);
    await runUnixPhysicalCriticalSectionV4(certified, backend, coordinator, (critical) => critical.runSensitive(
      (capability) => capability.removeOwnedBrokerSocket(
        ownedObjectIdentity,
        security.allowInProcessPhysicalPathBackendForTests ? deps : undefined,
      ),
    ));
  } catch (error) {
    if (failureCode(error) === 'AUTHENTICATION_FAILED') throw new Error(normalizedBoundaryMessage(error));
    throw new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed');
  }
}

export async function secureUnixEndpointV4(
  endpoint: string,
  expectedOwnerIdentity: string,
  deps: {
    metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>;
    secure(endpoint: string): Promise<void>;
    verify(endpoint: string, expectedOwnerIdentity: string): Promise<{ owner_identity: string } | null>;
    close(): Promise<void>;
    remove(endpoint: string): Promise<void>;
  },
): Promise<string> {
  let ownedObjectIdentity: string | null = null;
  try {
    const metadata = await callAdapter(() => deps.metadata(endpoint)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker endpoint metadata unavailable'); });
    if (metadata === null || metadata.kind !== 'socket' || metadata.owner_identity !== expectedOwnerIdentity) {
      throw new Error('AUTHENTICATION_FAILED: broker endpoint ownership could not be established');
    }
    ownedObjectIdentity = metadata.object_identity;
    await callAdapter(() => deps.secure(endpoint)).catch(() => { throw new Error('AUTHENTICATION_FAILED: endpoint permission setup failed'); });
    const proof = await callAdapter(() => deps.verify(endpoint, expectedOwnerIdentity)).catch(() => null);
    if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
    return ownedObjectIdentity;
  } catch (error) {
    let cleanupFailure: Error | null = null;
    try { await callAdapter(deps.close); } catch { cleanupFailure = new Error('UNKNOWN_FAILURE: local IPC close failed'); }
    if (ownedObjectIdentity !== null) {
      try {
        await removeOwnedUnixEndpointInsideCoordinatorV4(endpoint, ownedObjectIdentity, { metadata: deps.metadata, remove: deps.remove });
      } catch { cleanupFailure = new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed'); }
    }
    if (cleanupFailure !== null) throw cleanupFailure;
    throw new Error(normalizedBoundaryMessage(error));
  }
}

async function verifyOwnerOnlyState(directory: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error('AUTHENTICATION_FAILED: broker state path is not a directory');
  if (platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) throw new Error('AUTHENTICATION_FAILED: broker state directory is not owner-only');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error('AUTHENTICATION_FAILED: broker state directory owner differs');
  }
}

async function loadOrCreateToken(directory: string, platform: NodeJS.Platform): Promise<string> {
  const path = join(directory, TOKEN_FILE_V4);
  const freshToken = randomBytes(32).toString('hex');
  const created = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw error;
  });
  if (created !== null) {
    try {
      await created.writeFile(`${freshToken}\n`, 'utf8');
      await created.sync();
    } finally {
      await created.close();
    }
    if (platform !== 'win32') await chmod(path, 0o600);
    return freshToken;
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('AUTHENTICATION_FAILED: broker token path is not a regular file');
  if (platform !== 'win32') {
    if ((metadata.mode & 0o077) !== 0) throw new Error('AUTHENTICATION_FAILED: broker token is not owner-only');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error('AUTHENTICATION_FAILED: broker token owner differs');
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('AUTHENTICATION_FAILED: broker token bytes are invalid');
  return token;
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(canonicalJsonV4(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES_V4) invalid('frame too large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolvePromise(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}

export async function createBrokerIpcServer(deps: BrokerIpcDependenciesV4): Promise<BrokerIpcServerV4> {
  const platform = deps.platform ?? process.platform;
  const deadline = deps.requestDeadlineMs ?? 5_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 60_000) invalid('request deadline is invalid');
  if (deps.platformVerifier === undefined) throw new Error('AUTHENTICATION_FAILED: native platform verifier is required');
  if (deps.endpointCoordinator === undefined) throw new Error('AUTHENTICATION_FAILED: certified endpoint coordinator is required');
  if (deps.endpointCoordinator.certification.kind !== 'native-cross-process' && !deps.allowInProcessCoordinatorForTests) {
    throw new Error('AUTHENTICATION_FAILED: native endpoint coordinator is required');
  }
  if (deps.endpointCoordinator.certification.identity.length === 0) throw new Error('AUTHENTICATION_FAILED: endpoint coordinator identity is invalid');
  if (
    (deps.afterLinuxListenerReceivedForTests !== undefined || deps.afterLinuxQuarantineReservationForTests !== undefined)
    && (
      platform !== 'linux'
      || deps.allowInProcessPhysicalPathBackendForTests !== true
      || deps.afterLinuxListenerReceivedForTests !== undefined && typeof deps.afterLinuxListenerReceivedForTests !== 'function'
      || deps.afterLinuxQuarantineReservationForTests !== undefined && typeof deps.afterLinuxQuarantineReservationForTests !== 'function'
    )
  ) throw new Error('AUTHENTICATION_FAILED: Linux physical-path test hook is invalid');
  const linuxQuarantineLimit = platform === 'win32'
    ? MAX_LINUX_BROKER_QUARANTINES_V4
    : loadLinuxQuarantineLimitV4(deps.unixQuarantineLimitForTests, deps.allowInProcessPhysicalPathBackendForTests);
  const expectedOwnerIdentity = platformOwnerIdentity(platform);
  const requestedLocation = loadBrokerIpcLocationV4(deps.stateDirectory, deps.endpoint, platform);
  let physicalBackend: UnixPhysicalPathBackendV4 | null = null;
  let certifiedUnixPath: CertifiedUnixPhysicalPathV4 | null = null;
  if (platform !== 'win32') {
    physicalBackend = assertUnixPhysicalBackendV4(deps.unixPhysicalPathBackend, deps.allowInProcessPhysicalPathBackendForTests, platform);
    certifiedUnixPath = await certifyUnixPhysicalPathV4(requestedLocation.stateDirectory, expectedOwnerIdentity, physicalBackend);
  }
  const location = platform === 'win32'
    ? requestedLocation
    : loadBrokerIpcLocationV4(deps.stateDirectory, deps.endpoint, platform, certifiedUnixPath!.operation_path);
  let token = '';
  if (platform === 'win32') {
    await verifyOwnerOnlyState(location.stateDirectory, platform).catch((error) => {
      if (error instanceof Error && error.message.startsWith('AUTHENTICATION_FAILED:')) throw error;
      throw new Error('AUTHENTICATION_FAILED: broker state verification failed');
    });
    token = await callAdapter(() => (deps.loadToken ?? loadOrCreateToken)(location.stateDirectory, platform)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker token storage failed'); });
  }
  const endpoint = location.endpoint;
  if (platform === 'win32') {
    for (const [path, kind] of [[location.stateDirectory, 'state-directory'], [join(location.stateDirectory, TOKEN_FILE_V4), 'token-file']] as const) {
      const proof = await callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path, kind, expected_owner_identity: expectedOwnerIdentity })).catch(() => null);
      if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error(`AUTHENTICATION_FAILED: native ${kind} ownership/ACL proof failed`);
    }
  }

  const exchange = async (payload: Buffer, socket?: Socket): Promise<BrokerIpcResponseV4> => {
    try {
      if (payload.length > MAX_FRAME_BYTES_V4) invalid('frame too large');
      const peer = await callAdapter(() => deps.platformVerifier!.verifyPeer({ socket, endpoint, expected_owner_identity: expectedOwnerIdentity }));
      if (peer?.owner_identity !== expectedOwnerIdentity) throw new Error('AUTHENTICATION_FAILED: peer ownership could not be established');
      let decoded: unknown;
      const json = payload.toString('utf8');
      try { decoded = JSON.parse(json); } catch { invalid('frame is not valid JSON'); }
      if (canonicalJsonV4(decoded) !== json) invalid('frame is not canonical JSON');
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) invalid('request must be an object');
      const request = decoded as Record<string, unknown>;
      exactKeys(request, ['token', 'command'], 'request');
      if (!equalToken(token, request.token)) throw new Error('AUTHENTICATION_FAILED: token mismatch');
      const command = loadSubmittedCommand(request.command);
      const response = loadBrokerIpcResponseV4(canonicalJsonV4({ ok: true, reply: await callAdapter(() => deps.daemon.submit(command)) }));
      if (!response.ok || response.reply === undefined) responseRejected();
      await verifyDaemonReplyV4(command, response.reply, deps.daemon);
      return response;
    } catch (error) {
      return { ok: false, error: normalizedBoundaryMessage(error) };
    }
  };

  let server: Server;
  try {
    server = createServer();
    trackServerConnectionsV4(server);
    server.on('connection', (socket) => {
      let buffer = Buffer.alloc(0);
      let expectedLength: number | null = null;
      let handled = false;
      socket.setTimeout(deadline, () => socket.destroy(new Error('INVALID_CONTRACT: request deadline exceeded')));
      socket.on('data', (chunk: Buffer) => {
        if (handled) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (expectedLength === null && buffer.length >= 4) {
          expectedLength = buffer.readUInt32BE(0);
          buffer = buffer.subarray(4);
          if (expectedLength > MAX_FRAME_BYTES_V4) {
            handled = true;
            socket.end(encodeFrame({ ok: false, error: 'INVALID_CONTRACT: request contract rejected' }));
            return;
          }
        }
        if (expectedLength !== null && buffer.length >= expectedLength) {
          handled = true;
          if (buffer.length !== expectedLength) {
            socket.end(encodeFrame({ ok: false, error: 'INVALID_CONTRACT: request contract rejected' }));
            return;
          }
          void exchange(buffer, socket).then((response) => socket.end(encodeFrame(response)));
        }
      });
      socket.on('error', () => socket.destroy());
    });
  } catch {
    throw new Error('UNKNOWN_FAILURE: local IPC startup failed');
  }
  const endpointCoordinatorKey = certifiedUnixPath?.coordinator_key ?? `ipc-endpoint:${endpoint}`;
  const runEndpointCriticalSection = async <T>(operation: (critical: UnixPhysicalCriticalSectionV4) => Promise<T>): Promise<T> => {
    if (platform !== 'win32') {
      return runUnixPhysicalCriticalSectionV4(certifiedUnixPath!, physicalBackend!, deps.endpointCoordinator, operation);
    }
    return callAdapter(() => deps.endpointCoordinator.runExclusive(endpointCoordinatorKey, () => operation({
      runSensitive: <U>(sensitiveOperation: (capability: UnixPhysicalDirectoryCapabilityV4) => Promise<U>) => callAdapter(() => sensitiveOperation(undefined as never)),
    })));
  };
  let ownedUnixEndpointIdentity: string | null = null;
  let unixListenerBinding: UnixBrokerListenerBindingV4 | null = null;
  const closeNativeServer = () => closeServerHandleV4(server);
  const releaseUnixListenerBinding = async (): Promise<void> => {
    if (unixListenerBinding === null) return;
    const binding = unixListenerBinding;
    unixListenerBinding = null;
    await binding.release();
  };
  const closeAndCleanOwnedEndpoint = async (closeOperation: () => Promise<void>, critical: UnixPhysicalCriticalSectionV4): Promise<Error | null> => {
    let failure: Error | null = null;
    try {
      await closeOperation();
      if (server.listening) await closeNativeServer();
    } catch {
      failure = new Error('UNKNOWN_FAILURE: local IPC close failed');
      await closeNativeServer().catch(() => undefined);
    }
    if (!server.listening) await releaseUnixListenerBinding().catch(() => { failure = new Error('UNKNOWN_FAILURE: local IPC close failed'); });
    if (platform !== 'win32' && ownedUnixEndpointIdentity !== null && !server.listening) {
      try {
        await critical.runSensitive((capability) => capability.removeOwnedBrokerSocket(
          ownedUnixEndpointIdentity!,
          undefined,
          linuxQuarantineLimit,
          deps.afterLinuxQuarantineReservationForTests,
        ));
        ownedUnixEndpointIdentity = null;
      } catch {
        failure = new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed');
      }
    }
    return failure;
  };
  try {
    await runEndpointCriticalSection(async (critical) => {
      if (platform !== 'win32') {
        token = await critical.runSensitive((capability) => capability.loadToken({ platform, loadToken: deps.loadToken })).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker token storage failed'); });
        for (const kind of ['state-directory', 'token-file'] as const) {
          const proof = await critical.runSensitive((capability) => capability.verifyOwnerOnlyPath({ kind, expected_owner_identity: expectedOwnerIdentity, verifier: deps.platformVerifier! })).catch(() => null);
          if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error(`AUTHENTICATION_FAILED: native ${kind} ownership/ACL proof failed`);
        }
        await critical.runSensitive((capability) => capability.reclaimBrokerSocket(expectedOwnerIdentity, linuxQuarantineLimit));
        unixListenerBinding = await critical.runSensitive((capability) => capability.listenBrokerSocket(
          server,
          linuxQuarantineLimit,
          deps.afterLinuxListenerReceivedForTests,
        )).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC startup failed'); });
        server = unixListenerBinding.server;
        ownedUnixEndpointIdentity = await critical.runSensitive((capability) => capability.publishBrokerSocket({
          binding: unixListenerBinding!,
          expected_owner_identity: expectedOwnerIdentity,
          verifier: deps.platformVerifier!,
        }, linuxQuarantineLimit));
      } else try {
        await critical.runSensitive(() => listen(server, endpoint)).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC startup failed'); });
        const endpointProof = await critical.runSensitive(() => callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path: endpoint, kind: 'endpoint', expected_owner_identity: expectedOwnerIdentity }))).catch(() => null);
        if (endpointProof?.owner_identity !== expectedOwnerIdentity) throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
      } catch (error) {
        await closeNativeServer().catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC close failed'); });
        throw new Error(normalizedBoundaryMessage(error));
      }
    });
  } catch (error) {
    let cleanupFailed = false;
    if (server.listening) await closeNativeServer().catch(() => { cleanupFailed = true; });
    if (!server.listening) await releaseUnixListenerBinding().catch(() => { cleanupFailed = true; });
    if (platform !== 'win32' && ownedUnixEndpointIdentity !== null && !server.listening) {
      try {
        await runEndpointCriticalSection((critical) => critical.runSensitive((capability) => capability.removeOwnedBrokerSocket(
          ownedUnixEndpointIdentity!,
          undefined,
          linuxQuarantineLimit,
          deps.afterLinuxQuarantineReservationForTests,
        )));
        ownedUnixEndpointIdentity = null;
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new Error('UNKNOWN_FAILURE: local IPC close failed');
    if (isSafeOwnerProofFailureV4(error)) throw error;
    throw new Error(normalizedBoundaryMessage(error));
  }

  let closePromise: Promise<void> | null = null;
  return {
    endpoint,
    exchangeFrameForTest: (payload) => exchange(payload),
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        let closeFailure: Error | null;
        try {
          closeFailure = await runEndpointCriticalSection((critical) => closeAndCleanOwnedEndpoint(
              deps.closeServer === undefined ? closeNativeServer : () => callAdapter(() => deps.closeServer!(server)),
              critical,
            ));
        } catch {
          await closeNativeServer().catch(() => undefined);
          await releaseUnixListenerBinding().catch(() => undefined);
          throw new Error('UNKNOWN_FAILURE: local IPC close failed');
        }
        if (closeFailure !== null) throw closeFailure;
      })();
      return closePromise;
    },
  };
}

export function createBrokerIpcClient(config: BrokerIpcClientConfigV4): BrokerIpcClientV4 {
  const deadline = config.requestDeadlineMs ?? 5_000;
  if (config.serverIdentityVerifier === undefined) throw new Error('AUTHENTICATION_FAILED: trusted server identity verifier is required');
  const platform = config.platform ?? process.platform;
  const expectedOwnerIdentity = platformOwnerIdentity(platform);
  let physicalBackend: UnixPhysicalPathBackendV4 | null = null;
  let endpointCoordinator: ReclamationCoordinatorV4 | null = null;
  if (platform !== 'win32') {
    physicalBackend = assertUnixPhysicalBackendV4(config.unixPhysicalPathBackend, config.allowInProcessPhysicalPathBackendForTests, platform);
    endpointCoordinator = config.endpointCoordinator ?? null;
    if (endpointCoordinator === null || endpointCoordinator.certification.kind !== 'native-cross-process' && !config.allowInProcessCoordinatorForTests) {
      throw new Error('AUTHENTICATION_FAILED: native endpoint coordinator is required');
    }
    if (endpointCoordinator.certification.identity.length === 0) throw new Error('AUTHENTICATION_FAILED: endpoint coordinator identity is invalid');
  }
  const acceptedRuns = new Map<string, string>();
  let closed = false;
  return {
    submit: async (command) => {
      if (closed) throw new Error('AUTHENTICATION_FAILED: IPC client is closed');
      let submittedCommand: Extract<BrokerCommandV4, { type: 'RUN_CODING_TASK' }>;
      try { submittedCommand = loadSubmittedCommand(command); }
      catch (error) { throw new Error(normalizedBoundaryMessage(error)); }
      const request: BrokerIpcRequestV4 = { token: config.token, command: submittedCommand };
      const frame = encodeFrame(request);
      let endpoint = config.endpoint;
      const submitOverSocket = (socket: Socket): Promise<BrokerReplyV4> => new Promise<BrokerReplyV4>((resolvePromise, reject) => {
        let buffer = Buffer.alloc(0);
        let expectedLength: number | null = null;
        const fail = (error: Error) => { socket.destroy(); reject(new Error(normalizedBoundaryMessage(error))); };
        socket.setTimeout(deadline, () => fail(new Error('INVALID_CONTRACT: request deadline exceeded')));
        socket.once('connect', () => {
          void callAdapter(() => config.serverIdentityVerifier!.verifyServer({ socket, endpoint, expected_owner_identity: expectedOwnerIdentity }))
            .then((proof) => {
              if (proof?.owner_identity !== expectedOwnerIdentity) return fail(new Error('AUTHENTICATION_FAILED: server ownership could not be established'));
              socket.write(frame);
            })
            .catch(() => fail(new Error('AUTHENTICATION_FAILED: server ownership could not be established')));
        });
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (expectedLength === null && buffer.length >= 4) {
            expectedLength = buffer.readUInt32BE(0);
            buffer = buffer.subarray(4);
            if (expectedLength > MAX_FRAME_BYTES_V4) return fail(new Error('INVALID_CONTRACT: response frame too large'));
          }
          if (expectedLength !== null && buffer.length > expectedLength) return fail(new Error('INVALID_CONTRACT: trailing response frame bytes'));
          if (expectedLength !== null && buffer.length === expectedLength) {
            let response: BrokerIpcResponseV4;
            try { response = loadBrokerIpcResponseV4(buffer.toString('utf8')); } catch (error) { return fail(error as Error); }
            socket.end();
            if (!response.ok || response.reply === undefined) {
              reject(new Error(normalizeBrokerResponseErrorV4(response.error)));
            }
            else {
              const priorRunId = acceptedRuns.get(submittedCommand.request.request_id);
              if (response.reply.request_id !== submittedCommand.request.request_id || (priorRunId !== undefined && priorRunId !== response.reply.run_id)) {
                return fail(new Error('UNKNOWN_FAILURE: broker response rejected'));
              }
              acceptedRuns.set(submittedCommand.request.request_id, response.reply.run_id);
              resolvePromise(response.reply);
            }
          }
        });
        socket.once('error', fail);
      });
      if (platform !== 'win32') {
        const configuredStateDirectory = config.stateDirectory ?? posix.dirname(config.endpoint);
        const requestedLocation = loadBrokerIpcLocationV4(configuredStateDirectory, config.endpoint, platform);
        const certified = await certifyUnixPhysicalPathV4(requestedLocation.stateDirectory, expectedOwnerIdentity, physicalBackend!);
        const location = loadBrokerIpcLocationV4(configuredStateDirectory, config.endpoint, platform, certified.operation_path);
        endpoint = location.endpoint;
        try {
          return await runUnixPhysicalCriticalSectionV4(certified, physicalBackend!, endpointCoordinator!, (critical) => critical.runSensitive(
            (capability) => capability.withConnectedBrokerSocket(config.connect, submitOverSocket),
          ));
        } catch (error) {
          throw new Error(normalizedBoundaryMessage(error));
        }
      }
      try { return submitOverSocket((config.connect ?? createConnection)(endpoint)); }
      catch { throw new Error('UNKNOWN_FAILURE: broker request failed'); }
    },
    close: async () => { closed = true; },
  };
}
