import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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

function physicalInspection(
  operationPath: string,
  expectedOwnerIdentity: string,
  overrides: Partial<UnixPhysicalPathInspectionV4> = {},
): UnixPhysicalPathInspectionV4 {
  return {
    operation_path: operationPath,
    chain_complete: true,
    components: [
      { kind: 'directory', object_identity: 'dev:1:ino:1', owner_identity: 'uid:0', owner_trusted: true, writable_by_untrusted: false, owner_only: false },
      { kind: 'directory', object_identity: 'dev:1:ino:2', owner_identity: 'uid:0', owner_trusted: true, writable_by_untrusted: false, owner_only: false },
      { kind: 'directory', object_identity: 'dev:1:ino:3', owner_identity: expectedOwnerIdentity, owner_trusted: true, writable_by_untrusted: false, owner_only: true },
    ],
    ...overrides,
  };
}

function physicalPathBackend(
  inspect: (input: { state_directory: string; expected_owner_identity: string }) => Promise<UnixPhysicalPathInspectionV4>,
  identity = 'physical-path-test',
): UnixPhysicalPathBackendV4 {
  return {
    certification: { kind: 'in-process-test', identity },
    certifyStateDirectory: inspect,
    withReprovedStateDirectory: async (input, operation) => operation(await inspect({
      state_directory: input.operation_path,
      expected_owner_identity: input.expected_owner_identity,
    })),
  };
}

function physicalCleanupSecurity(stateDirectory: string) {
  return {
    stateDirectory,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity)),
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  };
}

function unixPhysicalServerTestDeps() {
  return {
    unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity)),
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

function synchronouslyConnectingSocketForTest(): Socket {
  const socket = new Socket();
  const once = socket.once.bind(socket);
  let connectScheduled = false;
  socket.once = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = once(event, listener);
    if (event === 'connect' && !connectScheduled) {
      connectScheduled = true;
      queueMicrotask(() => {
        try { socket.emit('connect'); }
        catch (error) { socket.emit('error', error); }
      });
    }
    return result;
  }) as Socket['once'];
  return socket;
}

async function ipcFixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\runner-v4-ipc-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
    : join(stateDirectory, 'test.sock');
  const submitted: BrokerCommandV4[] = [];
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
        status_token: hashCanonicalV4({ run_id: status.run_id, state: status.state, artifact_manifest_hash: status.artifact_manifest_hash }),
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
  return { stateDirectory, submitted, server, token };
}

function request(token: string): BrokerIpcRequestV4 {
  return { token, command: { type: 'RUN_CODING_TASK', command_id: 'command-run', request: validTaskRequest() as RuntimeTaskRequestV4 } };
}

function clientVerifier(endpoint: string): BrokerIpcServerIdentityVerifierV4 {
  return {
    verifyServer: async (input) => input.endpoint === endpoint && input.expected_owner_identity.length > 4
      ? { owner_identity: input.expected_owner_identity }
      : null,
  };
}

test('round-trips an authenticated canonical request over a length-prefixed frame', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: fixture.token, requestDeadlineMs: 1_000, platform: process.platform, serverIdentityVerifier: clientVerifier(fixture.server.endpoint), ...unixPhysicalClientTestDeps(fixture.stateDirectory) });

  const reply = await client.submit(request(fixture.token).command);

  assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(fixture.submitted.length, 1);
  await client.close();
  await fixture.server.close();
});

test('rejects an invalid token before submitting to the daemon', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: '0'.repeat(64), requestDeadlineMs: 1_000, platform: process.platform, serverIdentityVerifier: clientVerifier(fixture.server.endpoint), ...unixPhysicalClientTestDeps(fixture.stateDirectory) });

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
  assert.throws(
    () => createBrokerIpcClient({ endpoint: 'local-endpoint', token: '0'.repeat(64) }),
    /AUTHENTICATION_FAILED/,
  );
});

