import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer, Server, Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  createBrokerIpcClient,
  createBrokerIpcServer,
  loadBrokerIpcResponseV4,
  removeOwnedUnixEndpointV4,
  reclaimUnixSocketV4,
  secureUnixEndpointV4,
  normalizeBrokerResponseErrorV4,
  type BrokerIpcRequestV4,
  type BrokerIpcPlatformVerifierV4,
  type BrokerIpcServerIdentityVerifierV4,
  type UnixBrokerListenerBindingV4,
  type UnixPhysicalDirectoryCapabilityV4,
  type UnixPhysicalPathBackendV4,
  type UnixPhysicalPathInspectionV4,
} from '../src/runtime/broker-ipc.js';
import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';
import { createBrokerDaemon, type BrokerDaemonV4, type BrokerReplyV4 } from '../src/runtime/broker-daemon.js';
import type { BrokerCommandV4 } from '../src/runtime/run-state.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import { reopenJournalV4 } from '../src/runtime/journal.js';
import { createInProcessReclamationCoordinatorV4, type ReclamationCoordinatorV4 } from '../src/runtime/repository-lock.js';
import { validRepositoryPolicy, validRuntimeProfile, validRuntimeResult, validTaskRequest } from './runtime-contracts.test.js';

const endpointCoordinator = createInProcessReclamationCoordinatorV4('ipc-test');

type LinuxNativePhysicalPathFactoryV4 = () => UnixPhysicalPathBackendV4;

const LINUX_NATIVE_RENAME_HELPER_NAME_FOR_TEST = 'agent-orchestration-renameat2';

function linuxNativeRenameHelperPathForTest(): string {
  return join(process.cwd(), 'dist', 'native', `linux-${process.arch}`, LINUX_NATIVE_RENAME_HELPER_NAME_FOR_TEST);
}

function linuxBrokerQuarantineSlotNameForTest(index: number): string {
  return `.broker.sock.quarantine-slot-${String(index).padStart(2, '0')}`;
}

async function linuxNativePhysicalPathBackendForTest(): Promise<UnixPhysicalPathBackendV4> {
  const runtimeModule = (await import('../src/runtime/broker-ipc.js')) as unknown as {
    createLinuxNativeUnixPhysicalPathBackendV4?: LinuxNativePhysicalPathFactoryV4;
  };
  assert.equal(
    typeof runtimeModule.createLinuxNativeUnixPhysicalPathBackendV4,
    'function',
    'production must provide the branded Linux physical-path backend',
  );
  return runtimeModule.createLinuxNativeUnixPhysicalPathBackendV4!();
}

async function linuxSecureDirectoryForTest(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(homedir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

function currentUnixOwnerIdentityForTest(): string {
  assert.equal(typeof process.getuid, 'function');
  return `uid:${process.getuid!()}`;
}

function waitForChildIpcMessageForTest(child: ChildProcess, expectedKind: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== 'object' || (message as { kind?: unknown }).kind !== expectedKind) return;
      cleanup();
      resolvePromise();
    };
    const onFailure = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`replacement process exited before ${expectedKind}: ${String(code)} ${String(signal)}`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('error', onFailure);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('error', onFailure);
    child.once('exit', onExit);
  });
}

function runExecutableForTest(executable: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${executable} failed (${String(code)}, ${String(signal)}): ${Buffer.concat(stderr).toString('utf8')} ${Buffer.concat(stdout).toString('utf8')}`,
        ),
      );
    });
  });
}

function minimalDaemonForIpcTest(submitted: BrokerCommandV4[] = []): BrokerDaemonV4 {
  const status = {
    ...validRuntimeResult(),
    state: 'READY_FOR_EXECUTOR',
    attempts: [],
    validation_results: [],
    head_sha: null,
    review_attestation_hash: null,
    commit_sha: null,
  } as RuntimeResultV4;
  return {
    submit: async (command) => {
      submitted.push(command);
      return {
        request_id: command.type === 'RUN_CODING_TASK' ? command.request.request_id : 'req_unknown',
        run_id: status.run_id,
        state: status.state,
        status_token: hashCanonicalV4({
          run_id: status.run_id,
          state: status.state,
          artifact_manifest_hash: status.artifact_manifest_hash,
        }),
      };
    },
    status: async () => status,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  };
}

function physicalInspection(
  operationPath: string,
  expectedOwnerIdentity: string,
  overrides: Partial<UnixPhysicalPathInspectionV4> = {},
): UnixPhysicalPathInspectionV4 {
  return {
    operation_path: operationPath,
    chain_complete: true,
    components: [
      {
        kind: 'directory',
        object_identity: 'dev:1:ino:1',
        owner_identity: 'uid:0',
        owner_trusted: true,
        writable_by_untrusted: false,
        owner_only: false,
      },
      {
        kind: 'directory',
        object_identity: 'dev:1:ino:2',
        owner_identity: 'uid:0',
        owner_trusted: true,
        writable_by_untrusted: false,
        owner_only: false,
      },
      {
        kind: 'directory',
        object_identity: 'dev:1:ino:3',
        owner_identity: expectedOwnerIdentity,
        owner_trusted: true,
        writable_by_untrusted: false,
        owner_only: true,
      },
    ],
    ...overrides,
  };
}

function physicalPathBackend(
  inspect: (input: { state_directory: string; expected_owner_identity: string }) => Promise<UnixPhysicalPathInspectionV4>,
  identity = 'physical-path-test',
): UnixPhysicalPathBackendV4 {
  const capability = async (input: {
    operation_path: string;
    expected_owner_identity: string;
  }): Promise<UnixPhysicalDirectoryCapabilityV4> => {
    const inspection = await inspect({ state_directory: input.operation_path, expected_owner_identity: input.expected_owner_identity });
    const endpoint = posix.join(input.operation_path, 'broker.sock');
    return {
      inspection,
      loadToken: async ({ platform, loadToken }) => {
        if (loadToken !== undefined) return loadToken(input.operation_path, platform);
        const tokenPath = posix.join(input.operation_path, 'broker.token');
        const token = 'a'.repeat(64);
        await writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        return (await readFile(tokenPath, 'utf8')).trim();
      },
      verifyOwnerOnlyPath: ({ kind, expected_owner_identity, verifier }) =>
        verifier.verifyOwnerOnlyPath({
          path: kind === 'state-directory' ? input.operation_path : posix.join(input.operation_path, 'broker.token'),
          kind,
          expected_owner_identity,
        }),
      reclaimBrokerSocket: (expectedOwnerIdentity) => reclaimUnixSocketV4(endpoint, expectedOwnerIdentity),
      listenBrokerSocket: async (server) => {
        await listenForTest(server, endpoint);
        return { kind: 'unix-broker-listener-binding', server, release: async () => {} } as UnixBrokerListenerBindingV4;
      },
      publishBrokerSocket: ({ expected_owner_identity, verifier }) =>
        secureUnixEndpointV4(endpoint, expected_owner_identity, {
          metadata: async (path) => {
            const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            return metadata === null
              ? null
              : {
                  kind: metadata.isSocket() ? 'socket' : 'other',
                  owner_identity: `uid:${metadata.uid}`,
                  owner_only: (metadata.mode & 0o077) === 0,
                  object_identity: `${metadata.dev}:${metadata.ino}`,
                };
          },
          secure: async (path) => chmod(path, 0o600),
          verify: async (path, owner) => verifier.verifyOwnerOnlyPath({ path, kind: 'endpoint', expected_owner_identity: owner }),
          close: async () => {},
          remove: unlink,
        }),
      withConnectedBrokerSocket: async (connect, operation) => operation((connect ?? createConnection)(endpoint)),
      removeOwnedBrokerSocket: async (ownedObjectIdentity, deps) => {
        if (deps === undefined) {
          const metadata = await lstat(endpoint).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (metadata !== null && `${metadata.dev}:${metadata.ino}` === ownedObjectIdentity) await unlink(endpoint);
          return;
        }
        const current = await deps.metadata(endpoint);
        if (current === null || current.kind !== 'socket' || current.object_identity !== ownedObjectIdentity) return;
        if (deps.rename === undefined || deps.restoreQuarantine === undefined) {
          await deps.remove(endpoint);
          return;
        }
        const quarantine = `${endpoint}.quarantine-${process.pid}-${Date.now()}`;
        await deps.rename(endpoint, quarantine);
        const quarantined = await deps.metadata(quarantine);
        if (quarantined?.object_identity !== ownedObjectIdentity) {
          await deps.restoreQuarantine(quarantine, endpoint);
          throw new Error('REPOSITORY_BUSY: broker endpoint changed during quarantine');
        }
        await deps.remove(quarantine);
      },
    };
  };
  return {
    certification: { kind: 'in-process-test', identity },
    certifyStateDirectory: inspect,
    withReprovedStateDirectory: async (input, operation) => operation(await capability(input)),
  };
}

function physicalCleanupSecurity(stateDirectory: string) {
  return {
    stateDirectory,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) =>
      physicalInspection(state_directory, expected_owner_identity),
    ),
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  };
}

function unixPhysicalServerTestDeps() {
  return {
    unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) =>
      physicalInspection(state_directory, expected_owner_identity),
    ),
    allowInProcessPhysicalPathBackendForTests: true,
  };
}

function unixPhysicalClientTestDeps(stateDirectory: string) {
  return {
    stateDirectory,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  };
}

function frameForTest(value: unknown): Buffer {
  const body = Buffer.from(canonicalJsonV4(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function listenForTest(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
}

async function closeForTest(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function activeServersForTest(): Server[] {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter((handle): handle is Server => handle instanceof Server);
}

async function linuxChildPidsForTest(): Promise<string[]> {
  const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim();
  return children.length === 0 ? [] : children.split(/\s+/).sort();
}

function activeChildProcessHandleCountForTest(): number {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  return handles.filter(
    (handle) =>
      typeof handle === 'object' &&
      handle !== null &&
      (handle as { constructor?: { name?: unknown } }).constructor?.name === 'ChildProcess',
  ).length;
}

async function connectionOutcomeForTest(endpoint: string): Promise<'connected' | 'rejected'> {
  return new Promise<'connected' | 'rejected'>((resolveOutcome) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      socket.destroy();
      resolveOutcome('connected');
    });
    socket.once('error', () => {
      socket.destroy();
      resolveOutcome('rejected');
    });
  });
}

function deadlineOutcomeForTest<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ kind: 'settled'; value: T } | { kind: 'timeout' }> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    const timeout = setTimeout(() => resolveOutcome({ kind: 'timeout' }), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolveOutcome({ kind: 'settled', value });
      },
      (error) => {
        clearTimeout(timeout);
        rejectOutcome(error);
      },
    );
  });
}

function synchronouslyConnectingSocketForTest(): Socket {
  const socket = new Socket();
  const once = socket.once.bind(socket);
  let connectScheduled = false;
  socket.once = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = once(event, listener);
    if (event === 'connect' && !connectScheduled) {
      connectScheduled = true;
      queueMicrotask(() => {
        try {
          socket.emit('connect');
        } catch (error) {
          socket.emit('error', error);
        }
      });
    }
    return result;
  }) as Socket['once'];
  return socket;
}

async function ipcFixture(options: { controlPlane?: boolean } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\runner-v4-ipc-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
      : join(stateDirectory, 'broker.sock');
  const submitted: BrokerCommandV4[] = [];
  const controls: string[] = [];
  const controlCommandIds: string[] = [];
  const status = {
    ...validRuntimeResult(),
    state: 'READY_FOR_EXECUTOR',
    attempts: [],
    validation_results: [],
    head_sha: null,
    review_attestation_hash: null,
    commit_sha: null,
  } as RuntimeResultV4;
  const daemon: BrokerDaemonV4 = {
    submit: async (command) => {
      submitted.push(command);
      return {
        request_id: command.type === 'RUN_CODING_TASK' ? command.request.request_id : 'req_unknown',
        run_id: status.run_id,
        state: status.state,
        status_token: hashCanonicalV4({
          run_id: status.run_id,
          state: status.state,
          artifact_manifest_hash: status.artifact_manifest_hash,
        }),
      };
    },
    status: async () => status,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  };
  const platformVerifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const server = await createBrokerIpcServer({
    daemon,
    ...(options.controlPlane === false
      ? {}
      : {
          controlPlane: {
            repair: async (input) => {
              controlCommandIds.push(input.command_id);
              controls.push(`repair:${input.run_id}:${input.findings[0]!.id}`);
              return {
                request_id: status.request_id,
                run_id: status.run_id,
                state: status.state,
                status_token: hashCanonicalV4({
                  run_id: status.run_id,
                  state: status.state,
                  artifact_manifest_hash: status.artifact_manifest_hash,
                }),
              };
            },
            finalize: async (input) => {
              controlCommandIds.push(input.command_id);
              controls.push(`finalize:${input.run_id}`);
              return {
                request_id: status.request_id,
                run_id: status.run_id,
                state: status.state,
                status_token: hashCanonicalV4({
                  run_id: status.run_id,
                  state: status.state,
                  artifact_manifest_hash: status.artifact_manifest_hash,
                }),
              };
            },
            abort: async (input) => {
              controlCommandIds.push(input.command_id);
              controls.push(`abort:${input.run_id}`);
              return {
                request_id: status.request_id,
                run_id: status.run_id,
                state: status.state,
                status_token: hashCanonicalV4({
                  run_id: status.run_id,
                  state: status.state,
                  artifact_manifest_hash: status.artifact_manifest_hash,
                }),
              };
            },
          },
        }),
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    requestDeadlineMs: 1_000,
    ...unixPhysicalServerTestDeps(),
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
  return { stateDirectory, submitted, controls, controlCommandIds, server, token };
}

function request(token: string): BrokerIpcRequestV4 {
  return { token, command: { type: 'RUN_CODING_TASK', command_id: 'command-run', request: validTaskRequest() as RuntimeTaskRequestV4 } };
}

function clientVerifier(endpoint: string): BrokerIpcServerIdentityVerifierV4 {
  return {
    verifyServer: async (input) =>
      input.endpoint === endpoint && input.expected_owner_identity.length > 4 ? { owner_identity: input.expected_owner_identity } : null,
  };
}

test('round-trips an authenticated canonical request over a length-prefixed frame', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({
    endpoint: fixture.server.endpoint,
    token: fixture.token,
    requestDeadlineMs: 1_000,
    platform: process.platform,
    serverIdentityVerifier: clientVerifier(fixture.server.endpoint),
    ...unixPhysicalClientTestDeps(fixture.stateDirectory),
  });

  const reply = await client.submit(request(fixture.token).command);

  assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(fixture.submitted.length, 1);
  await client.close();
  await fixture.server.close();
});

test('authenticates status, repair, finalize, and abort over the same bounded control plane', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({
    endpoint: fixture.server.endpoint,
    token: fixture.token,
    requestDeadlineMs: 1_000,
    platform: process.platform,
    serverIdentityVerifier: clientVerifier(fixture.server.endpoint),
    ...unixPhysicalClientTestDeps(fixture.stateDirectory),
  });
  const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';

  assert.equal((await client.status(runId)).run_id, runId);
  const repair = { run_id: runId, findings: [{ id: 'finding-1', evidence_hash: 'a'.repeat(64) }] };
  assert.equal((await client.repair(repair)).run_id, runId);
  assert.equal((await client.repair(repair)).run_id, runId);
  assert.equal((await client.finalize(runId)).run_id, runId);
  assert.equal((await client.abort(runId)).run_id, runId);
  assert.deepEqual(fixture.controls, [`repair:${runId}:finding-1`, `repair:${runId}:finding-1`, `finalize:${runId}`, `abort:${runId}`]);
  assert.equal(fixture.controlCommandIds[0], fixture.controlCommandIds[1]);
  assert.equal(fixture.submitted.length, 0);

  await client.close();
  await fixture.server.close();
});

test('rejects malformed control requests and missing mutating control composition', async () => {
  const fixture = await ipcFixture();
  const malformed = Buffer.from(
    canonicalJsonV4({
      token: fixture.token,
      command: { type: 'REPAIR_CODING_TASK', command_id: 'repair-1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', findings: [] },
    }),
    'utf8',
  );
  assert.equal((await fixture.server.exchangeFrameForTest(malformed)).error, 'INVALID_CONTRACT: request contract rejected');
  await fixture.server.close();

  const withoutControl = await ipcFixture({ controlPlane: false });
  const controlPayload = Buffer.from(
    canonicalJsonV4({
      token: withoutControl.token,
      command: { type: 'FINALIZE_CODING_TASK', command_id: 'finalize-1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1' },
    }),
    'utf8',
  );
  const response = await withoutControl.server.exchangeFrameForTest(controlPayload);
  assert.equal(response.error, 'CAPABILITY_UNVERIFIED: required capability is unverified');
  await withoutControl.server.close();
});

test('rejects an invalid token before submitting to the daemon', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({
    endpoint: fixture.server.endpoint,
    token: '0'.repeat(64),
    requestDeadlineMs: 1_000,
    platform: process.platform,
    serverIdentityVerifier: clientVerifier(fixture.server.endpoint),
    ...unixPhysicalClientTestDeps(fixture.stateDirectory),
  });

  await assert.rejects(() => client.submit(request(fixture.token).command), /AUTHENTICATION_FAILED/);

  assert.equal(fixture.submitted.length, 0);
  await client.close();
  await fixture.server.close();
});

test('rejects authenticated JSON that is not in canonical wire form', async () => {
  const fixture = await ipcFixture();
  const nonCanonical = Buffer.from(JSON.stringify(request(fixture.token)), 'utf8');

  try {
    const response = await fixture.server.exchangeFrameForTest(nonCanonical);
    assert.equal(response.error, 'INVALID_CONTRACT: request contract rejected');
    assert.equal(fixture.submitted.length, 0);
  } finally {
    await fixture.server.close();
  }
});

test('client fails closed without a trusted server-identity verifier', () => {
  assert.throws(() => createBrokerIpcClient({ endpoint: 'local-endpoint', token: '0'.repeat(64) }), /AUTHENTICATION_FAILED/);
});

test('Unix client rejects a changed physical state path before coordinator or connect effects', async () => {
  let physicalInspections = 0;
  let coordinatorEffects = 0;
  let connectEffects = 0;
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return {
      ...valid,
      components: valid.components.map((component, index) =>
        index === valid.components.length - 1 ? { ...component, kind: 'symbolic-link' as const } : component,
      ),
    };
  }, 'client-changed-path');
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'client-changed-path-coordinator' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };
  const client = createBrokerIpcClient({
    endpoint: '/state/broker.sock',
    stateDirectory: '/state',
    token: 'a'.repeat(64),
    platform: 'linux',
    serverIdentityVerifier: { verifyServer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) },
    endpointCoordinator: coordinator,
    unixPhysicalPathBackend: backend,
    allowInProcessPhysicalPathBackendForTests: true,
    connect: () => {
      connectEffects += 1;
      throw new Error('connect must not run');
    },
  });

  await assert.rejects(() => client.submit(request('a'.repeat(64)).command), /AUTHENTICATION_FAILED/);
  assert.equal(physicalInspections, 1);
  assert.equal(coordinatorEffects, 0);
  assert.equal(connectEffects, 0);
});

test('client sends no request when connected server ownership is rejected', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({
    endpoint: fixture.server.endpoint,
    token: fixture.token,
    platform: process.platform,
    serverIdentityVerifier: { verifyServer: async () => null },
    ...unixPhysicalClientTestDeps(fixture.stateDirectory),
  });

  try {
    await assert.rejects(() => client.submit(request(fixture.token).command), /AUTHENTICATION_FAILED/);
    assert.equal(fixture.submitted.length, 0);
  } finally {
    await client.close();
    await fixture.server.close();
  }
});

for (const [name, payload] of [
  ['malformed JSON', Buffer.from('{', 'utf8')],
  ['oversized frame', Buffer.alloc(4_194_305)],
  ['unknown command', Buffer.from(canonicalJsonV4({ token: 'TOKEN', command: { type: 'SHELL', command_id: 'x' } }), 'utf8')],
] as const) {
  test(`rejects ${name} without a journal mutation`, async () => {
    const fixture = await ipcFixture();
    const body = name === 'unknown command' ? Buffer.from(payload.toString().replace('TOKEN', fixture.token), 'utf8') : payload;

    const response = await fixture.server.exchangeFrameForTest(body);

    assert.match(response.error ?? '', /INVALID_CONTRACT|frame too large/);
    assert.equal(fixture.submitted.length, 0);
    await fixture.server.close();
  });
}

test('production startup fails closed when no native platform verifier is provided', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-'));
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\runner-v4-closed-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
      : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        ...unixPhysicalServerTestDeps(),
      }),
    /AUTHENTICATION_FAILED/,
  );
});

test('production startup rejects an in-process endpoint coordinator', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-coordinator-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-coordinator-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator,
      }),
    /AUTHENTICATION_FAILED/,
  );
});

test('Unix production startup fails closed without a certified physical-path backend', async () => {
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  let coordinatorEffects = 0;
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'missing-physical-backend' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory: '/state',
        endpoint: '/state/broker.sock',
        platform: 'linux',
        platformVerifier: verifier,
        endpointCoordinator: coordinator,
      }),
    /AUTHENTICATION_FAILED: certified Unix physical-path backend is required/,
  );
  assert.equal(coordinatorEffects, 0);
});

test('running-server close uses the same endpoint coordinator as startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-close-coordinator-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-close-coordinator-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const delegate = createInProcessReclamationCoordinatorV4('close-coordinator-delegate');
  const keys: string[] = [];
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'close-coordinator' },
    runExclusive: async (key, operation) => {
      keys.push(key);
      return delegate.runExclusive(key, operation);
    },
  };

  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator: coordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  });
  await server.close();

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  if (process.platform === 'win32') assert.equal(keys[0], `ipc-endpoint:${endpoint}`);
  else assert.doesNotMatch(keys[0]!, new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('canonicalizes state and endpoint configuration before every IPC lifecycle operation', async () => {
  const createdStateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-canonical-'));
  const stateDirectory = `${createdStateDirectory}${sep}.${sep}`;
  const canonicalStateDirectory = resolve(createdStateDirectory);
  const pipeName = `runner-v4-canonical-${Date.now()}`;
  const endpoint = process.platform === 'win32' ? `//./PIPE/${pipeName.toUpperCase()}` : `${stateDirectory}broker.sock`;
  const canonicalEndpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : join(canonicalStateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifiedPaths: Array<{ path: string; kind: 'state-directory' | 'token-file' | 'endpoint' }> = [];
  const peerEndpoints: string[] = [];
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ path, kind, expected_owner_identity }) => {
      verifiedPaths.push({ path, kind });
      return { owner_identity: expected_owner_identity };
    },
    verifyPeer: async ({ endpoint: verifiedEndpoint, expected_owner_identity }) => {
      peerEndpoints.push(verifiedEndpoint);
      return { owner_identity: expected_owner_identity };
    },
  };
  const delegate = createInProcessReclamationCoordinatorV4('canonical-endpoint-delegate');
  const coordinatorKeys: string[] = [];
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'canonical-endpoint' },
    runExclusive: async (key, operation) => {
      coordinatorKeys.push(key);
      return delegate.runExclusive(key, operation);
    },
  };
  const tokenDirectories: string[] = [];
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator: coordinator,
    allowInProcessCoordinatorForTests: true,
    loadToken: async (directory) => {
      tokenDirectories.push(directory);
      return 'a'.repeat(64);
    },
    ...unixPhysicalServerTestDeps(),
  });

  try {
    const response = await server.exchangeFrameForTest(Buffer.from('{', 'utf8'));
    assert.equal(response.error, 'INVALID_CONTRACT: request contract rejected');
  } finally {
    await server.close();
  }

  assert.equal(server.endpoint, canonicalEndpoint);
  assert.deepEqual(tokenDirectories, [canonicalStateDirectory]);
  assert.deepEqual(verifiedPaths, [
    { path: canonicalStateDirectory, kind: 'state-directory' },
    { path: join(canonicalStateDirectory, 'broker.token'), kind: 'token-file' },
    { path: canonicalEndpoint, kind: 'endpoint' },
  ]);
  assert.deepEqual(peerEndpoints, [canonicalEndpoint]);
  assert.equal(coordinatorKeys.length, 2);
  assert.equal(coordinatorKeys[0], coordinatorKeys[1]);
  if (process.platform === 'win32') assert.equal(coordinatorKeys[0], `ipc-endpoint:${canonicalEndpoint}`);
  else assert.doesNotMatch(coordinatorKeys[0]!, new RegExp(canonicalEndpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('rejects ambiguous or out-of-state endpoint configuration before coordination', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-invalid-location-'));
  const endpoint = process.platform === 'win32' ? 'relative-pipe-name' : join(stateDirectory, '..', 'outside.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const delegate = createInProcessReclamationCoordinatorV4('invalid-location-delegate');
  let coordinatorCalls = 0;
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'invalid-location' },
    runExclusive: async (key, operation) => {
      coordinatorCalls += 1;
      return delegate.runExclusive(key, operation);
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator: coordinator,
        allowInProcessCoordinatorForTests: true,
        loadToken: async () => 'a'.repeat(64),
        ...unixPhysicalServerTestDeps(),
      }),
    (error: Error) => error.message.startsWith('AUTHENTICATION_FAILED:'),
  );
  assert.equal(coordinatorCalls, 0);
});

