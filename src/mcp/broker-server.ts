import { randomBytes } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { RuntimeTaskRequestV4 } from '../runtime/contracts.js';
import type { BrokerReplyV4 } from '../runtime/broker-daemon.js';
import type { BrokerIpcClientV4 } from '../runtime/broker-ipc.js';
import type { BrokerReviewPacketV4, BrokerVerdictInputV4 } from '../runtime/review-packet.js';
import { brokerReviewPacketSchemaV4, mcpReplySchemaV4, V4_MCP_INPUT_SCHEMAS } from './tools.js';

export const V4_MCP_INSTRUCTIONS = `MANDATORY SOURCE-MUTATION RULE
Use run_coding_task for every source-code mutation request. Do not write code in the primary frontier context.
Poll or resume the returned run; never start a duplicate request. Stop on typed failure.
Use broker.get_review_packet only after deterministic validation and the independent review gate are complete.
Submit broker.submit_verdict with the packet_hash returned by the broker. APPROVED never finalizes or publishes a run; REJECTED re-enters the existing repair flow.`;

export interface RepairControlV4 { readonly run_id: string; readonly findings: readonly { readonly id: string; readonly evidence_hash: string }[]; }
export interface McpVerdictControlV4 extends BrokerVerdictInputV4 {}

export interface McpBrokerControlClientV4 {
  run(request: RuntimeTaskRequestV4): Promise<BrokerReplyV4>;
  repair(input: RepairControlV4): Promise<BrokerReplyV4>;
  finalize(runId: string): Promise<BrokerReplyV4>;
  abort(runId: string): Promise<BrokerReplyV4>;
  status(runId: string): Promise<BrokerReplyV4 & { artifact_manifest_hash?: string; failure_code?: string | null }>;
  getReviewPacket?(runId: string): Promise<BrokerReviewPacketV4>;
  submitVerdict?(input: McpVerdictControlV4): Promise<BrokerReplyV4>;
  close(): Promise<void>;
}

export interface McpAdapterDependenciesV4 { readonly client: McpBrokerControlClientV4; }
export type McpServerV4 = McpServer;

export function createIpcMcpControlClientV4(client: BrokerIpcClientV4): McpBrokerControlClientV4 {
  return Object.freeze({
    run: (request: RuntimeTaskRequestV4) => client.submit({ type: 'RUN_CODING_TASK', command_id: `mcp-run-${randomBytes(16).toString('hex')}`, request }),
    repair: (input: RepairControlV4) => client.repair(input),
    finalize: (runId: string) => client.finalize(runId),
    abort: (runId: string) => client.abort(runId),
    status: (runId: string) => client.status(runId),
    getReviewPacket: (runId: string) => client.getReviewPacket?.(runId) ?? Promise.reject(new Error('CAPABILITY_UNVERIFIED: review packet control is unavailable')),
    submitVerdict: (input: McpVerdictControlV4) => client.submitVerdict?.(input) ?? Promise.reject(new Error('CAPABILITY_UNVERIFIED: verdict control is unavailable')),
    close: () => client.close(),
  });
}

function publicFailure(error: unknown): never {
  const match = error instanceof Error ? /^([A-Z_]+):/u.exec(error.message) : null;
  const code = match?.[1] ?? 'UNKNOWN_FAILURE';
  throw new McpError(ErrorCode.InternalError, `${code}: broker control call failed`);
}

function replyResult(reply: unknown) {
  let bounded;
  try { bounded = mcpReplySchemaV4.parse(reply); } catch { return publicFailure(new Error('UNKNOWN_FAILURE: invalid broker reply')); }
  return { content: [{ type: 'text' as const, text: JSON.stringify(bounded) }], structuredContent: bounded };
}

function reviewPacketResult(packet: unknown) {
  let bounded;
  try { bounded = brokerReviewPacketSchemaV4.parse(packet); } catch { return publicFailure(new Error('UNKNOWN_FAILURE: invalid review packet')); }
  return { content: [{ type: 'text' as const, text: JSON.stringify(bounded) }], structuredContent: bounded };
}

export function createBrokerMcpServer(deps: McpAdapterDependenciesV4): McpServerV4 {
  const server = new McpServer({ name: 'agent-orchestration-v4', version: '4.0.0' }, { instructions: V4_MCP_INSTRUCTIONS });
  server.registerTool('run_coding_task', { description: 'Durably enqueue a complete coding task.', inputSchema: V4_MCP_INPUT_SCHEMAS.run_coding_task, outputSchema: mcpReplySchemaV4 }, async (request) => {
    try { return replyResult(await deps.client.run(request as RuntimeTaskRequestV4)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('repair_coding_task', { description: 'Request one policy-bounded repair using persisted finding identities.', inputSchema: V4_MCP_INPUT_SCHEMAS.repair_coding_task, outputSchema: mcpReplySchemaV4 }, async (input) => {
    try { return replyResult(await deps.client.repair(input)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('finalize_coding_task', { description: 'Request finalization of an already review-accepted run.', inputSchema: V4_MCP_INPUT_SCHEMAS.finalize_coding_task, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return replyResult(await deps.client.finalize(run_id)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('abort_coding_task', { description: 'Durably abort a run without deleting its evidence.', inputSchema: V4_MCP_INPUT_SCHEMAS.abort_coding_task, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return replyResult(await deps.client.abort(run_id)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('get_coding_task_status', { description: 'Return a bounded status summary for one run.', inputSchema: V4_MCP_INPUT_SCHEMAS.get_coding_task_status, outputSchema: mcpReplySchemaV4 }, async ({ run_id }) => {
    try { return replyResult(await deps.client.status(run_id)); } catch (error) { return publicFailure(error); }
  });
  server.registerTool('broker.get_review_packet', { description: 'Return the complete, hash-bound review packet after deterministic validation and independent review.', inputSchema: V4_MCP_INPUT_SCHEMAS['broker.get_review_packet'], outputSchema: brokerReviewPacketSchemaV4 }, async ({ run_id }) => {
    try {
      if (deps.client.getReviewPacket === undefined) throw new Error('CAPABILITY_UNVERIFIED: review packet control is unavailable');
      return reviewPacketResult(await deps.client.getReviewPacket(run_id));
    } catch (error) { return publicFailure(error); }
  });
  server.registerTool('broker.submit_verdict', { description: 'Persist a hash-bound review verdict. APPROVED does not finalize; REJECTED schedules the existing repair flow.', inputSchema: V4_MCP_INPUT_SCHEMAS['broker.submit_verdict'], outputSchema: mcpReplySchemaV4 }, async (input) => {
    try {
      if (deps.client.submitVerdict === undefined) throw new Error('CAPABILITY_UNVERIFIED: verdict control is unavailable');
      return replyResult(await deps.client.submitVerdict(input));
    } catch (error) { return publicFailure(error); }
  });
  return server;
}