test('Unix client rejects a changed physical state path before coordinator or connect effects', async () => {
  let physicalInspections = 0;
  let coordinatorEffects = 0;
  let connectEffects = 0;
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return { ...valid, components: valid.components.map((component, index) => index === valid.components.length - 1 ? { ...component, kind: 'symbolic-link' as const } : component) };
  }, 'client-changed-path');
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'client-changed-path-coordinator' },
    runExclusive: async () => { coordinatorEffects += 1; throw new Error('must not coordinate'); },
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
    connect: () => { connectEffects += 1; throw new Error('connect must not run'); },
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
  ['oversized frame', Buffer.alloc(1_048_577)],
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
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\runner-v4-closed-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
    : join(stateDirectory, 'closed.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() }),
    /AUTHENTICATION_FAILED/,
  );
});

test('production startup rejects an in-process endpoint coordinator', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-coordinator-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-coordinator-${Date.now()}` : join(stateDirectory, 'coordinator.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator }),
    /AUTHENTICATION_FAILED/,
  );
});

test('Unix production startup fails closed without a certified physical-path backend', async () => {
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  let coordinatorEffects = 0;
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'missing-physical-backend' },
    runExclusive: async () => { coordinatorEffects += 1; throw new Error('must not coordinate'); },
  };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory: '/state', endpoint: '/state/broker.sock', platform: 'linux', platformVerifier: verifier, endpointCoordinator: coordinator }),
    /AUTHENTICATION_FAILED: certified Unix physical-path backend is required/,
  );
  assert.equal(coordinatorEffects, 0);
});

test('running-server close uses the same endpoint coordinator as startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-close-coordinator-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-close-coordinator-${Date.now()}` : join(stateDirectory, 'close-coordinator.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const delegate = createInProcessReclamationCoordinatorV4('close-coordinator-delegate');
  const keys: string[] = [];
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'close-coordinator' },
    runExclusive: async (key, operation) => {
      keys.push(key);
      return delegate.runExclusive(key, operation);
    },
  };

  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator: coordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
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
  const endpoint = process.platform === 'win32'
    ? `//./PIPE/${pipeName.toUpperCase()}`
    : `${stateDirectory}canonical.sock`;
  const canonicalEndpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}`
    : join(canonicalStateDirectory, 'canonical.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
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
  const endpoint = process.platform === 'win32'
    ? 'relative-pipe-name'
    : join(stateDirectory, '..', 'outside.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
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
    () => createBrokerIpcServer({
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
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  let physicalInspections = 0;
  let tokenEffects = 0;
  let coordinatorEffects = 0;
  const physicalPath = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return { ...valid, components: valid.components.map((component, index) => index === valid.components.length - 1 ? { ...component, kind: 'symbolic-link' as const } : component) };
  });
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'direct-link-coordinator' },
    runExclusive: async () => { coordinatorEffects += 1; throw new Error('must not coordinate'); },
  };

  await assert.rejects(
    () => createBrokerIpcServer({
      daemon,
      stateDirectory,
      endpoint,
      platform: 'linux',
      platformVerifier: verifier,
      endpointCoordinator: coordinator,
      unixPhysicalPathBackend: physicalPath,
      allowInProcessPhysicalPathBackendForTests: true,
      loadToken: async () => { tokenEffects += 1; return 'a'.repeat(64); },
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
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  let physicalInspections = 0;
  let tokenEffects = 0;
  let coordinatorEffects = 0;
  const physicalPath = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => {
    physicalInspections += 1;
    const valid = physicalInspection(state_directory, expected_owner_identity);
    return { ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, kind: 'symbolic-link' as const } : component) };
  });
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'parent-link-coordinator' },
    runExclusive: async () => { coordinatorEffects += 1; throw new Error('must not coordinate'); },
  };

  await assert.rejects(
    () => createBrokerIpcServer({
      daemon,
      stateDirectory,
      endpoint,
      platform: 'linux',
      platformVerifier: verifier,
      endpointCoordinator: coordinator,
      unixPhysicalPathBackend: physicalPath,
      allowInProcessPhysicalPathBackendForTests: true,
      loadToken: async () => { tokenEffects += 1; return 'a'.repeat(64); },
    }),
    /AUTHENTICATION_FAILED/,
  );
  assert.equal(physicalInspections, 1);
  assert.equal(tokenEffects, 0);
  assert.equal(coordinatorEffects, 0);
});

test('rejects incomplete, ambiguous, untrusted, or insecure Unix physical metadata before coordination', async () => {
  const stateDirectory = '/invalid-physical/state';
  const endpoint = '/invalid-physical/state/broker.sock';
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const invalidInspections = [
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, chain_complete: false }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, kind: 'reparse-alias' as const } : component) }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, object_identity: null } : component) }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, owner_trusted: false } : component) }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, writable_by_untrusted: true } : component) }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === valid.components.length - 1 ? { ...component, owner_identity: 'uid:attacker' } : component) }),
    (valid: UnixPhysicalPathInspectionV4) => ({ ...valid, components: valid.components.map((component, index) => index === valid.components.length - 1 ? { ...component, owner_only: false } : component) }),
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
      runExclusive: async () => { coordinatorEffects += 1; throw new Error('must not coordinate'); },
    };
    await assert.rejects(
      () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: 'linux', platformVerifier: verifier, endpointCoordinator: coordinator, unixPhysicalPathBackend: physicalPath, allowInProcessPhysicalPathBackendForTests: true, loadToken: async () => 'a'.repeat(64) }),
      /AUTHENTICATION_FAILED/,
    );
    assert.equal(physicalInspections, 1);
    assert.equal(coordinatorEffects, 0);
  }
});

test('cleans a listener when the endpoint coordinator rejects after a successful startup callback', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-release-rejection-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-release-rejection-${Date.now()}` : join(stateDirectory, 'release-rejection.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
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
      () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator: rejectingCoordinator, ...unixPhysicalServerTestDeps() }),
      (error: Error) => /^UNKNOWN_FAILURE:/.test(error.message) && !/secret-owner|native-mutex/.test(error.message),
    );
    replacement = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
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
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-acl-${Date.now()}` : join(stateDirectory, 'acl.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async () => null,
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() }),
    /AUTHENTICATION_FAILED/,
  );
});

test('normalizes native verifier exceptions during IPC startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-verifier-leak-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-verifier-leak-${Date.now()}` : join(stateDirectory, 'verifier-leak.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: async () => { throw new Error('ACL tool failed at C:\\Users\\secret-owner'); },
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|ACL tool/.test(error.message),
  );
});

