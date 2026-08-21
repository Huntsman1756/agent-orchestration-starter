import { hashCanonicalV4 } from './canonical.js';
import type { RuntimeResultV4 } from './contracts.js';
import { loadRuntimeResultV4 } from './load.js';

export const A2A_PROTOCOL_VERSION_V1 = '1.0' as const;
export type A2ATaskStateV1 =
  'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED';

export interface A2ARuntimeTaskProjectionV1 {
  readonly id: string;
  readonly contextId: string;
  readonly status: { readonly state: A2ATaskStateV1; readonly timestamp: string };
  readonly metadata: {
    readonly agentOrchestration: {
      readonly schemaVersion: 4;
      readonly protocolVersion: typeof A2A_PROTOCOL_VERSION_V1;
      readonly runtimeState: string;
      readonly contractHash: string;
      readonly artifactManifestHash: string;
      readonly statusToken: string;
      readonly projectionHash: string;
    };
  };
}

const submitted = new Set(['READY_FOR_EXECUTOR']);
const working = new Set([
  'EXECUTION_STARTED',
  'AWAITING_REINSPECTION',
  'REVIEW_ACCEPTED',
  'READY_FOR_PUBLICATION',
  'PUBLICATION_PUSHED',
  'PULL_REQUEST_OPEN',
  'REQUIRED_CHECKS_PASSED',
]);

function taskState(result: RuntimeResultV4): A2ATaskStateV1 {
  if (result.state === 'FINALIZED') return 'TASK_STATE_COMPLETED';
  if (result.state === 'FAILED') return 'TASK_STATE_FAILED';
  if (result.state === 'ABORTED') return 'TASK_STATE_CANCELED';
  if (submitted.has(result.state) && result.attempts.length === 0) return 'TASK_STATE_SUBMITTED';
  if (submitted.has(result.state) || working.has(result.state)) return 'TASK_STATE_WORKING';
  throw new Error('INVALID_CONTRACT: runtime state has no A2A v1 projection');
}

export function projectRuntimeResultToA2AV1(supplied: RuntimeResultV4, recordedAt: string): A2ARuntimeTaskProjectionV1 {
  const result = loadRuntimeResultV4(structuredClone(supplied));
  const timestamp = new Date(recordedAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== recordedAt)
    throw new Error('INVALID_CONTRACT: A2A projection timestamp is invalid');
  const statusToken = hashCanonicalV4({
    run_id: result.run_id,
    state: result.state,
    artifact_manifest_hash: result.artifact_manifest_hash,
  });
  const evidence = {
    schemaVersion: 4 as const,
    protocolVersion: A2A_PROTOCOL_VERSION_V1,
    runtimeState: result.state,
    contractHash: result.contract_hash,
    artifactManifestHash: result.artifact_manifest_hash,
    statusToken,
  };
  const projectionHash = hashCanonicalV4({
    task_id: result.run_id,
    context_id: result.request_id,
    state: taskState(result),
    timestamp: recordedAt,
    evidence,
  });
  return Object.freeze({
    id: result.run_id,
    contextId: result.request_id,
    status: Object.freeze({ state: taskState(result), timestamp: recordedAt }),
    metadata: Object.freeze({ agentOrchestration: Object.freeze({ ...evidence, projectionHash }) }),
  });
}