test('rejects a direct Unix state-directory symlink before token, coordinator, or socket effects', async () => {
  const stateDirectory = '/direct-link/state';
  const endpoint = '/direct-link/state/broker.sock';
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  let physicalInspections = 0;
  let tokenEffects = 0;
  let coordinatorEffects = 0;
  const physicalPath = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return {
      ...valid,
      components: valid.components.map((component, index) =>
        index === valid.components.length - 1 ? { ...component, kind: 'symbolic-link' as const } : component,
      ),
    };
  });
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'direct-link-coordinator' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: verifier,
        endpointCoordinator: coordinator,
        unixPhysicalPathBackend: physicalPath,
        allowInProcessPhysicalPathBackendForTests: true,
        loadToken: async () => {
          tokenEffects += 1;
          return 'a'.repeat(64);
        },
      }),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(physicalInspections, 1);
  assert.equal(tokenEffects, 0);
  assert.equal(coordinatorEffects, 0);
});

test('rejects an intermediate Unix parent symlink before token, coordinator, or socket effects', async () => {
  const stateDirectory = '/parent-link/state';
  const endpoint = '/parent-link/state/broker.sock';
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  let physicalInspections = 0;
  let tokenEffects = 0;
  let coordinatorEffects = 0;
  const physicalPath = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return {
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, kind: 'symbolic-link' as const } : component)),
    };
  });
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'parent-link-coordinator' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: verifier,
        endpointCoordinator: coordinator,
        unixPhysicalPathBackend: physicalPath,
        allowInProcessPhysicalPathBackendForTests: true,
        loadToken: async () => {
          tokenEffects += 1;
          return 'a'.repeat(64);
        },
      }),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(physicalInspections, 1);
  assert.equal(tokenEffects, 0);
  assert.equal(coordinatorEffects, 0);
});

test('rejects a structurally forged production Unix physical backend before inspection or coordination', async () => {
  const stateDirectory = '/forged-native/state';
  let inspectionEffects = 0;
  let coordinatorEffects = 0;
  const forgedBackend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    inspectionEffects += 1;
    return physicalInspection(state_directory, expected_owner_identity);
  });
  forgedBackend.certification = { kind: 'native-physical-path', identity: 'caller-attested-forgery' };
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'forged-backend-coordinator' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint: `${stateDirectory}/broker.sock`,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: coordinator,
        unixPhysicalPathBackend: forgedBackend,
        loadToken: async () => 'a'.repeat(64),
      }),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(inspectionEffects, 0);
  assert.equal(coordinatorEffects, 0);
});

