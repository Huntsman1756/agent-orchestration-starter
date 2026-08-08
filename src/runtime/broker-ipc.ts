import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { BrokerDaemonV4, BrokerReplyV4 } from './broker-daemon.js';
import { RUNTIME_FAILURE_CODES_V4, type RuntimeFailureCodeV4 } from './failures.js';
import type { ReclamationCoordinatorV4 } from './repository-lock.js';
import { loadRuntimeResultV4, loadRuntimeTaskRequestV4 } from './load.js';
import type { BrokerCommandV4 } from './run-state.js';

const MAX_FRAME_BYTES_V4 = 1_048_576;
const TOKEN_FILE_V4 = 'broker.token';
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
}

export interface BrokerIpcPlatformVerifierV4 {
  verifyOwnerOnlyPath(input: { path: string; kind: 'state-directory' | 'token-file' | 'endpoint'; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
  verifyPeer(input: { socket?: Socket; endpoint: string; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
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
  token: string;
  requestDeadlineMs?: number;
  platform?: NodeJS.Platform;
  serverIdentityVerifier?: BrokerIpcServerIdentityVerifierV4;
  connect?: (endpoint: string) => Socket;
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
  deps: { metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>; remove(endpoint: string): Promise<void> },
  coordinator: ReclamationCoordinatorV4,
): Promise<void> {
  try {
    await callAdapter(() => coordinator.runExclusive(
      `ipc-endpoint:${endpoint}`,
      () => removeOwnedUnixEndpointInsideCoordinatorV4(endpoint, ownedObjectIdentity, deps),
    ));
  } catch {
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
  const expectedOwnerIdentity = platformOwnerIdentity(platform);
  await verifyOwnerOnlyState(deps.stateDirectory, platform).catch((error) => {
    if (error instanceof Error && error.message.startsWith('AUTHENTICATION_FAILED:')) throw error;
    throw new Error('AUTHENTICATION_FAILED: broker state verification failed');
  });
  const token = await callAdapter(() => (deps.loadToken ?? loadOrCreateToken)(deps.stateDirectory, platform)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker token storage failed'); });
  const endpoint = deps.endpoint ?? defaultBrokerEndpointV4(deps.stateDirectory, platform);
  if (platform !== 'win32') {
    const stateRoot = `${resolve(deps.stateDirectory)}${process.platform === 'win32' ? '\\' : '/'}`;
    if (!resolve(endpoint).startsWith(stateRoot)) throw new Error('AUTHENTICATION_FAILED: Unix socket must be inside owner-only state directory');
  }
  for (const [path, kind] of [[deps.stateDirectory, 'state-directory'], [join(deps.stateDirectory, TOKEN_FILE_V4), 'token-file']] as const) {
    const proof = await callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path, kind, expected_owner_identity: expectedOwnerIdentity })).catch(() => null);
    if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error(`AUTHENTICATION_FAILED: native ${kind} ownership/ACL proof failed`);
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
    server = createServer((socket) => {
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
  const endpointCoordinatorKey = `ipc-endpoint:${endpoint}`;
  let ownedUnixEndpointIdentity: string | null = null;
  const closeNativeServer = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  };
  const closeAndCleanOwnedEndpoint = async (closeOperation: () => Promise<void>): Promise<Error | null> => {
    let failure: Error | null = null;
    try {
      await callAdapter(closeOperation);
    } catch {
      failure = new Error('UNKNOWN_FAILURE: local IPC close failed');
      await closeNativeServer().catch(() => undefined);
    }
    if (platform !== 'win32' && ownedUnixEndpointIdentity !== null && !server.listening) {
      try {
        await removeOwnedUnixEndpointInsideCoordinatorV4(endpoint, ownedUnixEndpointIdentity);
        ownedUnixEndpointIdentity = null;
      } catch {
        failure = new Error('UNKNOWN_FAILURE: local IPC endpoint cleanup failed');
      }
    }
    return failure;
  };
  try {
    await callAdapter(() => deps.endpointCoordinator.runExclusive(endpointCoordinatorKey, async () => {
      if (platform !== 'win32') await reclaimUnixSocketV4(endpoint, expectedOwnerIdentity);
      await listen(server, endpoint).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC startup failed'); });
      if (platform !== 'win32') {
        ownedUnixEndpointIdentity = await secureUnixEndpointV4(endpoint, expectedOwnerIdentity, {
          metadata: defaultUnixMetadata,
          secure: async (path) => chmod(path, 0o600),
          verify: async (path, owner) => callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path, kind: 'endpoint', expected_owner_identity: owner })),
          close: closeNativeServer,
          remove: unlink,
        });
      } else try {
        const endpointProof = await callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path: endpoint, kind: 'endpoint', expected_owner_identity: expectedOwnerIdentity })).catch(() => null);
        if (endpointProof?.owner_identity !== expectedOwnerIdentity) throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
      } catch (error) {
        await closeNativeServer().catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC close failed'); });
        throw new Error(normalizedBoundaryMessage(error));
      }
    }));
  } catch (error) {
    if (server.listening || ownedUnixEndpointIdentity !== null) {
      let cleanupEntered = false;
      try {
        await callAdapter(() => deps.endpointCoordinator.runExclusive(endpointCoordinatorKey, async () => {
          cleanupEntered = true;
          await closeAndCleanOwnedEndpoint(closeNativeServer);
        }));
      } catch {
        if (!cleanupEntered) await closeNativeServer().catch(() => undefined);
      }
    }
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
          closeFailure = await callAdapter(() => deps.endpointCoordinator.runExclusive(
            endpointCoordinatorKey,
            () => closeAndCleanOwnedEndpoint(
              deps.closeServer === undefined ? closeNativeServer : () => callAdapter(() => deps.closeServer!(server)),
            ),
          ));
        } catch {
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
  const expectedOwnerIdentity = platformOwnerIdentity(config.platform ?? process.platform);
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
      return new Promise<BrokerReplyV4>((resolvePromise, reject) => {
        let socket: Socket;
        try { socket = (config.connect ?? createConnection)(config.endpoint); }
        catch { reject(new Error('UNKNOWN_FAILURE: broker request failed')); return; }
        let buffer = Buffer.alloc(0);
        let expectedLength: number | null = null;
        const fail = (error: Error) => { socket.destroy(); reject(new Error(normalizedBoundaryMessage(error))); };
        socket.setTimeout(deadline, () => fail(new Error('INVALID_CONTRACT: request deadline exceeded')));
        socket.once('connect', () => {
          void callAdapter(() => config.serverIdentityVerifier!.verifyServer({ socket, endpoint: config.endpoint, expected_owner_identity: expectedOwnerIdentity }))
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
    },
    close: async () => { closed = true; },
  };
}
