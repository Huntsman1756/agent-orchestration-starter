import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { canonicalJsonV4 } from './canonical.js';
import type { BrokerDaemonV4, BrokerReplyV4 } from './broker-daemon.js';
import { RUNTIME_FAILURE_CODES_V4 } from './failures.js';
import { loadRuntimeTaskRequestV4 } from './load.js';
import type { BrokerCommandV4 } from './run-state.js';

const MAX_FRAME_BYTES_V4 = 1_048_576;
const TOKEN_FILE_V4 = 'broker.token';

export interface BrokerIpcRequestV4 {
  token: string;
  command: BrokerCommandV4;
}

interface BrokerIpcResponseV4 {
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
}

export interface BrokerIpcPlatformVerifierV4 {
  verifyOwnerOnlyPath(input: { path: string; kind: 'state-directory' | 'token-file' | 'endpoint'; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
  verifyPeer(input: { socket?: Socket; endpoint: string; expected_owner_identity: string }): Promise<{ owner_identity: string } | null>;
}

export interface UnixSocketMetadataV4 { kind: 'socket' | 'other'; owner_identity: string; owner_only: boolean }
export interface UnixSocketReclaimDependenciesV4 {
  metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>;
  probe(endpoint: string): Promise<'live' | 'stale' | 'unknown'>;
  remove(endpoint: string): Promise<void>;
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
}

export interface BrokerIpcClientV4 {
  submit(command: BrokerCommandV4): Promise<BrokerReplyV4>;
  close(): Promise<void>;
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
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

function loadSubmittedCommand(value: unknown): BrokerCommandV4 {
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

function normalizedBoundaryMessage(error: unknown): string {
  if (error instanceof Error) {
    const match = /^([A-Z_]+):\s*(.*)$/s.exec(error.message);
    if (match !== null && RUNTIME_FAILURE_CODES_V4.includes(match[1] as typeof RUNTIME_FAILURE_CODES_V4[number])) {
      const message = match[2].replace(/[\r\n\0]/g, ' ').slice(0, 512) || 'broker request failed';
      return `${match[1]}: ${message}`;
    }
  }
  return 'UNKNOWN_FAILURE: broker request failed';
}

async function defaultUnixMetadata(endpoint: string): Promise<UnixSocketMetadataV4 | null> {
  const metadata = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata === null) return null;
  return { kind: metadata.isSocket() ? 'socket' : 'other', owner_identity: `uid:${metadata.uid}`, owner_only: (metadata.mode & 0o077) === 0 };
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
  deps: UnixSocketReclaimDependenciesV4 = { metadata: defaultUnixMetadata, probe: defaultUnixProbe, remove: unlink },
): Promise<void> {
  const metadata = await deps.metadata(endpoint);
  if (metadata === null) return;
  if (metadata.kind !== 'socket' || metadata.owner_identity !== expectedOwnerIdentity || !metadata.owner_only) {
    throw new Error('AUTHENTICATION_FAILED: existing broker endpoint ownership or mode is invalid');
  }
  const status = await deps.probe(endpoint).catch(() => 'unknown' as const);
  if (status !== 'stale') throw new Error('REPOSITORY_BUSY: broker endpoint is live or unverifiable');
  await deps.remove(endpoint);
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
  const expectedOwnerIdentity = platformOwnerIdentity(platform);
  await verifyOwnerOnlyState(deps.stateDirectory, platform);
  const token = await loadOrCreateToken(deps.stateDirectory, platform);
  const endpoint = deps.endpoint ?? defaultBrokerEndpointV4(deps.stateDirectory, platform);
  if (platform !== 'win32') {
    const stateRoot = `${resolve(deps.stateDirectory)}${process.platform === 'win32' ? '\\' : '/'}`;
    if (!resolve(endpoint).startsWith(stateRoot)) throw new Error('AUTHENTICATION_FAILED: Unix socket must be inside owner-only state directory');
    await reclaimUnixSocketV4(endpoint, expectedOwnerIdentity);
  }
  for (const [path, kind] of [[deps.stateDirectory, 'state-directory'], [join(deps.stateDirectory, TOKEN_FILE_V4), 'token-file']] as const) {
    const proof = await deps.platformVerifier.verifyOwnerOnlyPath({ path, kind, expected_owner_identity: expectedOwnerIdentity }).catch(() => null);
    if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error(`AUTHENTICATION_FAILED: native ${kind} ownership/ACL proof failed`);
  }

  const exchange = async (payload: Buffer, socket?: Socket): Promise<BrokerIpcResponseV4> => {
    try {
      if (payload.length > MAX_FRAME_BYTES_V4) invalid('frame too large');
      const peer = await deps.platformVerifier!.verifyPeer({ socket, endpoint, expected_owner_identity: expectedOwnerIdentity });
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
      return { ok: true, reply: await deps.daemon.submit(command) };
    } catch (error) {
      return { ok: false, error: normalizedBoundaryMessage(error) };
    }
  };

  const server = createServer((socket) => {
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
          socket.end(encodeFrame({ ok: false, error: 'INVALID_CONTRACT: frame too large' }));
          return;
        }
      }
      if (expectedLength !== null && buffer.length >= expectedLength) {
        handled = true;
        if (buffer.length !== expectedLength) {
          socket.end(encodeFrame({ ok: false, error: 'INVALID_CONTRACT: trailing frame bytes' }));
          return;
        }
        void exchange(buffer, socket).then((response) => socket.end(encodeFrame(response)));
      }
    });
    socket.on('error', () => socket.destroy());
  });
  await listen(server, endpoint).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC startup failed'); });
  if (platform !== 'win32') await chmod(endpoint, 0o600);
  const endpointProof = await deps.platformVerifier.verifyOwnerOnlyPath({ path: endpoint, kind: 'endpoint', expected_owner_identity: expectedOwnerIdentity }).catch(() => null);
  if (endpointProof?.owner_identity !== expectedOwnerIdentity) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (platform !== 'win32') await unlink(endpoint).catch(() => undefined);
    throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
  }

  let closed = false;
  return {
    endpoint,
    exchangeFrameForTest: (payload) => exchange(payload),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
      if (platform !== 'win32') await unlink(endpoint).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}

