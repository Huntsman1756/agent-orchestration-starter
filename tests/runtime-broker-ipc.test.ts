import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBrokerIpcClient,
  createBrokerIpcServer,
  type BrokerIpcRequestV4,
} from '../src/runtime/broker-ipc.js';
import type { BrokerDaemonV4 } from '../src/runtime/broker-daemon.js';
import type { BrokerCommandV4 } from '../src/runtime/run-state.js';
import type { RuntimeResultV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRuntimeResult, validTaskRequest } from './runtime-contracts.test.js';

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
  const server = await createBrokerIpcServer({
    daemon,
    stateDirectory,
    endpoint,
    platform: process.platform,
    authenticatePeer: async () => true,
    requestDeadlineMs: 1_000,
  });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();
  return { stateDirectory, submitted, server, token };
}

function request(token: string): BrokerIpcRequestV4 {
  return { token, command: { type: 'RUN_CODING_TASK', command_id: 'command-run', request: validTaskRequest() as RuntimeTaskRequestV4 } };
}

test('round-trips an authenticated canonical request over a length-prefixed frame', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: fixture.token, requestDeadlineMs: 1_000 });

  const reply = await client.submit(request(fixture.token).command);

  assert.equal(reply.run_id, 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1');
  assert.equal(fixture.submitted.length, 1);
  await client.close();
  await fixture.server.close();
});

test('rejects an invalid token before submitting to the daemon', async () => {
  const fixture = await ipcFixture();
  const client = createBrokerIpcClient({ endpoint: fixture.server.endpoint, token: '0'.repeat(64), requestDeadlineMs: 1_000 });

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

for (const [name, payload] of [
  ['malformed JSON', Buffer.from('{', 'utf8')],
  ['oversized frame', Buffer.alloc(1_048_577)],
  ['unknown command', Buffer.from(JSON.stringify({ token: 'TOKEN', command: { type: 'SHELL', command_id: 'x' } }), 'utf8')],
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

test('production authentication fails closed when peer ownership cannot be established', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-ipc-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\runner-v4-closed-${stateDirectory.replace(/[^A-Za-z0-9]/g, '')}`
    : join(stateDirectory, 'closed.sock');
  const daemon = { submit: async () => { throw new Error('must not submit'); }, status: async () => validRuntimeResult() as RuntimeResultV4, recover: async () => {}, close: async () => {}, recordAttempt: async () => {}, reinspect: async () => {}, recordExternalProcessStarted: async () => {} } as BrokerDaemonV4;
  const server = await createBrokerIpcServer({ daemon, stateDirectory, endpoint, platform: process.platform });
  const token = (await readFile(join(stateDirectory, 'broker.token'), 'utf8')).trim();

  const response = await server.exchangeFrameForTest(Buffer.from(JSON.stringify(request(token)), 'utf8'));

  assert.match(response.error ?? '', /AUTHENTICATION_FAILED/);
  await server.close();
});