test('normalizes a synchronous owner-verifier throw during IPC startup', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-sync-verifier-leak-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-sync-verifier-leak-${Date.now()}` : join(stateDirectory, 'sync-verifier-leak.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = {
    verifyOwnerOnlyPath: () => { throw new Error('ACL sync failure at C:\\Users\\secret-owner'); },
    verifyPeer: async () => null,
  };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() }),
    (error: Error) => error.message === 'AUTHENTICATION_FAILED: native state-directory ownership/ACL proof failed' && !/secret-owner|ACL sync/.test(error.message),
  );
});

test('normalizes raw daemon errors before they cross IPC', async () => {
  const fixture = await ipcFixture();
  const leakingDaemon = fixture.server;
  await leakingDaemon.close();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-leak-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-leak-${Date.now()}` : join(stateDirectory, 'leak.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const daemon = { ...({} as BrokerDaemonV4), submit: async () => { throw new Error('ENOENT C:\\Users\\secret-owner\\private'); } };
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  const response = await server.exchangeFrameForTest(Buffer.from(canonicalJsonV4(request(token)), 'utf8'));

  assert.match(response.error ?? '', /^UNKNOWN_FAILURE:/);
  assert.doesNotMatch(response.error ?? '', /secret-owner|ENOENT/);
  await server.close();
});

