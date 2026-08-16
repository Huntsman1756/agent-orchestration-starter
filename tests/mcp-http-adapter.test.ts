import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpAdapter } from '../src/mcp/http-adapter.js';
import type { McpBrokerControlClientV4 } from '../src/mcp/broker-server.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const reply = { request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1', run_id: runId, state: 'READY_FOR_EXECUTOR', status_token: 'a'.repeat(64) };

function broker(): McpBrokerControlClientV4 {
  return {
    run: async () => reply,
    repair: async () => reply,
    finalize: async () => reply,
    abort: async () => reply,
    status: async () => reply,
    close: async () => undefined,
  };
}

test('serves the broker over authenticated Streamable HTTP at /mcp', async () => {
  const token = 'local-review-token-1234';
  const adapter = await createMcpHttpAdapter({ client: broker() }, { bearerToken: token });
  const transport = new StreamableHTTPClientTransport(new URL(`http://${adapter.host}:${adapter.port}${adapter.path}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'http-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).slice(-2), ['broker.get_review_packet', 'broker.submit_verdict']);
    const unauthorized = await fetch(`http://${adapter.host}:${adapter.port}${adapter.path}`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await client.close().catch(() => undefined);
    await adapter.close();
  }
});
