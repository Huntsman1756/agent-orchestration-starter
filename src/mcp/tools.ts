import { z } from 'zod';

import { runtimeTaskRequestV4Schema } from '../runtime/contract-schemas.js';

export const V4_MCP_TOOLS = [
  'run_coding_task',
  'repair_coding_task',
  'finalize_coding_task',
  'abort_coding_task',
  'get_coding_task_status',
] as const;

export type V4McpToolName = (typeof V4_MCP_TOOLS)[number];

const runId = z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/);
const finding = z.object({ id: z.string().min(1).max(128), evidence_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const findings = z.array(finding).min(1).max(128).superRefine((value, context) => {
  if (new Set(value.map((item) => item.id)).size !== value.length) context.addIssue({ code: 'custom', message: 'duplicate finding IDs are forbidden' });
});

export const V4_MCP_INPUT_SCHEMAS = Object.freeze({
  run_coding_task: runtimeTaskRequestV4Schema,
  repair_coding_task: z.object({ run_id: runId, findings }).strict(),
  finalize_coding_task: z.object({ run_id: runId }).strict(),
  abort_coding_task: z.object({ run_id: runId }).strict(),
  get_coding_task_status: z.object({ run_id: runId }).strict(),
});

export const mcpReplySchemaV4 = z.object({
  request_id: z.string().regex(/^req_[A-Za-z0-9_-]{16,96}$/),
  run_id: runId,
  state: z.string().min(1).max(128),
  status_token: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  failure_code: z.string().regex(/^[A-Z_]+$/).nullable().optional(),
}).strict();

export type McpReplyV4 = z.infer<typeof mcpReplySchemaV4>;
