import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpStdioAdapter, V4_MCP_INSTRUCTIONS, type McpBrokerControlClientV4 } from '../src/mcp/stdio-adapter.js';
import { V4_MCP_TOOLS } from '../src/mcp/tools.js';
import type { RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';

const runId = 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const requestId = 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1';
const reply = { request_id: requestId, run_id: runId, state: 'READY_FOR_EXECUTOR', status_token: 'a'.repeat(64) };

function request(): RuntimeTaskRequestV4 {
  return { schema_version: 4, task_id: 'TASK-1', request_id: requestId, repository_id: 'fixture-repo', objective: 'Change greeting', task_class: 'mechanical-change', requested_risk_class: 'normal', requested_route: 'AUTO', allowed_changes: [{ path: 'src/x.ts', operations: ['MODIFY'] }], allowed_validation_ids: ['test'], inputs: [], constraints: [], success_criteria: ['tests pass'], max_files_changed: 1, max_changed_lines: 20, max_attempts: 3, prohibited_actions: ['push'], result_schema_version: 4 };
}

function fakeClient(): McpBrokerControlClientV4 & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (value) => { calls.push(`run:${value.request_id}`); return reply; },
    repair: async (value) => { calls.push(`repair:${value.run_id}`); return reply; },
    finalize: async (value) => { calls.push(`finalize:${value}`); return reply; },
    abort: async (value) => { calls.push(`abort:${value}`); return { ...reply, state: 'ABORTED' }; },
    status: async (value) => { calls.push(`status:${value}`); return reply; },
    close: async () => { calls.push('close'); },
  };
}

async function connected(broker: McpBrokerControlClientV4) {
  const server = createMcpStdioAdapter({ client: broker });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test('initializes with the mandatory rule and exposes only five strict domain tools', async (context) => {
  const broker = fakeClient();
  const { server, client } = await connected(broker);
  context.after(async () => { await client.close(); await server.close(); });
  assert.ok(client.getInstructions()?.startsWith('MANDATORY SOURCE-MUTATION RULE'));
  assert.equal(client.getInstructions(), V4_MCP_INSTRUCTIONS);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [...V4_MCP_TOOLS]);
  for (const tool of listed.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal('run_id' in (listed.tools[0]!.inputSchema.properties ?? {}), false);
  assert.equal('request_id' in (listed.tools[0]!.inputSchema.properties ?? {}), true);
  assert.deepEqual(Object.keys(listed.tools[2]!.inputSchema.properties ?? {}), ['run_id']);
});

test('all mutations are short daemon calls and schemas reject unknown authority', async (context) => {
  const broker = fakeClient();
  const { server, client } = await connected(broker);
  context.after(async () => { await client.close(); await server.close(); });
  const started = await client.callTool({ name: 'run_coding_task', arguments: request() as unknown as Record<string, unknown> });
  assert.deepEqual(started.structuredContent, reply);
  await client.callTool({ name: 'repair_coding_task', arguments: { run_id: runId, findings: [{ id: 'finding-1', evidence_hash: 'b'.repeat(64) }] } });
  await client.callTool({ name: 'finalize_coding_task', arguments: { run_id: runId } });
  await client.callTool({ name: 'abort_coding_task', arguments: { run_id: runId } });
  await client.callTool({ name: 'get_coding_task_status', arguments: { run_id: runId } });
  assert.deepEqual(broker.calls, [`run:${requestId}`, `repair:${runId}`, `finalize:${runId}`, `abort:${runId}`, `status:${runId}`]);
  assert.equal((await client.callTool({ name: 'finalize_coding_task', arguments: { run_id: runId, force: true } })).isError, true);
  assert.equal((await client.callTool({ name: 'run_coding_task', arguments: { ...request(), run_id: runId } })).isError, true);
});

test('disconnect and replay preserve daemon idempotency while unavailability is bounded', async () => {
  const accepted = new Map<string, typeof reply>();
  let durableEnqueues = 0;
  const broker = fakeClient();
  broker.run = async (value) => {
    const prior = accepted.get(value.request_id);
    if (prior !== undefined) return prior;
    durableEnqueues += 1; accepted.set(value.request_id, reply); return reply;
  };
  const first = await connected(broker);
  await first.client.callTool({ name: 'run_coding_task', arguments: request() as unknown as Record<string, unknown> });
  await first.client.close(); await first.server.close();
  const second = await connected(broker);
  assert.deepEqual((await second.client.callTool({ name: 'run_coding_task', arguments: request() as unknown as Record<string, unknown> })).structuredContent, reply);
  assert.equal(durableEnqueues, 1);
  await second.client.close(); await second.server.close();

  const unavailable = fakeClient();
  unavailable.run = async () => { throw new Error('AUTHENTICATION_FAILED: secret local detail'); };
  const third = await connected(unavailable);
  const failed = await third.client.callTool({ name: 'run_coding_task', arguments: request() as unknown as Record<string, unknown> });
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed.content), /AUTHENTICATION_FAILED.*broker control call failed/);
  await third.client.close(); await third.server.close();
});