export function createBrokerIpcClient(config: BrokerIpcClientConfigV4): BrokerIpcClientV4 {
  const deadline = config.requestDeadlineMs ?? 5_000;
  let closed = false;
  return {
    submit: async (command) => {
      if (closed) throw new Error('AUTHENTICATION_FAILED: IPC client is closed');
      const request: BrokerIpcRequestV4 = { token: config.token, command };
      const frame = encodeFrame(request);
      return new Promise<BrokerReplyV4>((resolvePromise, reject) => {
        const socket = createConnection(config.endpoint);
        let buffer = Buffer.alloc(0);
        let expectedLength: number | null = null;
        const fail = (error: Error) => { socket.destroy(); reject(new Error(normalizedBoundaryMessage(error))); };
        socket.setTimeout(deadline, () => fail(new Error('INVALID_CONTRACT: request deadline exceeded')));
        socket.once('connect', () => socket.write(frame));
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (expectedLength === null && buffer.length >= 4) {
            expectedLength = buffer.readUInt32BE(0);
            buffer = buffer.subarray(4);
            if (expectedLength > MAX_FRAME_BYTES_V4) return fail(new Error('INVALID_CONTRACT: response frame too large'));
          }
          if (expectedLength !== null && buffer.length === expectedLength) {
            let response: BrokerIpcResponseV4;
            try { response = JSON.parse(buffer.toString('utf8')) as BrokerIpcResponseV4; } catch { return fail(new Error('INVALID_CONTRACT: malformed response')); }
            socket.end();
            if (!response.ok || response.reply === undefined) reject(new Error(response.error ?? 'UNKNOWN_FAILURE: empty broker response'));
            else resolvePromise(response.reply);
          }
        });
        socket.once('error', fail);
      });
    },
    close: async () => { closed = true; },
  };
}