test(
  'Linux native physical backend refuses a non-Linux Unix constructor before coordination',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-non-linux-unix-');
    let coordinatorEffects = 0;
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'native-cross-process', identity: 'non-linux-unix-coordinator' },
      runExclusive: async () => {
        coordinatorEffects += 1;
        throw new Error('must not coordinate');
      },
    };
    try {
      const backend = await linuxNativePhysicalPathBackendForTest();
      await assert.rejects(
        async () =>
          createBrokerIpcServer({
            daemon: minimalDaemonForIpcTest(),
            stateDirectory,
            endpoint: join(stateDirectory, 'broker.sock'),
            platform: 'darwin',
            platformVerifier: {
              verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
              verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
            },
            endpointCoordinator: coordinator,
            unixPhysicalPathBackend: backend,
          }),
        /AUTHENTICATION_FAILED/,
      );
      assert.equal(coordinatorEffects, 0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test('rejects a linked descendant endpoint parent before physical inspection or coordination', async () => {
  const stateDirectory = '/linked-descendant/state';
  let physicalEffects = 0;
  let coordinatorEffects = 0;
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalEffects += 1;
    return physicalInspection(state_directory, expected_owner_identity);
  });
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'linked-descendant-coordinator' },
    runExclusive: async () => {
      coordinatorEffects += 1;
      throw new Error('must not coordinate');
    },
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint: `${stateDirectory}/linked-parent/broker.sock`,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: coordinator,
        unixPhysicalPathBackend: backend,
        allowInProcessPhysicalPathBackendForTests: true,
        loadToken: async () => 'a'.repeat(64),
      }),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(physicalEffects, 0);
  assert.equal(coordinatorEffects, 0);
});