test('rejects a malformed daemon reply before it crosses IPC', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-malformed-reply-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-malformed-reply-${Date.now()}` : join(stateDirectory, 'malformed-reply.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const daemon = { ...({} as BrokerDaemonV4), submit: async () => ({ request_id: 'req_invalid', secret: 'C:\\Users\\secret-owner' }) } as unknown as BrokerDaemonV4;
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
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
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-reply-semantics-${Date.now()}` : join(stateDirectory, 'reply-semantics.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
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
    status_token: hashCanonicalV4({ run_id: authoritative.run_id, state: authoritative.state, artifact_manifest_hash: authoritative.artifact_manifest_hash }),
  };
  let submittedReply = validReply;
  const daemon = { ...({} as BrokerDaemonV4), submit: async () => submittedReply, status: async () => authoritative };
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
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
  const valid = canonicalJsonV4({ ok: true, reply: { request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', state: 'READY_FOR_EXECUTOR', status_token: 'd'.repeat(64) } });
  assert.equal(loadBrokerIpcResponseV4(valid).reply?.status_token, 'd'.repeat(64));

  for (const malicious of [
    'null',
    '{}',
    canonicalJsonV4({ ok: true, reply: null }),
    canonicalJsonV4({ ok: true, reply: { request_id: 'req_bad', run_id: 'run_bad', state: 'READY_FOR_EXECUTOR', status_token: 'secret C:\\Users\\owner', extra: true } }),
    canonicalJsonV4({ ok: true, reply: { request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', state: 'VALID_SHAPED_BUT_UNKNOWN', status_token: 'd'.repeat(64) } }),
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
    connect: () => { throw new Error('ENOENT C:\\Users\\secret-owner\\broker.sock'); },
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
      verifyServer: () => { throw new Error('ACL sync failure at C:\\Users\\secret-owner\\broker.sock'); },
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
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-cross-request-${Date.now()}` : join(stateDirectory, 'cross-request.sock');
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
  const client = createBrokerIpcClient({ endpoint, token: '0'.repeat(64), platform: process.platform, serverIdentityVerifier: clientVerifier(endpoint), ...unixPhysicalClientTestDeps(stateDirectory) });

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
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-lifecycle-${Date.now()}` : join(stateDirectory, 'lifecycle.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, loadToken: async () => { throw new Error('EACCES C:\\Users\\secret-owner\\token'); }, ...unixPhysicalServerTestDeps() }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|EACCES/.test(error.message),
  );

  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps(), closeServer: async (nativeServer) => {
    await new Promise<void>((resolve) => nativeServer.close(() => resolve()));
    throw new Error('EPERM C:\\Users\\secret-owner\\pipe');
  } });
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
    registry: { repositories: [{ repository_id: 'fixture-repo', canonical_root: repositoryRoot, policy_ref: 'policy', profile_ref: 'profile', worktree_parent: join(repositoryRoot, '.worktrees'), state_path: stateDirectory }] },
    loadPolicy: async () => freezeRepositoryPolicy(validRepositoryPolicy() as RuntimeRepositoryPolicyV4),
    loadProfile: async () => validRuntimeProfile() as RuntimeProfileV4,
    resolveBaseSha: async () => 'b'.repeat(40),
    sandboxProfiles: { 'executor-networked': {}, 'frontier-networked': {}, 'validation-untrusted': {}, 'review-capsule': {} },
    inspectChanges: async (input) => input.changes.map((change) => ({ ...change, canonical_parent: join(repositoryRoot, 'src'), existed_at_freeze: true })),
    generateRunId: () => 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    lockOwnerStatus: async () => 'dead',
    reclamationCoordinator: endpointCoordinator,
    allowInProcessCoordinatorForTests: true,
  });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-replay-${Date.now()}` : join(stateDirectory, 'replay.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, endpointCoordinator, allowInProcessCoordinatorForTests: true, ...unixPhysicalServerTestDeps() });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
  const client = createBrokerIpcClient({ endpoint, token, platform: process.platform, serverIdentityVerifier: clientVerifier(endpoint), ...unixPhysicalClientTestDeps(stateDirectory) });
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
    metadata: async (path) => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: path === '/state/broker.sock' ? 'inode:7' : 'inode:7' }),
    probe: async () => 'stale',
    rename: async (_from, to) => { quarantine = to; },
    removeQuarantine: async (path) => { assert.equal(path, quarantine); removed = true; },
    restoreQuarantine: async () => { throw new Error('not expected'); },
  });
  assert.equal(removed, true);
});

test('normalizes a synchronous metadata throw during an ENOENT stale-reclaim recheck', async () => {
  let metadataReads = 0;
  await assert.rejects(
    () => reclaimUnixSocketV4('/state/private/broker.sock', 'uid:1000', {
      metadata: () => {
        metadataReads += 1;
        if (metadataReads === 1) return Promise.resolve({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:7' });
        throw new Error('EACCES /state/private/broker.sock');
      },
      probe: async () => 'stale',
      rename: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
      removeQuarantine: async () => { throw new Error('not expected'); },
      restoreQuarantine: async () => { throw new Error('not expected'); },
    }),
    (error: Error) => error.message === 'AUTHENTICATION_FAILED: broker endpoint metadata unavailable' && !/private|EACCES/.test(error.message),
  );
});

test('restores a live replacement that appears after stale probe but before quarantine rename', async () => {
  let endpointIdentity: string | null = 'inode:7';
  const quarantines = new Map<string, string>();
  let removed = false;
  await assert.rejects(
    () => reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', {
      metadata: async (path) => {
        const identity = path === '/state/broker.sock' ? endpointIdentity : quarantines.get(path) ?? null;
        return identity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: identity };
      },
      probe: async () => { endpointIdentity = 'inode:8'; return 'stale'; },
      rename: async (_from, to) => { quarantines.set(to, endpointIdentity!); endpointIdentity = null; },
      removeQuarantine: async () => { removed = true; },
      restoreQuarantine: async (from) => { endpointIdentity = quarantines.get(from) ?? null; quarantines.delete(from); },
    }),
    /REPOSITORY_BUSY/,
  );
  assert.equal(endpointIdentity, 'inode:8');
  assert.equal(removed, false);
});

test('removes a Unix endpoint only when its current object identity is the owned socket', async () => {
  let removed = false;
  await removeOwnedUnixEndpointV4('/state/broker.sock', 'inode:7', {
    metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:8' }),
    remove: async () => { removed = true; },
  }, endpointCoordinator, physicalCleanupSecurity('/state'));
  assert.equal(removed, false);

  await assert.rejects(
    () => removeOwnedUnixEndpointV4('/state/broker.sock', 'inode:7', {
      metadata: async () => { throw new Error('EACCES /home/private/broker.sock'); },
      remove: async () => { removed = true; },
    }, endpointCoordinator, physicalCleanupSecurity('/state')),
    (error: Error) => error.message === 'UNKNOWN_FAILURE: local IPC endpoint cleanup failed' && !/private|EACCES/.test(error.message),
  );
});

test('owned Unix endpoint cleanup keeps a replacement scheduled after its first metadata observation', async () => {
  const endpoint = '/state/broker.sock';
  const delegate = createInProcessReclamationCoordinatorV4('owned-cleanup-race-delegate');
  let cleanupCoordinatorKey = '';
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'in-process-test', identity: 'owned-cleanup-race' },
    runExclusive: async (key, operation) => { cleanupCoordinatorKey = key; return delegate.runExclusive(key, operation); },
  };
  let endpointIdentity: string | null = 'inode:7';
  let releaseMetadata!: () => void;
  const metadataCanReturn = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let observedMetadata!: () => void;
  const metadataObserved = new Promise<void>((resolve) => { observedMetadata = resolve; });
  const cleanup = removeOwnedUnixEndpointV4(endpoint, 'inode:7', {
    metadata: async () => {
      const observedIdentity = endpointIdentity;
      observedMetadata();
      await metadataCanReturn;
      return observedIdentity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
    },
    remove: async () => { endpointIdentity = null; },
  }, coordinator, physicalCleanupSecurity('/state'));

  await metadataObserved;
  const replacement = coordinator.runExclusive(cleanupCoordinatorKey, async () => { endpointIdentity = 'inode:8'; });
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
    runExclusive: async (key, operation) => { cleanupCoordinatorKey = key; return delegate.runExclusive(key, operation); },
  };
  const observedPaths: string[] = [];
  let endpointIdentity: string | null = 'inode:7';
  let releaseMetadata!: () => void;
  const metadataCanReturn = new Promise<void>((resolve) => { releaseMetadata = resolve; });
  let observedMetadata!: () => void;
  const metadataObserved = new Promise<void>((resolve) => { observedMetadata = resolve; });
  const cleanup = removeOwnedUnixEndpointV4(aliasEndpoint, 'inode:7', {
    metadata: async (path) => {
      observedPaths.push(path);
      const observedIdentity = endpointIdentity;
      observedMetadata();
      await metadataCanReturn;
      return observedIdentity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
    },
    remove: async (path) => {
      observedPaths.push(path);
      endpointIdentity = null;
    },
  }, coordinator, physicalCleanupSecurity('/state'));

  await metadataObserved;
  const replacement = coordinator.runExclusive(cleanupCoordinatorKey, async () => { endpointIdentity = 'inode:8'; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseMetadata();
  await Promise.all([cleanup, replacement]);

  assert.equal(endpointIdentity, 'inode:8');
  assert.deepEqual(observedPaths, [canonicalEndpoint, canonicalEndpoint]);
});

test('two textual routes to the same physical Unix state tree derive one coordinator identity', async () => {
  const routeAState = '/route-a/state';
  const routeBState = '/route-b/state';
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity), 'same-tree-key');
  const delegate = createInProcessReclamationCoordinatorV4('same-tree-key-delegate');
  const coordinatorKeys: string[] = [];
  const coordinator: ReclamationCoordinatorV4 = {
    certification: { kind: 'native-cross-process', identity: 'same-tree-key-coordinator' },
    runExclusive: async (key, operation) => {
      coordinatorKeys.push(key);
      return delegate.runExclusive(key, operation);
    },
  };
  const deps = { metadata: async () => null, remove: async () => { throw new Error('nothing was owned'); } };

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

test('physical Unix cleanup rejects an uncertified in-process coordinator before endpoint metadata effects', async () => {
  let metadataEffects = 0;
  await assert.rejects(
    () => removeOwnedUnixEndpointV4('/state/broker.sock', 'inode:7', {
      metadata: async () => { metadataEffects += 1; return null; },
      remove: async () => { throw new Error('must not remove'); },
    }, createInProcessReclamationCoordinatorV4('uncertified-cleanup'), {
      stateDirectory: '/state',
      expectedOwnerIdentity: 'uid:1000',
      unixPhysicalPathBackend: physicalPathBackend(async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity)),
      allowInProcessPhysicalPathBackendForTests: true,
    }),
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
    return { ...valid, components: valid.components.map((component, index) => index === 1 ? { ...component, kind: 'reparse-alias' as const } : component) };
  }, 'inserted-alias');
  const coordinator = createInProcessReclamationCoordinatorV4('inserted-alias-coordinator');
  let legitimateSocketIdentity: string | null = 'inode:7';
  let metadataEffects = 0;
  let unlinkEffects = 0;

  await assert.rejects(
    () => removeOwnedUnixEndpointV4('/state/broker.sock', 'inode:7', {
      metadata: async () => {
        metadataEffects += 1;
        return legitimateSocketIdentity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: legitimateSocketIdentity };
      },
      remove: async () => { unlinkEffects += 1; legitimateSocketIdentity = null; },
    }, coordinator, {
      stateDirectory: '/state',
      expectedOwnerIdentity: 'uid:1000',
      unixPhysicalPathBackend: backend,
      allowInProcessPhysicalPathBackendForTests: true,
      allowInProcessCoordinatorForTests: true,
    }),
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
  const backend = physicalPathBackend(async ({ state_directory, expected_owner_identity }) => physicalInspection(state_directory, expected_owner_identity), 'replacement-barrier');
  const coordinator = createInProcessReclamationCoordinatorV4('replacement-barrier-coordinator');
  let endpointIdentity: string | null = 'inode:7';
  let releaseOldMetadata!: () => void;
  const oldMetadataCanReturn = new Promise<void>((resolve) => { releaseOldMetadata = resolve; });
  let oldMetadataObserved!: () => void;
  const observedOldMetadata = new Promise<void>((resolve) => { oldMetadataObserved = resolve; });
  let replacementCompleted = false;

  const cleanup = removeOwnedUnixEndpointV4('/route-a/state/broker.sock', 'inode:7', {
    metadata: async () => {
      const observedIdentity = endpointIdentity;
      oldMetadataObserved();
      await oldMetadataCanReturn;
      return observedIdentity === null ? null : { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: observedIdentity };
    },
    remove: async () => { endpointIdentity = null; },
  }, coordinator, {
    stateDirectory: routeAState,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: backend,
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  });

  await observedOldMetadata;
  const replacement = removeOwnedUnixEndpointV4('/route-b/state/broker.sock', 'never-owned', {
    metadata: async () => {
      endpointIdentity = 'inode:8';
      return { kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: endpointIdentity };
    },
    remove: async () => { throw new Error('replacement must not be removed'); },
  }, coordinator, {
    stateDirectory: routeBState,
    expectedOwnerIdentity: 'uid:1000',
    unixPhysicalPathBackend: backend,
    allowInProcessPhysicalPathBackendForTests: true,
    allowInProcessCoordinatorForTests: true,
  }).then(() => { replacementCompleted = true; });

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
    () => secureUnixEndpointV4('/state/broker.sock', 'uid:1000', {
      metadata: async () => { throw new Error('EACCES /home/private/broker.sock'); },
      secure: async () => {},
      verify: async () => ({ owner_identity: 'uid:1000' }),
      close: async () => { closed = true; },
      remove: async () => { throw new Error('must not remove an unproved endpoint'); },
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
    () => secureUnixEndpointV4('/state/broker.sock', 'uid:1000', {
      metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: ++metadataReads === 1 ? 'inode:7' : 'inode:8' }),
      secure: async () => { throw new Error('EPERM /home/private/broker.sock'); },
      verify: async () => ({ owner_identity: 'uid:1000' }),
      close: async () => { closed = true; },
      remove: async () => { removed = true; },
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
      () => reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', { metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:7' }), probe: async () => probe, rename: async () => { removed = true; }, removeQuarantine: async () => { removed = true; }, restoreQuarantine: async () => { removed = true; } }),
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
      () => reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', { metadata: async () => metadata, probe: async () => 'stale', rename: async () => {}, removeQuarantine: async () => {}, restoreQuarantine: async () => {} }),
      /AUTHENTICATION_FAILED/,
    );
  }
});

test('concurrent Unix stale reclaimers cannot unlink a replacement socket', async () => {
  let endpointIdentity: string | null = 'inode:7';
  const quarantines = new Map<string, string>();
  let renameWinners = 0;
  const deps = {
    metadata: async (path: string) => path === '/state/broker.sock'
      ? endpointIdentity === null ? null : { kind: 'socket' as const, owner_identity: 'uid:1000', owner_only: true, object_identity: endpointIdentity }
      : quarantines.has(path) ? { kind: 'socket' as const, owner_identity: 'uid:1000', owner_only: true, object_identity: quarantines.get(path)! } : null,
    probe: async () => 'stale' as const,
    rename: async (_from: string, to: string) => {
      if (endpointIdentity === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      quarantines.set(to, endpointIdentity);
      endpointIdentity = null;
      renameWinners += 1;
    },
    removeQuarantine: async (path: string) => { quarantines.delete(path); },
    restoreQuarantine: async (from: string) => { endpointIdentity = quarantines.get(from) ?? null; quarantines.delete(from); },
  };

  await Promise.all([
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
  ]);

  assert.equal(renameWinners, 1);
  assert.equal(endpointIdentity, null);
});
