import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { RuntimeTaskRequestV4 } from '../runtime/contracts.js';
import type { BrokerReplyV4 } from '../runtime/broker-daemon.js';
import { mcpReplySchemaV4, V4_MCP_INPUT_SCHEMAS } from './tools.js';

export const V4_MCP_INSTRUCTIONS = `MANDATORY SOURCE-MUTATION RULE
Use run_coding_task for every source-code mutation request. Do not write code in the primary frontier context.
Poll or resume the returned run; never start a duplicate request. Stop on typed failure.
Never request finalization unless daemon status is REVIEW_ACCEPTED.`;

export interface RepairControlV4 { readonly run_id: string; readonly findings: readonly { readonly id: string; readonly evidence_hash: string }[]; }
export interface McpBrokerControlClientV4 {
  run(request: RuntimeTaskRequestV4): Promise<BrokerReplyV4>;
  repair(input: RepairControlV4): Promise<BrokerReplyV4>;
  finalize(runId: string): Promise<BrokerReplyV4>;
  abort(runId: string): Promise<BrokerReplyV4>;
  status(runId: string): Promise<BrokerReplyV4 & { artifact_manifest_hash?: string; failure_code?: string | null }>;
  close(): Promise<void>;
}

export interface McpAdapterDependenciesV4 { readonly client: McpBrokerControlClientV4; }
export type McpServerV4 = McpServer;

function publicFailure(error: unknown): never {
  const match = error instanceof Error ? /^([A-Z_]+):/.exec(error.message) : null;
  const code = match?.[1] ?? 'UNKNOWN_FAILURE';
  throw new McpError(ErrorCode.InternalError, `${code}: broker control call failed`);
}

function result(reply: unknown) {
  let bounded;
  try { bounded = mcpReplySchemaV4.parse(reply); } catch { return publicFailure(new Error('UNKNOWN_FAILURE: invalid broker reply')); }
  return { content: [{ type: 'text' as const, text: JSON.stringify(bounded) }], structuredContent: bounded };
}

export function createMcpStdioAdapter(deps: McpAdapterDependenciesV4): McpServerV4 {
  const server = new McpServer({ name: 'agent-orchestration-v4', version: '4.0.0' }, { instructions: V4_MCP_INSTRUCTIONS });
  server.registerTool('run_coding_task', { description: 'Durably enqueue a complete coding task.', inputSchema: V4_MCP_INPUT_SCHEMAS.run_coding_task, outputSchema: mcpReplySchemaV4 }, async (request) => {
    try { return result(await deps.client.run(request as RuntimeTaskRequestV4)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('repair_coding_task', { description: 'Request one policy-bounded repair using persisted finding identities.', inputSchema: V4_MCP_INPUT_SCHEMAS.repair_coding_task, outputSchema: mcpReplySchemaV4 }, async (input) => {
    try { return result(await deps.client.repair(input)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('finalize_coding_task', { description: 'Request finalization of an already review-accepted run.', inputSchema: V4_MCP_INPUT_SCHEMAS.finalize_coding_task, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return result(await deps.client.finalize(run_id)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('abort_coding_task', { description: 'Durably abort a run without deleting its evidence.', inputSchema: V4_MCP_INPUT_SCHEMAS.abort_coding_task, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return result(await deps.client.abort(run_id)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('get_coding_task_status', { description: 'Return a bounded status summary for one run.', inputSchema: V4_MCP_INPUT_SCHEMAS.get_coding_task_status, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return result(await deps.client.status(run_id)); } catch (error) { return publicFailure(error); }
  });
  return server;
}

export async function runMcpStdioAdapter(deps: McpAdapterDependenciesV4): Promise<void> {
  const server = createMcpStdioAdapter(deps);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  transport.onclose = () => { void deps.client.close(); };
  await server.connect(transport);
}