test('real Linux backend rejects a direct state-directory symlink', { skip: process.platform !== 'linux' }, async () => {
  const fixtureRoot = await linuxSecureDirectoryForTest('.runner-v4-direct-link-');
  try {
    const actualState = join(fixtureRoot, 'actual-state');
    const linkedState = join(fixtureRoot, 'linked-state');
    await mkdir(actualState, { mode: 0o700 });
    await symlink(actualState, linkedState, 'dir');
    const backend = await linuxNativePhysicalPathBackendForTest();

    await assert.rejects(
      () => backend.certifyStateDirectory({ state_directory: linkedState, expected_owner_identity: currentUnixOwnerIdentityForTest() }),
      /AUTHENTICATION_FAILED/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('real Linux backend rejects an intermediate parent symlink', { skip: process.platform !== 'linux' }, async () => {
  const fixtureRoot = await linuxSecureDirectoryForTest('.runner-v4-parent-link-');
  try {
    const actualParent = join(fixtureRoot, 'actual-parent');
    const linkedParent = join(fixtureRoot, 'linked-parent');
    await mkdir(join(actualParent, 'state'), { recursive: true, mode: 0o700 });
    await chmod(actualParent, 0o700);
    await symlink(actualParent, linkedParent, 'dir');
    const backend = await linuxNativePhysicalPathBackendForTest();

    await assert.rejects(
      () =>
        backend.certifyStateDirectory({
          state_directory: join(linkedParent, 'state'),
          expected_owner_identity: currentUnixOwnerIdentityForTest(),
        }),
      /AUTHENTICATION_FAILED/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('real Linux native capability round-trips through the direct broker.sock child', { skip: process.platform !== 'linux' }, async () => {
  const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-native-roundtrip-');
  const endpoint = join(stateDirectory, 'broker.sock');
  const submitted: BrokerCommandV4[] = [];
  const coordinator = createInProcessReclamationCoordinatorV4('native-linux-roundtrip');
  const physicalBackend = await linuxNativePhysicalPathBackendForTest();
  const platformVerifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  let server: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
  try {
    server = await createBrokerIpcServer({
      daemon: minimalDaemonForIpcTest(submitted),
      stateDirectory,
      endpoint,
      platform: 'linux',
      platformVerifier,
      endpointCoordinator: coordinator,
      allowInProcessCoordinatorForTests: true,
      unixPhysicalPathBackend: physicalBackend,
      requestDeadlineMs: 1_000,
    });
    const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
    const client = createBrokerIpcClient({
      stateDirectory,
      endpoint,
      token,
      platform: 'linux',
      endpointCoordinator: coordinator,
      allowInProcessCoordinatorForTests: true,
      unixPhysicalPathBackend: physicalBackend,
      serverIdentityVerifier: clientVerifier(endpoint),
      requestDeadlineMs: 1_000,
    });

    const reply = await client.submit(request(token).command);

    assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
    assert.equal(submitted.length, 1);
    await client.close();
  } finally {
    await server?.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test(
  'production Linux close preserves replacements at every observable listener pathname',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-close-path-replacement-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const displacedEndpoint = join(stateDirectory, 'displaced-broker.sock');
    const coordinator = createInProcessReclamationCoordinatorV4('native-linux-close-path-replacement');
    const physicalBackend = await linuxNativePhysicalPathBackendForTest();
    const platformVerifier: BrokerIpcPlatformVerifierV4 = {
      verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
      verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    };
    const listenerPaths = async (): Promise<Set<string>> => {
      const table = await readFile('/proc/net/unix', 'utf8');
      return new Set(
        table.split('\n').flatMap((line) => {
          const columns = line.trim().split(/\s+/);
          const path = columns.length >= 8 ? columns.at(-1) : undefined;
          return typeof path === 'string' && path.includes('.broker.sock.bind-') ? [path] : [];
        }),
      );
    };
    const before = await listenerPaths();
    let server: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      server = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier,
        endpointCoordinator: coordinator,
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: physicalBackend,
        requestDeadlineMs: 1_000,
      });
      const retainedPaths = [...(await listenerPaths())].filter((path) => !before.has(path));
      await rename(endpoint, displacedEndpoint);
      await writeFile(endpoint, 'public replacement', { mode: 0o600 });
      for (const path of retainedPaths) await writeFile(path, 'retained-path replacement', { mode: 0o600 });

      await server.close();
      server = null;

      assert.equal(await readFile(endpoint, 'utf8'), 'public replacement');
      for (const path of retainedPaths) {
        assert.equal(await readFile(path, 'utf8'), 'retained-path replacement');
      }
    } finally {
      await server?.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux normal close destroys held connections and releases coordination within its deadline',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-held-normal-close-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const physicalBackend = await linuxNativePhysicalPathBackendForTest();
    const delegate = createInProcessReclamationCoordinatorV4('held-normal-close-delegate');
    let activeCoordinatorOperations = 0;
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'in-process-test', identity: 'held-normal-close-coordinator' },
      runExclusive: (key, operation) =>
        delegate.runExclusive(key, async () => {
          activeCoordinatorOperations += 1;
          try {
            return await operation();
          } finally {
            activeCoordinatorOperations -= 1;
          }
        }),
    };
    const platformVerifier: BrokerIpcPlatformVerifierV4 = {
      verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
      verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    };
    const childPidsBefore = await linuxChildPidsForTest();
    const childHandlesBefore = activeChildProcessHandleCountForTest();
    let server: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    let heldSocket: Socket | null = null;
    try {
      server = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier,
        endpointCoordinator: coordinator,
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: physicalBackend,
      });
      heldSocket = createConnection(endpoint);
      await once(heldSocket, 'connect');
      const socketClosed = once(heldSocket, 'close');
      const closePromise = server.close();
      const outcome = await deadlineOutcomeForTest(
        closePromise.then(() => 'closed' as const),
        400,
      );
      if (outcome.kind === 'timeout') {
        heldSocket.destroy();
        await closePromise.catch(() => undefined);
      }

      assert.deepEqual(outcome, { kind: 'settled', value: 'closed' });
      server = null;
      await socketClosed;
      assert.equal(heldSocket.destroyed, true);
      assert.equal(activeCoordinatorOperations, 0);
      assert.equal(await connectionOutcomeForTest(endpoint), 'rejected');
      assert.deepEqual(await linuxChildPidsForTest(), childPidsBefore);
      assert.equal(activeChildProcessHandleCountForTest(), childHandlesBefore);
    } finally {
      heldSocket?.destroy();
      await server?.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux proof abort destroys a preauthentication connection and leaves no binder child',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-held-proof-abort-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const physicalBackend = await linuxNativePhysicalPathBackendForTest();
    const delegate = createInProcessReclamationCoordinatorV4('held-proof-abort-delegate');
    let activeCoordinatorOperations = 0;
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'in-process-test', identity: 'held-proof-abort-coordinator' },
      runExclusive: (key, operation) =>
        delegate.runExclusive(key, async () => {
          activeCoordinatorOperations += 1;
          try {
            return await operation();
          } finally {
            activeCoordinatorOperations -= 1;
          }
        }),
    };
    let enterEndpointProof!: () => void;
    const endpointProofEntered = new Promise<void>((resolveEntered) => {
      enterEndpointProof = resolveEntered;
    });
    let releaseEndpointProof!: () => void;
    const endpointProofCanReturn = new Promise<void>((resolveProof) => {
      releaseEndpointProof = resolveProof;
    });
    const platformVerifier: BrokerIpcPlatformVerifierV4 = {
      verifyOwnerOnlyPath: async ({ kind, expected_owner_identity }) => {
        if (kind !== 'endpoint') return { owner_identity: expected_owner_identity };
        enterEndpointProof();
        await endpointProofCanReturn;
        return null;
      },
      verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    };
    const childPidsBefore = await linuxChildPidsForTest();
    const childHandlesBefore = activeChildProcessHandleCountForTest();
    let heldSocket: Socket | null = null;
    let unexpectedServer: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      const creation = createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier,
        endpointCoordinator: coordinator,
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: physicalBackend,
      }).then(
        (server) => ({ kind: 'created' as const, server }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      await endpointProofEntered;
      heldSocket = createConnection(endpoint);
      await once(heldSocket, 'connect');
      const socketClosed = once(heldSocket, 'close');
      releaseEndpointProof();
      const outcome = await deadlineOutcomeForTest(creation, 400);
      if (outcome.kind === 'timeout') {
        heldSocket.destroy();
        await creation;
      } else if (outcome.value.kind === 'created') {
        unexpectedServer = outcome.value.server;
      }

      assert.equal(outcome.kind, 'settled');
      assert.equal(outcome.kind === 'settled' ? outcome.value.kind : 'timeout', 'rejected');
      if (outcome.kind === 'settled' && outcome.value.kind === 'rejected')
        assert.match(outcome.value.error.message, /AUTHENTICATION_FAILED/);
      await socketClosed;
      assert.equal(heldSocket.destroyed, true);
      assert.equal(activeCoordinatorOperations, 0);
      assert.equal(await connectionOutcomeForTest(endpoint), 'rejected');
      assert.deepEqual(await linuxChildPidsForTest(), childPidsBefore);
      assert.equal(activeChildProcessHandleCountForTest(), childHandlesBefore);
    } finally {
      releaseEndpointProof();
      heldSocket?.destroy();
      await unexpectedServer?.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux handles a connection accepted before binder exit without an unauthenticated orphan',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-early-adopted-connection-');
    const endpoint = join(stateDirectory, 'broker.sock');
    let enterListenerBarrier!: () => void;
    const listenerBarrierEntered = new Promise<void>((resolveEntered) => {
      enterListenerBarrier = resolveEntered;
    });
    let releaseListenerBarrier!: () => void;
    const listenerBarrierCanReturn = new Promise<void>((resolveBarrier) => {
      releaseListenerBarrier = resolveBarrier;
    });
    const childPidsBefore = await linuxChildPidsForTest();
    const childHandlesBefore = activeChildProcessHandleCountForTest();
    let server: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    let earlySocket: Socket | null = null;
    const creation = createBrokerIpcServer({
      daemon: minimalDaemonForIpcTest(),
      stateDirectory,
      endpoint,
      platform: 'linux',
      requestDeadlineMs: 50,
      platformVerifier: {
        verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
      },
      endpointCoordinator: createInProcessReclamationCoordinatorV4('early-adopted-connection'),
      allowInProcessCoordinatorForTests: true,
      unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
      allowInProcessPhysicalPathBackendForTests: true,
      afterLinuxListenerReceivedForTests: async () => {
        enterListenerBarrier();
        await listenerBarrierCanReturn;
      },
    });
    try {
      const entered = await deadlineOutcomeForTest(
        listenerBarrierEntered.then(() => 'entered' as const),
        300,
      );
      if (entered.kind === 'timeout') server = await creation;
      assert.deepEqual(entered, { kind: 'settled', value: 'entered' });

      earlySocket = createConnection(endpoint);
      earlySocket.on('error', () => undefined);
      await once(earlySocket, 'connect');
      const earlySocketClosed = new Promise<void>((resolveClosed) => earlySocket!.once('close', () => resolveClosed()));
      const closeOutcome = await deadlineOutcomeForTest(
        earlySocketClosed.then(() => 'closed' as const),
        250,
      );
      if (closeOutcome.kind === 'timeout') earlySocket.destroy();
      assert.deepEqual(closeOutcome, { kind: 'settled', value: 'closed' });

      releaseListenerBarrier();
      server = await creation;
      await server.close();
      server = null;
      assert.deepEqual(await linuxChildPidsForTest(), childPidsBefore);
      assert.equal(activeChildProcessHandleCountForTest(), childHandlesBefore);
    } finally {
      releaseListenerBarrier();
      earlySocket?.destroy();
      if (server === null) {
        await creation
          .then(
            (created) => created.close(),
            () => undefined,
          )
          .catch(() => undefined);
      } else {
        await server.close().catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux backend fails closed when the fixed native rename helper is missing',
  { skip: process.platform !== 'linux' },
  async () => {
    const helperPath = linuxNativeRenameHelperPathForTest();
    const backupPath = `${helperPath}.missing-test-backup`;
    const helperExists = await lstat(helperPath).then(
      () => true,
      () => false,
    );
    if (helperExists) await rename(helperPath, backupPath);
    try {
      await assert.rejects(() => linuxNativePhysicalPathBackendForTest(), /AUTHENTICATION_FAILED/);
    } finally {
      if (helperExists) await rename(backupPath, helperPath);
    }
  },
);

test('production Linux backend rejects a symlinked native-helper install parent', { skip: process.platform !== 'linux' }, async () => {
  const helperPath = linuxNativeRenameHelperPathForTest();
  const helperDirectory = dirname(helperPath);
  const realDirectory = `${helperDirectory}.symlink-test-real`;
  assert.equal(
    await lstat(helperPath).then(
      (metadata) => metadata.isFile(),
      () => false,
    ),
    true,
    'Linux native build artifact must exist',
  );
  await rename(helperDirectory, realDirectory);
  await symlink(realDirectory, helperDirectory, 'dir');
  try {
    await assert.rejects(() => linuxNativePhysicalPathBackendForTest(), /AUTHENTICATION_FAILED/);
  } finally {
    await unlink(helperDirectory);
    await rename(realDirectory, helperDirectory);
  }
});

test(
  'production Linux backend re-proves native-helper identity before endpoint effects',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-native-helper-tamper-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const helperPath = linuxNativeRenameHelperPathForTest();
    const backupPath = `${helperPath}.identity-test-backup`;
    assert.equal(
      await lstat(helperPath).then(
        (metadata) => metadata.isFile(),
        () => false,
      ),
      true,
      'Linux native build artifact must exist',
    );
    const backend = await linuxNativePhysicalPathBackendForTest();
    await rename(helperPath, backupPath);
    await writeFile(helperPath, '#!/bin/sh\nexit 0\n', { mode: 0o555 });
    try {
      await assert.rejects(
        async () =>
          createBrokerIpcServer({
            daemon: minimalDaemonForIpcTest(),
            stateDirectory,
            endpoint,
            platform: 'linux',
            platformVerifier: {
              verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
              verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
            },
            endpointCoordinator: createInProcessReclamationCoordinatorV4('tampered-native-helper'),
            allowInProcessCoordinatorForTests: true,
            unixPhysicalPathBackend: backend,
          }),
        /AUTHENTICATION_FAILED/,
      );
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      await unlink(helperPath);
      await rename(backupPath, helperPath);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'Linux native rename helper reports an unsupported renameat2 syscall through its fixed exit protocol',
  { skip: process.platform !== 'linux' },
  async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-native-helper-unsupported-'));
    const sourcePath = join(process.cwd(), 'native', 'linux', 'renameat2-helper.c');
    const helperPath = join(fixtureDirectory, 'renameat2-unsupported');
    const stateDirectory = join(fixtureDirectory, 'state');
    const slotDirectory = join(stateDirectory, linuxBrokerQuarantineSlotNameForTest(0));
    await mkdir(slotDirectory, { recursive: true, mode: 0o700 });
    const compiler = spawn(
      '/usr/bin/cc',
      [
        '-std=c17',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-DAGENT_ORCHESTRATION_TEST_FORCE_RENAMEAT2_UNSUPPORTED=1',
        sourcePath,
        '-o',
        helperPath,
      ],
      { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, stdio: 'ignore' },
    );
    const [compilerCode, compilerSignal] = (await once(compiler, 'exit')) as [number | null, NodeJS.Signals | null];
    assert.equal(compilerSignal, null);
    assert.equal(compilerCode, 0);
    const stateHandle = await open(stateDirectory, 'r');
    const slotHandle = await open(slotDirectory, 'r');
    try {
      const helper = spawn(helperPath, [], {
        cwd: '/',
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', stateHandle.fd, slotHandle.fd],
      });
      const [code, signal] = (await once(helper, 'exit')) as [number | null, NodeJS.Signals | null];
      assert.equal(signal, null);
      assert.equal(code, 38);
    } finally {
      await stateHandle.close();
      await slotHandle.close();
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux native no-replace preserves a hostile exact reservation destination',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-native-no-replace-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const replacementState: { process: ChildProcess | null } = { process: null };
    let replacementPath = '';
    let replacementIdentity = '';
    let broker: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      broker = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: createInProcessReclamationCoordinatorV4('native-no-replace'),
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
        allowInProcessPhysicalPathBackendForTests: true,
        unixQuarantineLimitForTests: 2,
        afterLinuxQuarantineReadyForRenameForTests: async () => {
          const names = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-'));
          assert.equal(names.length, 1);
          replacementPath = join(stateDirectory, names[0]!, 'broker.sock');
          const replacementScript = [
            "const { chmodSync } = require('node:fs');",
            "const { createServer } = require('node:net');",
            'const endpoint = process.argv[1];',
            'const server = createServer();',
            "server.listen(endpoint, () => { chmodSync(endpoint, 0o600); process.send({ kind: 'ready' }); });",
            "process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));",
          ].join('\n');
          replacementState.process = spawn(process.execPath, ['-e', replacementScript, replacementPath], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          await waitForChildIpcMessageForTest(replacementState.process, 'ready');
          const metadata = await lstat(replacementPath);
          replacementIdentity = `${metadata.dev}:${metadata.ino}`;
        },
      });
      const ownedEndpoint = await lstat(endpoint);
      const closeResult = await broker.close().then(
        () => ({ kind: 'closed' as const }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      broker = null;

      assert.equal(closeResult.kind, 'rejected');
      if (closeResult.kind === 'rejected') assert.match(closeResult.error.message, /UNKNOWN_FAILURE|REPOSITORY_BUSY/);
      const endpointAfter = await lstat(endpoint);
      assert.equal(`${endpointAfter.dev}:${endpointAfter.ino}`, `${ownedEndpoint.dev}:${ownedEndpoint.ino}`);
      const replacementAfter = await lstat(replacementPath);
      assert.equal(`${replacementAfter.dev}:${replacementAfter.ino}`, replacementIdentity);
      const socket = createConnection(replacementPath);
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      socket.destroy();
    } finally {
      await broker?.close().catch(() => undefined);
      const replacementProcess = replacementState.process;
      if (replacementProcess !== null && replacementProcess.exitCode === null && replacementProcess.signalCode === null) {
        replacementProcess.kill('SIGKILL');
        await once(replacementProcess, 'exit').catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux fixed quarantine namespace fails closed at exactly 64 occupied slots without creating a 65th',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-fixed-quarantine-capacity-');
    const endpoint = join(stateDirectory, 'broker.sock');
    let fixtureProcess: ChildProcess | null = null;
    try {
      const fixtureScript = [
        "const { chmodSync, mkdirSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const { createServer } = require('node:net');",
        'const root = process.argv[1];',
        'const servers = [];',
        'let remaining = 64;',
        'for (let index = 0; index < 64; index += 1) {',
        "  const name = '.broker.sock.quarantine-slot-' + String(index).padStart(2, '0');",
        '  const directory = join(root, name);',
        '  mkdirSync(directory, { mode: 0o700 });',
        "  const endpoint = join(directory, 'broker.sock');",
        '  const server = createServer();',
        '  servers.push(server);',
        "  server.listen(endpoint, () => { chmodSync(endpoint, 0o600); remaining -= 1; if (remaining === 0) process.send({ kind: 'ready' }); });",
        '}',
        "process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));",
      ].join('\n');
      fixtureProcess = spawn(process.execPath, ['-e', fixtureScript, stateDirectory], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      await waitForChildIpcMessageForTest(fixtureProcess, 'ready');

      await assert.rejects(
        async () =>
          createBrokerIpcServer({
            daemon: minimalDaemonForIpcTest(),
            stateDirectory,
            endpoint,
            platform: 'linux',
            platformVerifier: {
              verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
              verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
            },
            endpointCoordinator: createInProcessReclamationCoordinatorV4('fixed-quarantine-capacity'),
            allowInProcessCoordinatorForTests: true,
            unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
          }),
        /REPOSITORY_BUSY/,
      );
      const names = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.deepEqual(
        names,
        Array.from({ length: 64 }, (_, index) => linuxBrokerQuarantineSlotNameForTest(index)),
      );
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      if (fixtureProcess !== null && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
        fixtureProcess.kill('SIGKILL');
        await once(fixtureProcess, 'exit').catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux concurrent final-slot reservation cannot create a 65th broker slot',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-concurrent-fixed-slot-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const heldEndpoint = join(stateDirectory, 'held-broker.sock');
    const oldServer = createServer();
    let fixtureProcess: ChildProcess | null = null;
    let arrivals = 0;
    let bothArrived!: () => void;
    const bothAtMetadataBarrier = new Promise<void>((resolveBarrier) => {
      bothArrived = resolveBarrier;
    });
    let releaseBarrier!: () => void;
    const metadataBarrierCanReturn = new Promise<void>((resolveBarrier) => {
      releaseBarrier = resolveBarrier;
    });
    try {
      const fixtureScript = [
        "const { chmodSync, mkdirSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const { createServer } = require('node:net');",
        'const root = process.argv[1];',
        'let remaining = 63;',
        'for (let index = 0; index < 63; index += 1) {',
        "  const directory = join(root, '.broker.sock.quarantine-slot-' + String(index).padStart(2, '0'));",
        '  mkdirSync(directory, { mode: 0o700 });',
        "  const endpoint = join(directory, 'broker.sock');",
        "  createServer().listen(endpoint, () => { chmodSync(endpoint, 0o600); remaining -= 1; if (remaining === 0) process.send({ kind: 'ready' }); });",
        '}',
        "process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));",
      ].join('\n');
      fixtureProcess = spawn(process.execPath, ['-e', fixtureScript, stateDirectory], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      await waitForChildIpcMessageForTest(fixtureProcess, 'ready');
      await listenForTest(oldServer, endpoint);
      await chmod(endpoint, 0o600);
      const original = await lstat(endpoint);
      const originalIdentity = `linux:dev:${original.dev}:ino:${original.ino}`;
      await rename(endpoint, heldEndpoint);
      await closeForTest(oldServer);
      await rename(heldEndpoint, endpoint);

      const backend = await linuxNativePhysicalPathBackendForTest();
      const cleanup = (identity: string) =>
        removeOwnedUnixEndpointV4(
          endpoint,
          originalIdentity,
          {
            metadata: async () => {
              throw new Error('native cleanup must not use raw endpoint metadata');
            },
            remove: async () => {
              throw new Error('native cleanup must not use raw endpoint unlink');
            },
            afterMetadataForTests: async () => {
              arrivals += 1;
              if (arrivals === 2) bothArrived();
              await metadataBarrierCanReturn;
            },
          },
          createInProcessReclamationCoordinatorV4(identity),
          {
            stateDirectory,
            expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
            unixPhysicalPathBackend: backend,
            allowInProcessCoordinatorForTests: true,
            allowInProcessPhysicalPathBackendForTests: true,
          },
        );
      const first = cleanup('concurrent-slot-a').then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      const second = cleanup('concurrent-slot-b').then(
        () => 'fulfilled' as const,
        () => 'rejected' as const,
      );
      await bothAtMetadataBarrier;
      releaseBarrier();
      const outcomes = await Promise.all([first, second]);
      assert.equal(outcomes.filter((outcome) => outcome === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome === 'rejected').length, 1);
      const names = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.deepEqual(
        names,
        Array.from({ length: 64 }, (_, index) => linuxBrokerQuarantineSlotNameForTest(index)),
      );
      const retained = await lstat(join(stateDirectory, linuxBrokerQuarantineSlotNameForTest(63), 'broker.sock'));
      assert.equal(`${retained.dev}:${retained.ino}`, `${original.dev}:${original.ino}`);
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      releaseBarrier();
      await closeForTest(oldServer);
      if (fixtureProcess !== null && fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
        fixtureProcess.kill('SIGKILL');
        await once(fixtureProcess, 'exit').catch(() => undefined);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux cleanup rejects a quarantine hardlink to the current endpoint identity',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-endpoint-quarantine-hardlink-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const quarantineName = linuxBrokerQuarantineSlotNameForTest(0);
    const quarantineDirectory = join(stateDirectory, quarantineName);
    const quarantine = join(quarantineDirectory, 'broker.sock');
    const oldServer = createServer();
    try {
      const backend = await linuxNativePhysicalPathBackendForTest();
      await listenForTest(oldServer, endpoint);
      await chmod(endpoint, 0o600);
      const endpointMetadata = await lstat(endpoint);
      const endpointIdentity = `linux:dev:${endpointMetadata.dev}:ino:${endpointMetadata.ino}`;
      await mkdir(quarantineDirectory, { mode: 0o700 });
      await link(endpoint, quarantine);
      await closeForTest(oldServer);
      await link(quarantine, endpoint);

      await assert.rejects(
        () =>
          removeOwnedUnixEndpointV4(
            endpoint,
            endpointIdentity,
            {
              metadata: async () => {
                throw new Error('native cleanup must not use raw endpoint metadata');
              },
              remove: async () => {
                throw new Error('native cleanup must not use raw endpoint unlink');
              },
            },
            endpointCoordinator,
            {
              stateDirectory,
              expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
              unixPhysicalPathBackend: backend,
              allowInProcessCoordinatorForTests: true,
            },
          ),
        /AUTHENTICATION_FAILED/,
      );

      const endpointAfter = await lstat(endpoint);
      const quarantineAfter = await lstat(quarantine);
      assert.equal(endpointAfter.ino, endpointMetadata.ino);
      assert.equal(quarantineAfter.ino, endpointMetadata.ino);
      assert.deepEqual(
        (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')),
        [quarantineName],
      );
    } finally {
      await closeForTest(oldServer);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux admission rejects duplicate quarantine socket identities without deleting either link',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-duplicate-quarantine-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const firstDirectory = join(stateDirectory, linuxBrokerQuarantineSlotNameForTest(0));
    const secondDirectory = join(stateDirectory, linuxBrokerQuarantineSlotNameForTest(1));
    const first = join(firstDirectory, 'broker.sock');
    const second = join(secondDirectory, 'broker.sock');
    const retainedServer = createServer();
    try {
      const backend = await linuxNativePhysicalPathBackendForTest();
      await mkdir(firstDirectory, { mode: 0o700 });
      await mkdir(secondDirectory, { mode: 0o700 });
      await listenForTest(retainedServer, first);
      await chmod(first, 0o600);
      await link(first, second);
      await closeForTest(retainedServer);
      await link(second, first);
      const original = await lstat(first);

      await assert.rejects(
        () =>
          createBrokerIpcServer({
            daemon: minimalDaemonForIpcTest(),
            stateDirectory,
            endpoint,
            platform: 'linux',
            platformVerifier: {
              verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
              verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
            },
            endpointCoordinator: createInProcessReclamationCoordinatorV4('duplicate-quarantine'),
            allowInProcessCoordinatorForTests: true,
            unixPhysicalPathBackend: backend,
          }),
        /AUTHENTICATION_FAILED/,
      );

      assert.equal((await lstat(first)).ino, original.ino);
      assert.equal((await lstat(second)).ino, original.ino);
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      await closeForTest(retainedServer);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux close reserves the exact final quarantine slot before moving its endpoint',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-exact-quarantine-limit-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const retainedName = linuxBrokerQuarantineSlotNameForTest(0);
    const retainedDirectory = join(stateDirectory, retainedName);
    const retainedPath = join(retainedDirectory, 'broker.sock');
    const retainedServer = createServer();
    let broker: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      await mkdir(retainedDirectory, { mode: 0o700 });
      await listenForTest(retainedServer, retainedPath);
      await chmod(retainedPath, 0o600);
      broker = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: createInProcessReclamationCoordinatorV4('exact-quarantine-limit'),
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
        allowInProcessPhysicalPathBackendForTests: true,
        unixQuarantineLimitForTests: 2,
      });
      const brokerMetadata = await lstat(endpoint);
      await broker.close();
      broker = null;

      const quarantineNames = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.equal(quarantineNames.length, 2);
      assert.equal(quarantineNames.includes(retainedName), true);
      const reservationName = quarantineNames.find((name) => name !== retainedName)!;
      const reservationPath = join(stateDirectory, reservationName);
      const reservation = await lstat(reservationPath);
      assert.equal(reservation.isDirectory(), true);
      assert.equal(reservation.mode & 0o077, 0);
      assert.deepEqual(await readdir(reservationPath), ['broker.sock']);
      const retainedEndpoint = await lstat(join(reservationPath, 'broker.sock'));
      assert.equal(retainedEndpoint.isSocket(), true);
      assert.equal(retainedEndpoint.dev, brokerMetadata.dev);
      assert.equal(retainedEndpoint.ino, brokerMetadata.ino);
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      await broker?.close().catch(() => undefined);
      await closeForTest(retainedServer);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux close fails before endpoint mutation when hostile capacity changes after reservation',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-capacity-race-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const retainedName = linuxBrokerQuarantineSlotNameForTest(0);
    const retainedDirectory = join(stateDirectory, retainedName);
    const retainedPath = join(retainedDirectory, 'broker.sock');
    const hostileName = linuxBrokerQuarantineSlotNameForTest(2);
    const hostileDirectory = join(stateDirectory, hostileName);
    const hostilePath = join(hostileDirectory, 'broker.sock');
    const retainedServer = createServer();
    const hostileServer = createServer();
    let enterReservationBarrier!: () => void;
    const reservationBarrierEntered = new Promise<void>((resolveEntered) => {
      enterReservationBarrier = resolveEntered;
    });
    let releaseReservationBarrier!: () => void;
    const reservationBarrierCanReturn = new Promise<void>((resolveBarrier) => {
      releaseReservationBarrier = resolveBarrier;
    });
    let broker: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      await mkdir(retainedDirectory, { mode: 0o700 });
      await listenForTest(retainedServer, retainedPath);
      await chmod(retainedPath, 0o600);
      broker = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: createInProcessReclamationCoordinatorV4('hostile-reservation-capacity'),
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
        allowInProcessPhysicalPathBackendForTests: true,
        unixQuarantineLimitForTests: 2,
        afterLinuxQuarantineReservationForTests: async () => {
          enterReservationBarrier();
          await reservationBarrierCanReturn;
        },
      });
      const endpointBefore = await lstat(endpoint);
      const closeResult = broker.close().then(
        () => ({ kind: 'closed' as const }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      const entered = await deadlineOutcomeForTest(
        reservationBarrierEntered.then(() => 'entered' as const),
        300,
      );
      if (entered.kind === 'timeout') {
        const earlyClose = await closeResult;
        assert.equal(earlyClose.kind, 'rejected');
      }
      assert.deepEqual(entered, { kind: 'settled', value: 'entered' });

      await mkdir(hostileDirectory, { mode: 0o700 });
      await listenForTest(hostileServer, hostilePath);
      await chmod(hostilePath, 0o600);
      const namesAtBarrier = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.equal(namesAtBarrier.length, 3);
      releaseReservationBarrier();
      const result = await closeResult;
      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') assert.match(result.error.message, /UNKNOWN_FAILURE|REPOSITORY_BUSY/);
      broker = null;

      const endpointAfter = await lstat(endpoint);
      assert.equal(endpointAfter.dev, endpointBefore.dev);
      assert.equal(endpointAfter.ino, endpointBefore.ino);
      assert.deepEqual(
        (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort(),
        namesAtBarrier,
      );
    } finally {
      releaseReservationBarrier();
      await broker?.close().catch(() => undefined);
      await closeForTest(hostileServer);
      await closeForTest(retainedServer);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux quarantine budget rejects cycle three before listener effects without deleting debris',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-quarantine-budget-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const physicalBackend = await linuxNativePhysicalPathBackendForTest();
    const coordinator = createInProcessReclamationCoordinatorV4('quarantine-budget');
    let endpointProofs = 0;
    const platformVerifier: BrokerIpcPlatformVerifierV4 = {
      verifyOwnerOnlyPath: async ({ kind, expected_owner_identity }) => {
        if (kind === 'endpoint') endpointProofs += 1;
        return { owner_identity: expected_owner_identity };
      },
      verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    };
    const dependencies = {
      daemon: minimalDaemonForIpcTest(),
      stateDirectory,
      endpoint,
      platform: 'linux' as const,
      platformVerifier,
      endpointCoordinator: coordinator,
      allowInProcessCoordinatorForTests: true,
      unixPhysicalPathBackend: physicalBackend,
      allowInProcessPhysicalPathBackendForTests: true,
      unixQuarantineLimitForTests: 2,
    };
    const childPidsBefore = await linuxChildPidsForTest();
    let unexpectedServer: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const server = await createBrokerIpcServer(dependencies);
        await server.close();
      }
      const beforeNames = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.equal(beforeNames.length, 2);
      const beforeIdentities = await Promise.all(
        beforeNames.map(async (name) => {
          const metadata = await lstat(join(stateDirectory, name));
          return `${metadata.dev}:${metadata.ino}`;
        }),
      );
      endpointProofs = 0;

      const third = await createBrokerIpcServer(dependencies).then(
        (server) => ({ kind: 'created' as const, server }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      if (third.kind === 'created') {
        unexpectedServer = third.server;
        await unexpectedServer.close();
        unexpectedServer = null;
      }

      assert.equal(third.kind, 'rejected');
      if (third.kind === 'rejected') assert.match(third.error.message, /REPOSITORY_BUSY/);
      assert.equal(endpointProofs, 0);
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      const afterNames = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')).sort();
      assert.deepEqual(afterNames, beforeNames);
      const afterIdentities = await Promise.all(
        afterNames.map(async (name) => {
          const metadata = await lstat(join(stateDirectory, name));
          return `${metadata.dev}:${metadata.ino}`;
        }),
      );
      assert.deepEqual(afterIdentities, beforeIdentities);
      assert.deepEqual(await linuxChildPidsForTest(), childPidsBefore);
    } finally {
      await unexpectedServer?.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux quarantine override is test-only and cannot exceed the production ceiling',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-quarantine-override-');
    const endpoint = join(stateDirectory, 'broker.sock');
    let coordinatorEntries = 0;
    const delegate = createInProcessReclamationCoordinatorV4('quarantine-override-delegate');
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'in-process-test', identity: 'quarantine-override-coordinator' },
      runExclusive: (key, operation) =>
        delegate.runExclusive(key, async () => {
          coordinatorEntries += 1;
          return operation();
        }),
    };
    const common = {
      daemon: minimalDaemonForIpcTest(),
      stateDirectory,
      endpoint,
      platform: 'linux' as const,
      platformVerifier: {
        verifyOwnerOnlyPath: async ({ expected_owner_identity }: { expected_owner_identity: string }) => ({
          owner_identity: expected_owner_identity,
        }),
        verifyPeer: async ({ expected_owner_identity }: { expected_owner_identity: string }) => ({
          owner_identity: expected_owner_identity,
        }),
      },
      endpointCoordinator: coordinator,
      allowInProcessCoordinatorForTests: true,
      unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
    };
    try {
      await assert.rejects(() => createBrokerIpcServer({ ...common, unixQuarantineLimitForTests: 2 }), /AUTHENTICATION_FAILED/);
      await assert.rejects(
        () =>
          createBrokerIpcServer({
            ...common,
            allowInProcessPhysicalPathBackendForTests: true,
            unixQuarantineLimitForTests: 65,
          }),
        /AUTHENTICATION_FAILED/,
      );
      assert.equal(coordinatorEntries, 0);
      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux quarantine admission rejects a hostile matching file without deleting it',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-hostile-quarantine-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const hostileName = `.broker.sock.quarantine-999-${'a'.repeat(32)}`;
    const hostilePath = join(stateDirectory, hostileName);
    await writeFile(hostilePath, 'hostile quarantine bytes', { mode: 0o600 });
    let endpointProofs = 0;
    let unexpectedServer: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      const result = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ kind, expected_owner_identity }) => {
            if (kind === 'endpoint') endpointProofs += 1;
            return { owner_identity: expected_owner_identity };
          },
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator: createInProcessReclamationCoordinatorV4('hostile-quarantine'),
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
        allowInProcessPhysicalPathBackendForTests: true,
        unixQuarantineLimitForTests: 2,
      }).then(
        (server) => ({ kind: 'created' as const, server }),
        (error: Error) => ({ kind: 'rejected' as const, error }),
      );
      if (result.kind === 'created') {
        unexpectedServer = result.server;
        await unexpectedServer.close();
        unexpectedServer = null;
      }

      assert.equal(result.kind, 'rejected');
      if (result.kind === 'rejected') assert.match(result.error.message, /AUTHENTICATION_FAILED/);
      assert.equal(endpointProofs, 0);
      assert.equal(await readFile(hostilePath, 'utf8'), 'hostile quarantine bytes');
      assert.deepEqual(
        (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-')),
        [hostileName],
      );
    } finally {
      await unexpectedServer?.close().catch(() => undefined);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'post-listen Unix reproof failure closes the server handle and leaves a replacement endpoint intact',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-post-listen-reproof-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const preexistingServers = new Set(activeServersForTest());
    let inspections = 0;
    const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
      inspections += 1;
      const valid = physicalInspection(state_directory, expected_owner_identity);
      if (inspections < 7) return valid;
      return {
        ...valid,
        components: valid.components.map((component, index) =>
          index === valid.components.length - 1 ? { ...component, kind: 'symbolic-link' as const } : component,
        ),
      };
    }, 'post-listen-reproof');
    let replacement: Server | null = null;
    try {
      await assert.rejects(
        () =>
          createBrokerIpcServer({
            daemon: minimalDaemonForIpcTest(),
            stateDirectory,
            endpoint,
            platform: 'linux',
            platformVerifier: {
              verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
              verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
            },
            endpointCoordinator,
            allowInProcessCoordinatorForTests: true,
            unixPhysicalPathBackend: backend,
            allowInProcessPhysicalPathBackendForTests: true,
            loadToken: async () => 'a'.repeat(64),
          }),
        /AUTHENTICATION_FAILED|UNKNOWN_FAILURE/,
      );

      replacement = createServer();
      await listenForTest(replacement, endpoint);
      assert.equal((await lstat(endpoint)).isSocket(), true);
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      assert.equal((await lstat(endpoint)).isSocket(), true);
    } finally {
      if (replacement !== null) await closeForTest(replacement);
      for (const active of activeServersForTest()) {
        if (!preexistingServers.has(active)) await closeForTest(active);
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test('rejects incomplete, ambiguous, untrusted, or insecure Unix physical metadata before coordination', async () => {
  const stateDirectory = '/invalid-physical/state';
  const endpoint = '/invalid-physical/state/broker.sock';
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const invalidInspections = [
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, chain_complete: false }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, kind: 'reparse-alias' as const } : component)),
    }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, object_identity: null } : component)),
    }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, owner_trusted: false } : component)),
    }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, writable_by_untrusted: true } : component)),
    }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) =>
        index === valid.components.length - 1 ? { ...component, owner_identity: 'uid:attacker' } : component,
      ),
    }),
    (valid: UnixPhysicalPathInspectionV4) => ({
      ...valid,
      components: valid.components.map((component, index) =>
        index === valid.components.length - 1 ? { ...component, owner_only: false } : component,
      ),
    }),
  ];

  for (const invalidate of invalidInspections) {
    let physicalInspections = 0;
    let coordinatorEffects = 0;
    const physicalPath = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
      physicalInspections += 1;
      return invalidate(physicalInspection(state_directory, expected_owner_identity));
    });
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'native-cross-process', identity: 'invalid-physical-coordinator' },
      runExclusive: async () => {
        coordinatorEffects += 1;
        throw new Error('must not coordinate');
      },
    };
    await assert.rejects(
      () =>
        createBrokerIpcServer({
          daemon,
          stateDirectory,
          endpoint,
          platform: 'linux',
          platformVerifier: verifier,
          endpointCoordinator: coordinator,
          unixPhysicalPathBackend: physicalPath,
          allowInProcessPhysicalPathBackendForTests: true,
          loadToken: async () => 'a'.repeat(64),
        }),
      /AUTHENTICATION_FAILED/,
    );
    assert.equal(physicalInspections, 1);
    assert.equal(coordinatorEffects, 0);
  }
});

