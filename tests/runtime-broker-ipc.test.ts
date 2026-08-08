import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBrokerIpcClient,
  createBrokerIpcServer,
  reclaimUnixSocketV4,
  normalizeBrokerResponseErrorV4,
  type BrokerIpcRequestV4,
  type BrokerIpcPlatformVerifierV4,
  type BrokerIpcServerIdentityVerifierV4,
} from '../src/runtime/broker-ipc.js';
import { canonicalJsonV4 } from '../src/runtime/canonical.js';
import { createBrokerDaemon, type BrokerDaemonV4 } from '../src/runtime/broker-daemon.js';
import type { BrokerCommandV4 } from '../src/runtime/run-state.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import { reopenJournalV4 } from '../src/runtime/journal.js';
import { validRepositoryPolicy, validRuntimeProfile, validRuntimeResult, validTaskRequest } from './runtime-contracts.test.js';

async function ipcFixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\runner-v4-ipc-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
    : join(stateDirectory, 'test.sock');
  const submitted: BrokerCommandV4[] = [];
  const daemon: BrokerDaemonV4 = {
    submit: async (command) => {
      submitted.push(command);
      return { request_id: command.type === 'RUN_CODING_TASK' ? command.request.request_id : 'req_unknown', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', state: 'READY_FOR_EXECUTOR', status_token: 'status-token' };
    },
    status: async () => validRuntimeResult() as RuntimeResultV4,
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
    requestDeadlineMs: 1_000,
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
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: fixture.token, requestDeadlineMs: 1_000, platform: process.platform, serverIdentityVerifier: clientVerifier(fixture.server.endpoint) });

  const reply = await client.submit(request(fixture.token).command);

  assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(fixture.submitted.length, 1);
  await client.close();
  await fixture.server.close();
});

test('rejects an invalid token before submitting to the daemon', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: '0'.repeat(64), requestDeadlineMs: 1_000, platform: process.platform, serverIdentityVerifier: clientVerifier(fixture.server.endpoint) });

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
    assert.match(response.error ?? '', /INVALID_CONTRACT.*canonical/);
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

test('client sends no request when connected server ownership is rejected', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({
    endpoint: fixture.server.endpoint,
    token: fixture.token,
    platform: process.platform,
    serverIdentityVerifier: { verifyServer: async () => null },
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
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform }),
    /AUTHENTICATION_FAILED/,
  );
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
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier }),
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
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|ACL tool/.test(error.message),
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
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  const response = await server.exchangeFrameForTest(Buffer.from(canonicalJsonV4(request(token)), 'utf8'));

  assert.match(response.error ?? '', /^UNKNOWN_FAILURE:/);
  assert.doesNotMatch(response.error ?? '', /secret-owner|ENOENT/);
  await server.close();
});

test('normalizes malicious server response errors to a bounded closed-catalog reply', () => {
  assert.equal(
    normalizeBrokerResponseErrorV4('UNKNOWN_FAILURE: ENOENT C:\\Users\\secret-owner\\private'),
    'UNKNOWN_FAILURE: broker request failed',
  );
  assert.equal(normalizeBrokerResponseErrorV4('NOT_A_CODE: secret'), 'UNKNOWN_FAILURE: broker request failed');
});

test('normalizes injected token-storage and server-close failures', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-lifecycle-'));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-lifecycle-${Date.now()}` : join(stateDirectory, 'lifecycle.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };

  await assert.rejects(
    () => createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, loadToken: async () => { throw new Error('EACCES C:\\Users\\secret-owner\\token'); } }),
    (error: Error) => /^AUTHENTICATION_FAILED:/.test(error.message) && !/secret-owner|EACCES/.test(error.message),
  );

  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier, closeServer: async (nativeServer) => {
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
  });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\runner-v4-replay-${Date.now()}` : join(stateDirectory, 'replay.sock');
  const verifier: BrokerIpcPlatformVerifierV4 = { verifyOwnerOnlyPath: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }), verifyPeer: async ({ expected_owner_identity }) => ({ owner_identity: expected_owner_identity }) };
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform, platformVerifier: verifier });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
  const client = createBrokerIpcClient({ endpoint, token, platform: process.platform, serverIdentityVerifier: clientVerifier(endpoint) });
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
  });
  assert.equal(removed, true);
});

test('refuses to reclaim a live or unverifiable Unix socket', async () => {
  for (const probe of ['live', 'unknown'] as const) {
    let removed = false;
    await assert.rejects(
      () => reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', { metadata: async () => ({ kind: 'socket', owner_identity: 'uid:1000', owner_only: true, object_identity: 'inode:7' }), probe: async () => probe, rename: async () => { removed = true; }, removeQuarantine: async () => { removed = true; } }),
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
      () => reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', { metadata: async () => metadata, probe: async () => 'stale', rename: async () => {}, removeQuarantine: async () => {} }),
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
  };

  await Promise.all([
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
    reclaimUnixSocketV4('/state/broker.sock', 'uid:1000', deps),
  ]);

  assert.equal(renameWinners, 1);
  assert.equal(endpointIdentity, null);
});
