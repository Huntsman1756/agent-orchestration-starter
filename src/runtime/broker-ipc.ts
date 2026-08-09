import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
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
  unixPhysicalPathBackend?: UnixPhysicalPathBackendV4;
  allowInProcessPhysicalPathBackendForTests?: boolean;
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
    operation: (inspection: UnixPhysicalPathInspectionV4) => Promise<T>,
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
  if (relativeEndpoint.length === 0 || relativeEndpoint === '..' || relativeEndpoint.startsWith('../') || posix.isAbsolute(relativeEndpoint)) {
    throw new Error('AUTHENTICATION_FAILED: Unix socket must be inside owner-only state directory');
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
  runSensitive<T>(operation: () => Promise<T>): Promise<T>;
}

function physicalPathRejected(): never {
  throw new Error('AUTHENTICATION_FAILED: Unix physical state path verification failed');
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

function assertUnixPhysicalBackendV4(backend: UnixPhysicalPathBackendV4 | undefined, allowInProcessForTests: boolean | undefined): UnixPhysicalPathBackendV4 {
  if (backend === undefined || backend === null || typeof backend !== 'object') throw new Error('AUTHENTICATION_FAILED: certified Unix physical-path backend is required');
  const certification = backend.certification;
  if (certification === null || typeof certification !== 'object' || certification.kind !== 'native-physical-path' && certification.kind !== 'in-process-test') {
    throw new Error('AUTHENTICATION_FAILED: Unix physical-path backend certification is invalid');
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
    runSensitive: async <U>(sensitiveOperation: () => Promise<U>): Promise<U> => {
      let sensitiveOperationEntered = false;
      try {
        return await callAdapter(() => backend.withReprovedStateDirectory(
          {
            operation_path: certified.operation_path,
            expected_owner_identity: certified.expected_owner_identity,
            component_identities: certified.component_identities,
          },
          async (inspection) => {
            const observed = loadUnixPhysicalInspectionV4(inspection, certified.expected_owner_identity);
            if (!samePhysicalComponentIdentitiesV4(certified.component_identities, observed.components)) physicalPathRejected();
            sensitiveOperationEntered = true;
            return sensitiveOperation();
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
  deps: { metadata(endpoint: string): Promise<UnixSocketMetadataV4 | null>; remove(endpoint: string): Promise<void> },
  coordinator: ReclamationCoordinatorV4,
  security: UnixPhysicalPathSecurityV4,
): Promise<void> {
  try {
    if (coordinator.certification.kind !== 'native-cross-process' && !security.allowInProcessCoordinatorForTests) {
      throw new Error('AUTHENTICATION_FAILED: native endpoint coordinator is required');
    }
    if (coordinator.certification.identity.length === 0) throw new Error('AUTHENTICATION_FAILED: endpoint coordinator identity is invalid');
    const backend = assertUnixPhysicalBackendV4(security.unixPhysicalPathBackend, security.allowInProcessPhysicalPathBackendForTests);
    const requestedLocation = loadBrokerIpcLocationV4(security.stateDirectory, endpoint, 'linux');
    const certified = await certifyUnixPhysicalPathV4(requestedLocation.stateDirectory, security.expectedOwnerIdentity, backend);
    const location = loadBrokerIpcLocationV4(security.stateDirectory, endpoint, 'linux', certified.operation_path);
    await runUnixPhysicalCriticalSectionV4(certified, backend, coordinator, (critical) => critical.runSensitive(
      () => removeOwnedUnixEndpointInsideCoordinatorV4(location.endpoint, ownedObjectIdentity, deps),
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
  const expectedOwnerIdentity = platformOwnerIdentity(platform);
  const requestedLocation = loadBrokerIpcLocationV4(deps.stateDirectory, deps.endpoint, platform);
  let physicalBackend: UnixPhysicalPathBackendV4 | null = null;
  let certifiedUnixPath: CertifiedUnixPhysicalPathV4 | null = null;
  if (platform !== 'win32') {
    physicalBackend = assertUnixPhysicalBackendV4(deps.unixPhysicalPathBackend, deps.allowInProcessPhysicalPathBackendForTests);
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
  const endpointCoordinatorKey = certifiedUnixPath?.coordinator_key ?? `ipc-endpoint:${endpoint}`;
  const runEndpointCriticalSection = async <T>(operation: (critical: UnixPhysicalCriticalSectionV4) => Promise<T>): Promise<T> => {
    if (platform !== 'win32') {
      return runUnixPhysicalCriticalSectionV4(certifiedUnixPath!, physicalBackend!, deps.endpointCoordinator, operation);
    }
    return callAdapter(() => deps.endpointCoordinator.runExclusive(endpointCoordinatorKey, () => operation({
      runSensitive: <U>(sensitiveOperation: () => Promise<U>) => callAdapter(sensitiveOperation),
    })));
  };
  let ownedUnixEndpointIdentity: string | null = null;
  const closeNativeServer = async (): Promise<void> => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error === undefined ? resolveClose() : rejectClose(error)));
  };
  const closeAndCleanOwnedEndpoint = async (closeOperation: () => Promise<void>, critical: UnixPhysicalCriticalSectionV4): Promise<Error | null> => {
    let failure: Error | null = null;
    try {
      await critical.runSensitive(closeOperation);
    } catch {
      failure = new Error('UNKNOWN_FAILURE: local IPC close failed');
      await critical.runSensitive(closeNativeServer).catch(() => undefined);
    }
    if (platform !== 'win32' && ownedUnixEndpointIdentity !== null && !server.listening) {
      try {
        await critical.runSensitive(() => removeOwnedUnixEndpointInsideCoordinatorV4(endpoint, ownedUnixEndpointIdentity!));
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
        token = await critical.runSensitive(() => (deps.loadToken ?? loadOrCreateToken)(location.stateDirectory, platform)).catch(() => { throw new Error('AUTHENTICATION_FAILED: broker token storage failed'); });
        for (const [path, kind] of [[location.stateDirectory, 'state-directory'], [posix.join(location.stateDirectory, TOKEN_FILE_V4), 'token-file']] as const) {
          const proof = await critical.runSensitive(() => callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path, kind, expected_owner_identity: expectedOwnerIdentity }))).catch(() => null);
          if (proof?.owner_identity !== expectedOwnerIdentity) throw new Error(`AUTHENTICATION_FAILED: native ${kind} ownership/ACL proof failed`);
        }
        await critical.runSensitive(() => reclaimUnixSocketV4(endpoint, expectedOwnerIdentity));
      }
      await critical.runSensitive(() => listen(server, endpoint)).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC startup failed'); });
      if (platform !== 'win32') {
        ownedUnixEndpointIdentity = await critical.runSensitive(() => secureUnixEndpointV4(endpoint, expectedOwnerIdentity, {
          metadata: defaultUnixMetadata,
          secure: async (path) => chmod(path, 0o600),
          verify: async (path, owner) => callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path, kind: 'endpoint', expected_owner_identity: owner })),
          close: closeNativeServer,
          remove: unlink,
        }));
      } else try {
        const endpointProof = await critical.runSensitive(() => callAdapter(() => deps.platformVerifier!.verifyOwnerOnlyPath({ path: endpoint, kind: 'endpoint', expected_owner_identity: expectedOwnerIdentity }))).catch(() => null);
        if (endpointProof?.owner_identity !== expectedOwnerIdentity) throw new Error('AUTHENTICATION_FAILED: native endpoint ownership/ACL proof failed');
      } catch (error) {
        await critical.runSensitive(closeNativeServer).catch(() => { throw new Error('UNKNOWN_FAILURE: local IPC close failed'); });
        throw new Error(normalizedBoundaryMessage(error));
      }
    });
  } catch (error) {
    if (server.listening || ownedUnixEndpointIdentity !== null) {
      let cleanupEntered = false;
      try {
        await runEndpointCriticalSection(async (critical) => {
          cleanupEntered = true;
          await closeAndCleanOwnedEndpoint(closeNativeServer, critical);
        });
      } catch {
        if (platform === 'win32' && !cleanupEntered) await closeNativeServer().catch(() => undefined);
      }
    }
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
    physicalBackend = assertUnixPhysicalBackendV4(config.unixPhysicalPathBackend, config.allowInProcessPhysicalPathBackendForTests);
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
      let socket: Socket;
      if (platform !== 'win32') {
        const configuredStateDirectory = config.stateDirectory ?? posix.dirname(config.endpoint);
        const requestedLocation = loadBrokerIpcLocationV4(configuredStateDirectory, config.endpoint, platform);
        const certified = await certifyUnixPhysicalPathV4(requestedLocation.stateDirectory, expectedOwnerIdentity, physicalBackend!);
        const location = loadBrokerIpcLocationV4(configuredStateDirectory, config.endpoint, platform, certified.operation_path);
        endpoint = location.endpoint;
        try {
          socket = await runUnixPhysicalCriticalSectionV4(certified, physicalBackend!, endpointCoordinator!, (critical) => critical.runSensitive(async () => (
            config.connect ?? createConnection
          )(endpoint)));
        } catch (error) {
          throw new Error(normalizedBoundaryMessage(error));
        }
      } else {
        try { socket = (config.connect ?? createConnection)(endpoint); }
        catch { throw new Error('UNKNOWN_FAILURE: broker request failed'); }
      }
      return new Promise<BrokerReplyV4>((resolvePromise, reject) => {
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
    },
    close: async () => { closed = true; },
  };
}