test('cleans a listener when the endpoint coordinator rejects after a successful startup callback', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-release-rejection-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-release-rejection-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  let coordinatorCalls = 0;
  const rejectingCoordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'release-rejection-test' },
    runExclusive: async (_key, operation) => {
      const result = await operation();
      coordinatorCalls += 1;
      if (coordinatorCalls === 1) throw new Error('EACCES C:\\Users\\secret-owner\\native-mutex-release');
      return result;
    },
  };
  const preexistingServers = new Set(activeServersForTest());
  let replacement: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;

  try {
    await assert.rejects(
      () =>
        createBrokerIpcServer({
          daemon,
          stateDirectory,
          endpoint,
          platform: process.platform,
          platformVerifier: verifier,
          endpointCoordinator: rejectingCoordinator,
          ...unixPhysicalServerTestDeps(),
        }),
      (error: Error) => /^UNKNOWN_FAILURE:/.test(error.message) && !/secret-owner|native-mutex/.test(error.message),
    );
    replacement = await createBrokerIpcServer({
      daemon,
      stateDirectory,
      endpoint,
      platform: process.platform,
      platformVerifier: verifier,
      endpointCoordinator,
      allowInProcessCoordinatorForTests: true,
      ...unixPhysicalServerTestDeps(),
    });
    assert.equal(replacement.endpoint, endpoint);
  } finally {
    if (replacement !== null) await replacement.close().catch(() => undefined);
    for (const server of activeServersForTest()) {
      if (!preexistingServers.has(server)) await closeForTest(server);
    }
  }
});

test('startup fails closed when the platform verifier cannot prove token ACL ownership', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-acl-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-acl-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async () => null,
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        ...unixPhysicalServerTestDeps(),
      }),
    /AUTHENTICATION_FAILED/,
  );
});

test('normalizes native verifier exceptions during IPC startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-verifier-leak-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-verifier-leak-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async () => {
      throw new Error('ACL tool failed at C:\\Users\\secret-owner');
    },
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        ...unixPhysicalServerTestDeps(),
      }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|ACL tool/.test(error.message),
  );
});

test('normalizes a synchronous owner-verifier throw during IPC startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-sync-verifier-leak-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-sync-verifier-leak-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: () => {
      throw new Error('ACL sync failure at C:\\Users\\secret-owner');
    },
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        ...unixPhysicalServerTestDeps(),
      }),
    (error: Error) =>
      error.message === 'AUTHENTICATION_FAILED: native state-directory ownership/ACL proof failed' &&
      !/secret-owner|ACL sync/.test(error.message),
  );
});

test('normalizes raw daemon errors before they cross IPC', async () => {
  const fixture = await ipcFixture();
  const leakingDaemon = fixture.server;
  await leakingDaemon.close();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-leak-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-leak-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const daemon = {
    ...({} as BrokerDaemonV4),
    submit: async () => {
      throw new Error('ENOENT C:\\Users\\secret-owner\\private');
    },
  };
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  const response = await server.exchangeFrameForTest(Buffer.from(canonicalJsonV4(request(token)), 'utf8'));

  assert.match(response.error ?? '', /^UNKNOWN_FAILURE:/);
  assert.doesNotMatch(response.error ?? '', /secret-owner|ENOENT/);
  await server.close();
});

test('rejects a malformed daemon reply before it crosses IPC', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-malformed-reply-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-malformed-reply-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const daemon = {
    ...({} as BrokerDaemonV4),
    submit: async () => ({ request_id: 'req_invalid', secret: 'C:\\Users\\secret-owner' }),
  } as unknown as BrokerDaemonV4;
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  try {
    const response = await server.exchangeFrameForTest(Buffer.from(canonicalJsonV4(request(token)), 'utf8'));
    assert.equal(response.error, 'UNKNOWN_FAILURE: broker request failed');
    assert.doesNotMatch(canonicalJsonV4(response), /secret-owner|Users/);
  } finally {
    await server.close();
  }
});

test('rejects daemon reply identities, state, and status token that disagree with the submitted command or authoritative status', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-reply-semantics-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-reply-semantics-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const authoritative = {
    ...validRuntimeResult(),
    state: 'READY_FOR_EXECUTOR',
    attempts: [],
    validation_results: [],
    head_sha: null,
    review_attestation_hash: null,
    commit_sha: null,
  } as RuntimeResultV4;
  const validReply: BrokerReplyV4 = {
    request_id: authoritative.request_id,
    run_id: authoritative.run_id,
    state: authoritative.state,
    status_token: hashCanonicalV4({
      run_id: authoritative.run_id,
      state: authoritative.state,
      artifact_manifest_hash: authoritative.artifact_manifest_hash,
    }),
  };
  let submittedReply = validReply;
  const daemon = { ...({} as BrokerDaemonV4), submit: async () => submittedReply, status: async () => authoritative };
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  try {
    for (const mismatch of [
      { ...validReply, request_id: 'req_DIFFERENTREQUEST000000000' },
      { ...validReply, run_id: 'run_DIFFERENTRUN00000000000000' },
      { ...validReply, state: 'EXECUTION_STARTED' },
      { ...validReply, status_token: 'e'.repeat(64) },
    ]) {
      submittedReply = mismatch;
      const response = await server.exchangeFrameForTest(Buffer.from(canonicalJsonV4(request(token)), 'utf8'));
      assert.equal(response.error, 'UNKNOWN_FAILURE: broker request failed');
    }
  } finally {
    await server.close();
  }
});

test('normalizes malicious server response errors to a bounded closed-catalog reply', () => {
  assert.equal(
    normalizeBrokerResponseErrorV4('UNKNOWN_FAILURE: ENOENT C:\\Users\\secret-owner\\private'),
    'UNKNOWN_FAILURE: broker request failed',
  );
  assert.equal(normalizeBrokerResponseErrorV4('NOT_A_CODE: secret'), 'UNKNOWN_FAILURE: broker request failed');
});

test('strictly loads canonical IPC replies and rejects malformed reply objects without leakage', () => {
  const valid = canonicalJsonV4({
    ok: true,
    reply: {
      request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
      run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
      state: 'READY_FOR_EXECUTOR',
      status_token: 'd'.repeat(64),
    },
  });
  assert.equal(loadBrokerIpcResponseV4(valid).reply?.status_token, 'd'.repeat(64));

  for (const malicious of [
    'null',
    '{}',
    canonicalJsonV4({ ok: true, reply: null }),
    canonicalJsonV4({
      ok: true,
      reply: {
        request_id: 'req_bad',
        run_id: 'run_bad',
        state: 'READY_FOR_EXECUTOR',
        status_token: 'secret C:\\Users\\owner',
        extra: true,
      },
    }),
    canonicalJsonV4({
      ok: true,
      reply: {
        request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
        run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
        state: 'VALID_SHAPED_BUT_UNKNOWN',
        status_token: 'd'.repeat(64),
      },
    }),
    JSON.stringify({ ok: false, error: 'UNKNOWN_FAILURE: C:\\Users\\owner\\private' }, null, 2),
  ]) {
    assert.throws(
      () => loadBrokerIpcResponseV4(malicious),
      (error: Error) => /^UNKNOWN_FAILURE: broker response rejected$/.test(error.message) && !/Users|owner|private/.test(error.message),
    );
  }

  const failure = loadBrokerIpcResponseV4(canonicalJsonV4({ ok: false, error: 'AUTHENTICATION_FAILED: C:\\Users\\owner\\token' }));
  assert.equal(failure.error, 'AUTHENTICATION_FAILED: authentication failed');
});

test('normalizes a synchronous client transport failure without exposing its path', async () => {
  const client = createBrokerIpcClient({
    endpoint: 'private-endpoint',
    token: '0'.repeat(64),
    platform: 'win32',
    serverIdentityVerifier: clientVerifier('private-endpoint'),
    connect: () => {
      throw new Error('ENOENT C:\\Users\\secret-owner\\broker.sock');
    },
  });

  await assert.rejects(
    () => client.submit(request('0'.repeat(64)).command),
    (error: Error) => error.message === 'UNKNOWN_FAILURE: broker request failed' && !/secret-owner|ENOENT/.test(error.message),
  );
});

test('normalizes a synchronous server-identity verifier throw without exposing its path', async () => {
  const socket = synchronouslyConnectingSocketForTest();
  const client = createBrokerIpcClient({
    endpoint: 'private-endpoint',
    token: '0'.repeat(64),
    platform: 'win32',
    serverIdentityVerifier: {
      verifyServer: () => {
        throw new Error('ACL sync failure at C:\\Users\\secret-owner\\broker.sock');
      },
    },
    connect: () => socket,
  });

  try {
    await assert.rejects(
      () => client.submit(request('0'.repeat(64)).command),
      (error: Error) => error.message === 'AUTHENTICATION_FAILED: authentication failed' && !/secret-owner|ACL sync/.test(error.message),
    );
  } finally {
    await client.close();
    socket.destroy();
  }
});

test('client rejects a valid-shaped reply belonging to a different request', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-cross-request-'));
  const endpoint =
    process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-cross-request-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const crossRequestReply = {
    ok: true,
    reply: {
      request_id: 'req_DIFFERENTREQUEST000000000',
      run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
      state: 'READY_FOR_EXECUTOR',
      status_token: 'd'.repeat(64),
    },
  };
  const rawServer = createServer((socket) => {
    socket.once('data', () => socket.end(frameForTest(crossRequestReply)));
  });
  await listenForTest(rawServer, endpoint);
  const client = createBrokerIpcClient({
    endpoint,
    token: '0'.repeat(64),
    platform: process.platform,
    serverIdentityVerifier: clientVerifier(endpoint),
    ...unixPhysicalClientTestDeps(stateDirectory),
  });

  try {
    await assert.rejects(
      () => client.submit(request('0'.repeat(64)).command),
      (error: Error) => error.message === 'UNKNOWN_FAILURE: broker request failed',
    );
  } finally {
    await client.close();
    await closeForTest(rawServer);
  }
});

test('normalizes injected token-storage and server-close failures', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-lifecycle-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-lifecycle-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const daemon = {
    submit: async () => {
      throw new Error('must not submit');
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
    recover: async () => {},
    close: async () => {},
    recordAttempt: async () => {},
    reinspect: async () => {},
    recordExternalProcessStarted: async () => {},
  } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };

  await assert.rejects(
    () =>
      createBrokerIpcServer({
        daemon,
        stateDirectory,
        endpoint,
        platform: process.platform,
        platformVerifier: verifier,
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        loadToken: async () => {
          throw new Error('EACCES C:\\Users\\secret-owner\\token');
        },
        ...unixPhysicalServerTestDeps(),
      }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|EACCES/.test(error.message),
  );

  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
    closeServer: async (nativeServer) => {
      await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
      throw new Error('EPERM C:\\Users\\secret-owner\\pipe');
    },
  });
  await assert.rejects(
    () => server.close(),
    (error: Error) => /^UNKNOWN_FAILURE:/.test(error.message) && !/secret-owner|EPERM/.test(error.message),
  );
});

test('replayed mutation over IPC returns the original run without another journal append', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-repo-'));
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-replay-'));
  await mkdir(join(repositoryRoot, 'src'));
  await writeFile(join(repositoryRoot, 'src', 'greeting.ts'), 'export const greeting = true;');
  const daemon = createBrokerDaemon({
    stateDirectory,
    registry: {
      repositories: [
        {
          repository_id: 'fixture-repo',
          canonical_root: repositoryRoot,
          policy_ref: 'policy',
          profile_ref: 'profile',
          worktree_parent: join(repositoryRoot, '.worktrees'),
          state_path: stateDirectory,
        },
      ],
    },
    loadPolicy: async () => freezeRepositoryPolicy(validRepositoryPolicy() as RuntimeRepositoryPolicyV4),
    loadProfile: async () => validRuntimeProfile() as RuntimeProfileV4,
    resolveBaseSha: async () => 'b'.repeat(40),
    sandboxProfiles: { 'executor-networked': {}, 'frontier-networked': {}, 'validation-untrusted': {}, 'review-capsule': {} },
    inspectChanges: async (input) =>
      input.changes.map((change) => ({ ...change, canonical_parent: join(repositoryRoot, 'src'), existed_at_freeze: true })),
    generateRunId: () => 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    lockOwnerStatus: async () => 'dead',
    reclamationCoordinator: endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
  });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-replay-${Date.now()}` : join(stateDirectory, 'broker.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
    verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
  };
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    platformVerifier: verifier,
    endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
    ...unixPhysicalServerTestDeps(),
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
  const client = createBrokerIpcClient({
    endpoint,
    token,
    platform: process.platform,
    serverIdentityVerifier: clientVerifier(endpoint),
    ...unixPhysicalClientTestDeps(stateDirectory),
  });
  const command = request(token).command;

  const first = await client.submit(command);
  const replay = await client.submit({ ...command, command_id: 'command-replayed' });
  assert.equal(replay.run_id, first.run_id);
  await client.close();
  await server.close();
  await daemon.close();
  const journal = await reopenJournalV4(stateDirectory);
  assert.equal(journal.records.length, 1);
  await journal.close();
});

test('reclaims only a proven-stale owner-only Unix socket', async () => {
  let removed = false;
  let quarantine = '';
  await reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', {
    metadata: async (path) => ({
      kind: 'socket',
      owner_identity: 'uid:1000',
      owner_only: true,
      object_identity: path === '/state/broker.sock' ? 'inode:7' : 'inode:7',
    }),
    probe: async () => 'stale',
    rename: async (_from, to) => {
      quarantine = to;
    },
    removeQuarantine: async (path) => {
      assert.equal(path, quarantine);
      removed = true;
    },
    restoreQuarantine: async () => {
      throw new Error('not expected');
    },
  });
  assert.equal(removed, true);
});

test('normalizes a synchronous metadata throw during an ENOENT stale-reclaim recheck', async () => {
  let metadataReads = 0;
  await assert.rejects(
    () =>
      reclaimUnixSocketV4('/state/private/broker.sock', 'uid:1000', {
        metadata: () => {
          metadataReads += 1;
          if (metadataReads === 1)
            return Promise.resolve({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:7' });
          throw new Error('EACCES /state/private/broker.sock');
        },
        probe: async () => 'stale',
        rename: async () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        },
        removeQuarantine: async () => {
          throw new Error('not expected');
        },
        restoreQuarantine: async () => {
          throw new Error('not expected');
        },
      }),
    (error: Error) =>
      error.message === 'AUTHENTICATION_FAILED: broker endpoint metadata unavailable' && !/private|EACCES/.test(error.message),
  );
});

test('restores a live replacement that appears after stale probe but before quarantine rename', async () => {
  let endpointIdentity: string | null = 'inode:7';
  const quarantines = new Map<string, string>();
  let removed = false;
  await assert.rejects(
    () =>
      reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', {
        metadata: async (path) => {
          const identity = path === '/state/broker.sock' ? endpointIdentity : (quarantines.get(path) ?? null);
          return identity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: identity };
        },
        probe: async () => {
          endpointIdentity = 'inode:8';
          return 'stale';
        },
        rename: async (_from, to) => {
          quarantines.set(to, endpointIdentity!);
          endpointIdentity = null;
        },
        removeQuarantine: async () => {
          removed = true;
        },
        restoreQuarantine: async (from) => {
          endpointIdentity = quarantines.get(from) ?? null;
          quarantines.delete(from);
        },
      }),
    /REPOSITORY_BUSY/,
  );
  assert.equal(endpointIdentity, 'inode:8');
  assert.equal(removed, false);
});

test('removes a Unix endpoint only when its current object identity is the owned socket', async () => {
  let removed = false;
  await removeOwnedUnixEndpointV4(
    '/state/broker.sock',
    'inode:7',
    {
      metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:8' }),
      remove: async () => {
        removed = true;
      },
    },
    endpointCoordinator,
    physicalCleanupSecurity('/state'),
  );
  assert.equal(removed, false);

  await assert.rejects(
    () =>
      removeOwnedUnixEndpointV4(
        '/state/broker.sock',
        'inode:7',
        {
          metadata: async () => {
            throw new Error('EACCES /home/private/broker.sock');
          },
          remove: async () => {
            removed = true;
          },
        },
        endpointCoordinator,
        physicalCleanupSecurity('/state'),
      ),
    (error: Error) => error.message === 'UNKNOWN_FAILURE: local IPC endpoint cleanup failed' && !/private|EACCES/.test(error.message),
  );
});

test('owned Unix endpoint cleanup keeps a replacement scheduled after its first metadata observation', async () => {
  const endpoint = '/state/broker.sock';
  const delegate = createInProcessReclamationCoordinatorV4('owned-cleanup-race-delegate');
  let cleanupCoordinatorKey = '';
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'owned-cleanup-race' },
    runExclusive: async (key, operation) => {
      cleanupCoordinatorKey = key;
      return delegate.runExclusive(key, operation);
    },
  };
  let endpointIdentity: string | null = 'inode:7';
  let releaseMetadata!: () => void;
  const metadataCanReturn = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  let observedMetadata!: () => void;
  const metadataObserved = new Promise<void>((resolve) => {
    observedMetadata = resolve;
  });
  const cleanup = removeOwnedUnixEndpointV4(
    endpoint,
    'inode:7',
    {
      metadata: async () => {
        const observedIdentity = endpointIdentity;
        observedMetadata();
        await metadataCanReturn;
        return observedIdentity === null
          ? null
          : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
      },
      remove: async () => {
        endpointIdentity = null;
      },
    },
    coordinator,
    physicalCleanupSecurity('/state'),
  );

  await metadataObserved;
  const replacement = coordinator.runExclusive(cleanupCoordinatorKey, async () => {
    endpointIdentity = 'inode:8';
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseMetadata();
  await Promise.all([cleanup, replacement]);

  assert.equal(endpointIdentity, 'inode:8');
});

test('equivalent Unix endpoint aliases share cleanup coordination and preserve a live replacement', async () => {
  const aliasEndpoint = '/state/./broker.sock';
  const canonicalEndpoint = '/state/broker.sock';
  const delegate = createInProcessReclamationCoordinatorV4('owned-cleanup-alias-race-delegate');
  let cleanupCoordinatorKey = '';
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'owned-cleanup-alias-race' },
    runExclusive: async (key, operation) => {
      cleanupCoordinatorKey = key;
      return delegate.runExclusive(key, operation);
    },
  };
  const observedPaths: string[] = [];
  let endpointIdentity: string | null = 'inode:7';
  let releaseMetadata!: () => void;
  const metadataCanReturn = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  let observedMetadata!: () => void;
  const metadataObserved = new Promise<void>((resolve) => {
    observedMetadata = resolve;
  });
  const cleanup = removeOwnedUnixEndpointV4(
    aliasEndpoint,
    'inode:7',
    {
      metadata: async (path) => {
        observedPaths.push(path);
        const observedIdentity = endpointIdentity;
        observedMetadata();
        await metadataCanReturn;
        return observedIdentity === null
          ? null
          : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
      },
      remove: async (path) => {
        observedPaths.push(path);
        endpointIdentity = null;
      },
    },
    coordinator,
    physicalCleanupSecurity('/state'),
  );

  await metadataObserved;
  const replacement = coordinator.runExclusive(cleanupCoordinatorKey, async () => {
    endpointIdentity = 'inode:8';
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseMetadata();
  await Promise.all([cleanup, replacement]);

  assert.equal(endpointIdentity, 'inode:8');
  assert.deepEqual(observedPaths, [canonicalEndpoint, canonicalEndpoint]);
});

test('two textual routes to the same physical Unix state tree derive one coordinator identity', async () => {
  const routeAState = '/route-a/state';
  const routeBState = '/route-b/state';
  const backend = physicalPathBackend(
    async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity),
    'same-tree-key',
  );
  const delegate = createInProcessReclamationCoordinatorV4('same-tree-key-delegate');
  const coordinatorKeys: string[] = [];
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'same-tree-key-coordinator' },
    runExclusive: async (key, operation) => {
      coordinatorKeys.push(key);
      return delegate.runExclusive(key, operation);
    },
  };
  const deps = {
    metadata: async () => null,
    remove: async () => {
      throw new Error('nothing was owned');
    },
  };

  await removeOwnedUnixEndpointV4('/route-a/state/broker.sock', 'inode:7', deps, coordinator, {
    stateDirectory: routeAState,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: backend,
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  });
  await removeOwnedUnixEndpointV4('/route-b/state/broker.sock', 'inode:7', deps, coordinator, {
    stateDirectory: routeBState,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: backend,
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  });

  assert.equal(coordinatorKeys.length, 2);
  assert.equal(coordinatorKeys[0], coordinatorKeys[1]);
  assert.doesNotMatch(coordinatorKeys[0]!, /route-a|route-b|broker\.sock/);
});

test(
  'real Linux textual routes to one physical state directory share the coordinator key',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-native-alias-');
    const leafName = stateDirectory.slice(stateDirectory.lastIndexOf('/') + 1);
    const routeA = `${stateDirectory}/.`;
    const routeB = `${stateDirectory}/../${leafName}`;
    const backend = await linuxNativePhysicalPathBackendForTest();
    const delegate = createInProcessReclamationCoordinatorV4('native-alias-delegate');
    const coordinatorKeys: string[] = [];
    const coordinator: ReclamationCoordinatorV4 = {
      certification: { kind: 'in-process-test', identity: 'native-alias-recorder' },
      runExclusive: async (key, operation) => {
        coordinatorKeys.push(key);
        return delegate.runExclusive(key, operation);
      },
    };
    const forbiddenRawDependencies = {
      metadata: async () => {
        throw new Error('raw endpoint metadata must not be used');
      },
      remove: async () => {
        throw new Error('raw endpoint unlink must not be used');
      },
    };
    try {
      for (const route of [routeA, routeB]) {
        await removeOwnedUnixEndpointV4(`${route}/broker.sock`, 'not-present', forbiddenRawDependencies, coordinator, {
          stateDirectory: route,
          expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
          unixPhysicalPathBackend: backend,
          allowInProcessCoordinatorForTests: true,
        });
      }

      assert.equal(coordinatorKeys.length, 2);
      assert.equal(coordinatorKeys[0], coordinatorKeys[1]);
      assert.doesNotMatch(coordinatorKeys[0]!, new RegExp(leafName));
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'real Linux bind-mount aliases to one final state directory share the coordinator key',
  {
    skip: process.platform !== 'linux' || process.env.AO_PRIVILEGED_BIND_MOUNT_TEST !== '1',
  },
  async () => {
    const fixtureRoot = await linuxSecureDirectoryForTest('.runner-v4-bind-mount-alias-');
    const physicalParent = join(fixtureRoot, 'physical-parent');
    const aliasParent = join(fixtureRoot, 'alias-parent');
    const physicalState = join(physicalParent, 'state');
    const aliasState = join(aliasParent, 'mounted-state');
    await mkdir(physicalParent, { mode: 0o700 });
    await mkdir(aliasParent, { mode: 0o700 });
    await mkdir(physicalState, { mode: 0o700 });
    await mkdir(aliasState, { mode: 0o700 });
    let mounted = false;
    try {
      await runExecutableForTest('/usr/bin/mount', ['--bind', physicalState, aliasState]);
      mounted = true;
      const physicalMetadata = await lstat(physicalState);
      const aliasMetadata = await lstat(aliasState);
      assert.equal(aliasMetadata.dev, physicalMetadata.dev);
      assert.equal(aliasMetadata.ino, physicalMetadata.ino);

      const backend = await linuxNativePhysicalPathBackendForTest();
      const delegate = createInProcessReclamationCoordinatorV4('native-bind-alias-delegate');
      const coordinatorKeys: string[] = [];
      const coordinator: ReclamationCoordinatorV4 = {
        certification: { kind: 'in-process-test', identity: 'native-bind-alias-recorder' },
        runExclusive: async (key, operation) => {
          coordinatorKeys.push(key);
          return delegate.runExclusive(key, operation);
        },
      };
      const forbiddenRawDependencies = {
        metadata: async () => {
          throw new Error('raw endpoint metadata must not be used');
        },
        remove: async () => {
          throw new Error('raw endpoint unlink must not be used');
        },
      };

      for (const route of [physicalState, aliasState]) {
        await removeOwnedUnixEndpointV4(join(route, 'broker.sock'), 'not-present', forbiddenRawDependencies, coordinator, {
          stateDirectory: route,
          expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
          unixPhysicalPathBackend: backend,
          allowInProcessCoordinatorForTests: true,
        });
      }

      assert.equal(coordinatorKeys.length, 2);
      assert.equal(coordinatorKeys[0], coordinatorKeys[1]);
      assert.doesNotMatch(coordinatorKeys[0]!, /physical-parent|alias-parent|mounted-state|broker\.sock/);
    } finally {
      if (mounted) await runExecutableForTest('/usr/bin/umount', [aliasState]).catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux cleanup rejects an external socket hard link without changing either name or inode',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const fixtureRoot = await linuxSecureDirectoryForTest('.runner-v4-external-hardlink-');
    const stateDirectory = join(fixtureRoot, 'state');
    const externalDirectory = join(fixtureRoot, 'external');
    const endpoint = join(stateDirectory, 'broker.sock');
    const heldEndpoint = join(stateDirectory, 'held-broker.sock');
    const externalAlias = join(externalDirectory, 'broker-alias.sock');
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    const oldServer = createServer();
    try {
      await listenForTest(oldServer, endpoint);
      await chmod(endpoint, 0o600);
      await rename(endpoint, heldEndpoint);
      await closeForTest(oldServer);
      await rename(heldEndpoint, endpoint);
      await link(endpoint, externalAlias);
      const endpointBefore = await lstat(endpoint);
      const aliasBefore = await lstat(externalAlias);
      const stateNamesBefore = (await readdir(stateDirectory)).sort();
      assert.equal(endpointBefore.nlink, 2);
      assert.equal(aliasBefore.dev, endpointBefore.dev);
      assert.equal(aliasBefore.ino, endpointBefore.ino);
      const physicalBackend = await linuxNativePhysicalPathBackendForTest();

      await assert.rejects(
        () =>
          removeOwnedUnixEndpointV4(
            endpoint,
            `linux:dev:${endpointBefore.dev}:ino:${endpointBefore.ino}`,
            {
              metadata: async () => {
                throw new Error('native cleanup must not use raw endpoint metadata');
              },
              remove: async () => {
                throw new Error('native cleanup must not use raw endpoint unlink');
              },
            },
            endpointCoordinator,
            {
              stateDirectory,
              expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
              unixPhysicalPathBackend: physicalBackend,
              allowInProcessCoordinatorForTests: true,
            },
          ),
        /AUTHENTICATION_FAILED|UNKNOWN_FAILURE|REPOSITORY_BUSY/,
      );

      const endpointAfter = await lstat(endpoint);
      const aliasAfter = await lstat(externalAlias);
      assert.deepEqual((await readdir(stateDirectory)).sort(), stateNamesBefore);
      assert.equal(endpointAfter.dev, endpointBefore.dev);
      assert.equal(endpointAfter.ino, endpointBefore.ino);
      assert.equal(endpointAfter.nlink, 2);
      assert.equal(aliasAfter.dev, aliasBefore.dev);
      assert.equal(aliasAfter.ino, aliasBefore.ino);
      assert.equal(aliasAfter.nlink, 2);
    } finally {
      await closeForTest(oldServer);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test(
  'production Linux helper re-proves socket link count after the JavaScript quarantine checks',
  {
    skip: process.platform !== 'linux',
  },
  async () => {
    const fixtureRoot = await linuxSecureDirectoryForTest('.runner-v4-final-hardlink-');
    const stateDirectory = join(fixtureRoot, 'state');
    const externalDirectory = join(fixtureRoot, 'external');
    const endpoint = join(stateDirectory, 'broker.sock');
    const externalAlias = join(externalDirectory, 'broker-alias.sock');
    await mkdir(stateDirectory, { mode: 0o700 });
    await mkdir(externalDirectory, { mode: 0o700 });
    let endpointAtBarrier: Awaited<ReturnType<typeof lstat>> | null = null;
    let namesAtBarrier: string[] = [];
    let server: Awaited<ReturnType<typeof createBrokerIpcServer>> | null = null;
    try {
      server = await createBrokerIpcServer({
        daemon: minimalDaemonForIpcTest(),
        stateDirectory,
        endpoint,
        platform: 'linux',
        platformVerifier: {
          verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
          verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }),
        },
        endpointCoordinator,
        allowInProcessCoordinatorForTests: true,
        unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
        allowInProcessPhysicalPathBackendForTests: true,
        requestDeadlineMs: 1_000,
        afterLinuxQuarantineReadyForRenameForTests: async () => {
          endpointAtBarrier = await lstat(endpoint);
          namesAtBarrier = (await readdir(stateDirectory)).sort();
          await link(endpoint, externalAlias);
        },
      });

      await assert.rejects(() => server!.close(), /UNKNOWN_FAILURE|REPOSITORY_BUSY|AUTHENTICATION_FAILED/);
      server = null;
      assert.notEqual(endpointAtBarrier, null);
      const endpointAfter = await lstat(endpoint);
      const aliasAfter = await lstat(externalAlias);
      assert.deepEqual((await readdir(stateDirectory)).sort(), namesAtBarrier);
      assert.equal(endpointAfter.dev, endpointAtBarrier!.dev);
      assert.equal(endpointAfter.ino, endpointAtBarrier!.ino);
      assert.equal(endpointAfter.nlink, 2);
      assert.equal(aliasAfter.dev, endpointAtBarrier!.dev);
      assert.equal(aliasAfter.ino, endpointAtBarrier!.ino);
      assert.equal(aliasAfter.nlink, 2);
    } finally {
      await server?.close().catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test('external Linux replacement between owned cleanup phases is never unlinked', { skip: process.platform !== 'linux' }, async () => {
  const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-external-replacement-');
  const endpoint = join(stateDirectory, 'broker.sock');
  const heldOldEndpoint = join(stateDirectory, 'held-old.sock');
  const replacementSource = join(stateDirectory, 'replacement-source.sock');
  const displacedOldEndpoint = join(stateDirectory, 'displaced-old.sock');
  const oldServer = createServer();
  let replacementProcess: ChildProcess | null = null;
  try {
    await listenForTest(oldServer, endpoint);
    await chmod(endpoint, 0o600);
    const original = await lstat(endpoint);
    const originalIdentity = `linux:dev:${original.dev}:ino:${original.ino}`;
    await rename(endpoint, heldOldEndpoint);
    await closeForTest(oldServer);
    await rename(heldOldEndpoint, endpoint);

    const replacementScript = [
      "const { renameSync, linkSync } = require('node:fs');",
      "const { createServer } = require('node:net');",
      'const source = process.argv[1];',
      'const target = process.argv[2];',
      'const displaced = process.argv[3];',
      'const server = createServer();',
      "server.listen(source, () => process.send({ kind: 'ready' }));",
      "process.on('message', (message) => {",
      "  if (message?.kind !== 'replace') return;",
      '  renameSync(target, displaced);',
      '  linkSync(source, target);',
      "  process.send({ kind: 'replaced' });",
      '});',
    ].join('\n');
    replacementProcess = spawn(process.execPath, ['-e', replacementScript, replacementSource, endpoint, displacedOldEndpoint], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await waitForChildIpcMessageForTest(replacementProcess, 'ready');

    let releaseMetadata!: () => void;
    const metadataBarrier = new Promise<void>((resolvePromise) => {
      releaseMetadata = resolvePromise;
    });
    let metadataObserved!: () => void;
    const observedMetadata = new Promise<void>((resolvePromise) => {
      metadataObserved = resolvePromise;
    });
    const backend = await linuxNativePhysicalPathBackendForTest();
    const cleanup = removeOwnedUnixEndpointV4(
      endpoint,
      originalIdentity,
      {
        metadata: async () => {
          throw new Error('native cleanup must not use raw endpoint metadata');
        },
        remove: async () => {
          throw new Error('native cleanup must not use raw endpoint unlink');
        },
        afterMetadataForTests: async () => {
          metadataObserved();
          await metadataBarrier;
        },
      },
      endpointCoordinator,
      {
        stateDirectory,
        expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
        unixPhysicalPathBackend: backend,
        allowInProcessPhysicalPathBackendForTests: true,
        allowInProcessCoordinatorForTests: true,
      },
    ).then(
      () => null,
      (error: Error) => error,
    );

    await observedMetadata;
    const replaced = waitForChildIpcMessageForTest(replacementProcess, 'replaced');
    replacementProcess.send?.({ kind: 'replace' });
    await replaced;
    releaseMetadata();
    const cleanupFailure = await cleanup;

    assert.ok(cleanupFailure instanceof Error);
    assert.match(cleanupFailure.message, /AUTHENTICATION_FAILED|UNKNOWN_FAILURE|REPOSITORY_BUSY/);
    const replacementMetadata = await lstat(endpoint);
    assert.equal(replacementMetadata.isSocket(), true);
    assert.notEqual(`linux:dev:${replacementMetadata.dev}:ino:${replacementMetadata.ino}`, originalIdentity);
    const quarantineNames = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-'));
    assert.equal(quarantineNames.length, 1);
    const failedReservation = join(stateDirectory, quarantineNames[0]!);
    assert.equal((await lstat(failedReservation)).isDirectory(), true);
    assert.deepEqual(await readdir(failedReservation), []);
    await new Promise<void>((resolvePromise, reject) => {
      const socket = createConnection(endpoint);
      socket.once('connect', () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', reject);
    });
  } finally {
    await closeForTest(oldServer);
    if (replacementProcess !== null && replacementProcess.exitCode === null && replacementProcess.signalCode === null) {
      replacementProcess.kill('SIGKILL');
      await once(replacementProcess, 'exit').catch(() => undefined);
    }
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test(
  'real Linux owned cleanup retains the exact socket in quarantine instead of pathname-unlinking it',
  { skip: process.platform !== 'linux' },
  async () => {
    const stateDirectory = await linuxSecureDirectoryForTest('.runner-v4-owned-quarantine-');
    const endpoint = join(stateDirectory, 'broker.sock');
    const heldEndpoint = join(stateDirectory, 'held-broker.sock');
    const oldServer = createServer();
    try {
      await listenForTest(oldServer, endpoint);
      await chmod(endpoint, 0o600);
      const original = await lstat(endpoint);
      const originalIdentity = `linux:dev:${original.dev}:ino:${original.ino}`;
      await rename(endpoint, heldEndpoint);
      await closeForTest(oldServer);
      await rename(heldEndpoint, endpoint);

      await removeOwnedUnixEndpointV4(
        endpoint,
        originalIdentity,
        {
          metadata: async () => {
            throw new Error('native cleanup must not use raw endpoint metadata');
          },
          remove: async () => {
            throw new Error('native cleanup must not use raw endpoint unlink');
          },
        },
        endpointCoordinator,
        {
          stateDirectory,
          expectedOwnerIdentity: currentUnixOwnerIdentityForTest(),
          unixPhysicalPathBackend: await linuxNativePhysicalPathBackendForTest(),
          allowInProcessCoordinatorForTests: true,
        },
      );

      await assert.rejects(
        () => lstat(endpoint),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      const quarantineNames = (await readdir(stateDirectory)).filter((name) => name.startsWith('.broker.sock.quarantine-'));
      assert.equal(quarantineNames.length, 1);
      const quarantine = join(stateDirectory, quarantineNames[0]!);
      assert.equal((await lstat(quarantine)).isDirectory(), true);
      const quarantined = await lstat(join(quarantine, 'broker.sock'));
      assert.equal(quarantined.dev, original.dev);
      assert.equal(quarantined.ino, original.ino);
    } finally {
      await closeForTest(oldServer);
      await rm(stateDirectory, { recursive: true, force: true });
    }
  },
);

test('physical Unix cleanup rejects an uncertified in-process coordinator before endpoint metadata effects', async () => {
  let metadataEffects = 0;
  await assert.rejects(
    () =>
      removeOwnedUnixEndpointV4(
        '/state/broker.sock',
        'inode:7',
        {
          metadata: async () => {
            metadataEffects += 1;
            return null;
          },
          remove: async () => {
            throw new Error('must not remove');
          },
        },
        createInProcessReclamationCoordinatorV4('uncertified-cleanup'),
        {
          stateDirectory: '/state',
          expectedOwnerIdentity: 'uid:1000',
          unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) =>
            physicalInspection(state_directory, expected_owner_identity),
          ),
          allowInProcessPhysicalPathBackendForTests: true,
        },
      ),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(metadataEffects, 0);
});

test('rejects a parent alias inserted before owned-endpoint unlink and leaves the legitimate socket untouched', async () => {
  let inspections = 0;
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    inspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    if (inspections === 1) return valid;
    return {
      ...valid,
      components: valid.components.map((component, index) => (index === 1 ? { ...component, kind: 'reparse-alias' as const } : component)),
    };
  }, 'inserted-alias');
  const coordinator = createInProcessReclamationCoordinatorV4('inserted-alias-coordinator');
  let legitimateSocketIdentity: string | null = 'inode:7';
  let metadataEffects = 0;
  let unlinkEffects = 0;

  await assert.rejects(
    () =>
      removeOwnedUnixEndpointV4(
        '/state/broker.sock',
        'inode:7',
        {
          metadata: async () => {
            metadataEffects += 1;
            return legitimateSocketIdentity === null
              ? null
              : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: legitimateSocketIdentity };
          },
          remove: async () => {
            unlinkEffects += 1;
            legitimateSocketIdentity = null;
          },
        },
        coordinator,
        {
          stateDirectory: '/state',
          expectedOwnerIdentity: 'uid:1000',
          unixPhysicalPathBackend: backend,
          allowInProcessPhysicalPathBackendForTests: true,
          allowInProcessCoordinatorForTests: true,
        },
      ),
    /AUTHENTICATION_FAILED/,
  );

  assert.equal(inspections, 2);
  assert.equal(metadataEffects, 0);
  assert.equal(unlinkEffects, 0);
  assert.equal(legitimateSocketIdentity, 'inode:7');
});

test('physical coordinator barrier prevents an aliased replacement from being unlinked by stale cleanup', async () => {
  const routeAState = '/route-a/state';
  const routeBState = '/route-b/state';
  const backend = physicalPathBackend(
    async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity),
    'replacement-barrier',
  );
  const coordinator = createInProcessReclamationCoordinatorV4('replacement-barrier-coordinator');
  let endpointIdentity: string | null = 'inode:7';
  let releaseOldMetadata!: () => void;
  const oldMetadataCanReturn = new Promise<void>((resolve) => {
    releaseOldMetadata = resolve;
  });
  let oldMetadataObserved!: () => void;
  const observedOldMetadata = new Promise<void>((resolve) => {
    oldMetadataObserved = resolve;
  });
  let replacementCompleted = false;

  const cleanup = removeOwnedUnixEndpointV4(
    '/route-a/state/broker.sock',
    'inode:7',
    {
      metadata: async () => {
        const observedIdentity = endpointIdentity;
        oldMetadataObserved();
        await oldMetadataCanReturn;
        return observedIdentity === null
          ? null
          : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
      },
      remove: async () => {
        endpointIdentity = null;
      },
    },
    coordinator,
    {
      stateDirectory: routeAState,
      expectedOwnerIdentity: 'uid:1000',
      unixPhysicalPathBackend: backend,
      allowInProcessPhysicalPathBackendForTests: true,
      allowInProcessCoordinatorForTests: true,
    },
  );

  await observedOldMetadata;
  const replacement = removeOwnedUnixEndpointV4(
    '/route-b/state/broker.sock',
    'never-owned',
    {
      metadata: async () => {
        endpointIdentity = 'inode:8';
        return { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: endpointIdentity };
      },
      remove: async () => {
        throw new Error('replacement must not be removed');
      },
    },
    coordinator,
    {
      stateDirectory: routeBState,
      expectedOwnerIdentity: 'uid:1000',
      unixPhysicalPathBackend: backend,
      allowInProcessPhysicalPathBackendForTests: true,
      allowInProcessCoordinatorForTests: true,
    },
  ).then(() => {
    replacementCompleted = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const replacementRacedBeforeRelease = replacementCompleted;
  releaseOldMetadata();
  await Promise.all([cleanup, replacement]);

  assert.equal(replacementRacedBeforeRelease, false);
  assert.equal(endpointIdentity, 'inode:8');
});

test('normalizes Unix endpoint metadata failure and closes the listening server', async () => {
  let closed = false;
  await assert.rejects(
    () =>
      secureUnixEndpointV4('/state/broker.sock', 'uid:1000', {
        metadata: async () => {
          throw new Error('EACCES /home/private/broker.sock');
        },
        secure: async () => {},
        verify: async () => ({ owner_identity: 'uid:1000' }),
        close: async () => {
          closed = true;
        },
        remove: async () => {
          throw new Error('must not remove an unproved endpoint');
        },
      }),
    (error: Error) => error.message === 'AUTHENTICATION_FAILED: authentication failed' && !/private|EACCES/.test(error.message),
  );
  assert.equal(closed, true);
});

test('post-listen permission failure never removes a replacement Unix socket', async () => {
  let metadataReads = 0;
  let closed = false;
  let removed = false;
  await assert.rejects(
    () =>
      secureUnixEndpointV4('/state/broker.sock', 'uid:1000', {
        metadata: async () => ({
          kind: 'socket',
          owner_identity: 'uid:1000',
          owner_only: true,
          object_identity: ++metadataReads === 1 ? 'inode:7' : 'inode:8',
        }),
        secure: async () => {
          throw new Error('EPERM /home/private/broker.sock');
        },
        verify: async () => ({ owner_identity: 'uid:1000' }),
        close: async () => {
          closed = true;
        },
        remove: async () => {
          removed = true;
        },
      }),
    (error: Error) => error.message === 'AUTHENTICATION_FAILED: authentication failed' && !/private|EPERM/.test(error.message),
  );
  assert.equal(closed, true);
  assert.equal(removed, false);
});

test('refuses to reclaim a live or unverifiable Unix socket', async () => {
  for (const probe of ['live', 'unknown'] as const) {
    let removed = false;
    await assert.rejects(
      () =>
        reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', {
          metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:7' }),
          probe: async () => probe,
          rename: async () => {
            removed = true;
          },
          removeQuarantine: async () => {
            removed = true;
          },
          restoreQuarantine: async () => {
            removed = true;
          },
        }),
      /REPOSITORY_BUSY/,
    );
    assert.equal(removed, false);
  }
});

test('refuses to reclaim a stale Unix socket with wrong ownership or permissions', async () => {
  for (const metadata of [
    { kind: 'socket' as const, owner_identity: 'uid:2000', owner_only: true, object_identity: 'inode:7' },
    { kind: 'socket' as const, owner_identity: 'uid:1000', owner_only: false, object_identity: 'inode:7' },
  ]) {
    await assert.rejects(
      () =>
        reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', {
          metadata: async () => metadata,
          probe: async () => 'stale',
          rename: async () => {},
          removeQuarantine: async () => {},
          restoreQuarantine: async () => {},
        }),
      /AUTHENTICATION_FAILED/,
    );
  }
});

test('concurrent Unix stale reclaimers cannot unlink a replacement socket', async () => {
  let endpointIdentity: string | null = 'inode:7';
  const quarantines = new Map<string, string>();
  let renameWinners = 0;
  const deps = {
    metadata: async (path: string) =>
      path === '/state/broker.sock'
        ? endpointIdentity === null
          ? null
          : { kind: 'socket' as const, owner_identity: 'uid:1000', owner_only: true, object_identity: endpointIdentity }
        : quarantines.has(path)
          ? { kind: 'socket' as const, owner_identity: 'uid:1000', owner_only: true, object_identity: quarantines.get(path)! }
          : null,
    probe: async () => 'stale' as const,
    rename: async (_from: string, to: string) => {
      if (endpointIdentity === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      quarantines.set(to, endpointIdentity);
      endpointIdentity = null;
      renameWinners += 1;
    },
    removeQuarantine: async (path: string) => {
      quarantines.delete(path);
    },
    restoreQuarantine: async (from: string) => {
      endpointIdentity = quarantines.get(from) ?? null;
      quarantines.delete(from);
    },
  };

  await Promise.all([
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
  ]);

  assert.equal(renameWinners, 1);
  assert.equal(endpointIdentity, null);
});
