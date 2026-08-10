import { randomBytes } from 'node:crypto';

import type { RuntimeResultV4, RuntimeTaskRequestV4 } from './contracts.js';
import type { RuntimeFailureV4 } from './failures.js';
import { RUNTIME_FAILURE_CODES_V4 } from './failures.js';
import { loadRuntimeTaskRequestV4 } from './load.js';
import type { BrokerReplyV4 } from './broker-daemon.js';
import type { BrokerCommandV4 } from './run-state.js';

export interface RuntimeOrchestratorV4 { start(request: RuntimeTaskRequestV4): Promise<RuntimeResultV4>; resume(runId: string): Promise<RuntimeResultV4>; abort(runId: string): Promise<RuntimeResultV4>; }
export interface DaemonOwnedPipelineV4 { advance(runId: string): Promise<void>; abort(runId: string): Promise<void>; }
export interface OrchestratorDaemonPortV4 { submit(command: Extract<BrokerCommandV4, { type: 'RUN_CODING_TASK' }>): Promise<BrokerReplyV4>; status(runId: string): Promise<RuntimeResultV4>; }
export interface RuntimeOrchestratorDependenciesV4 {
  readonly daemon: OrchestratorDaemonPortV4;
  readonly pipeline: DaemonOwnedPipelineV4;
  readonly persist_terminal_failure: (runId: string, failure: RuntimeFailureV4) => Promise<void>;
  readonly command_id?: () => string;
  readonly on_background_error?: (runId: string, error: Error) => void;
}

function runId(value: string): void { if (!/^run_[A-Za-z0-9_-]{16,96}$/.test(value)) throw new Error('INVALID_CONTRACT: run_id is invalid'); }
function failure(error: unknown): RuntimeFailureV4 {
  const match = error instanceof Error ? /^([A-Z_]+):\s*(.*)$/s.exec(error.message) : null;
  const code = match !== null && RUNTIME_FAILURE_CODES_V4.includes(match[1] as RuntimeFailureV4['code']) ? match[1] as RuntimeFailureV4['code'] : 'UNKNOWN_FAILURE';
  return { code, message: `${code}: automated pipeline failed`, retryable: code === 'PROVIDER_UNAVAILABLE', evidence_hashes: [] };
}

export function createRuntimeOrchestratorV4(deps: RuntimeOrchestratorDependenciesV4): RuntimeOrchestratorV4 {
  const flights = new Map<string, Promise<void>>();
  const terminal = (state: RuntimeResultV4['state']): boolean => state === 'FAILED' || state === 'ABORTED' || state === 'FINALIZED';
  const schedule = (id: string): void => {
    if (flights.has(id)) return;
    const flight = Promise.resolve().then(() => deps.pipeline.advance(id)).catch(async (error: unknown) => {
      const typed = failure(error);
      try {
        await deps.persist_terminal_failure(id, typed);
        deps.on_background_error?.(id, new Error(typed.message));
      } catch {
        deps.on_background_error?.(id, new Error('BROKER_UNAVAILABLE: terminal pipeline failure could not be persisted'));
      }
    }).finally(() => { flights.delete(id); });
    flights.set(id, flight);
  };
  return Object.freeze({
    start: async (supplied: RuntimeTaskRequestV4) => {
      const request = loadRuntimeTaskRequestV4(structuredClone(supplied));
      const command: Extract<BrokerCommandV4, { type: 'RUN_CODING_TASK' }> = { type: 'RUN_CODING_TASK', command_id: (deps.command_id ?? (() => `mcp-${randomBytes(16).toString('hex')}`))(), request };
      const accepted = await deps.daemon.submit(command);
      schedule(accepted.run_id);
      return await deps.daemon.status(accepted.run_id);
    },
    resume: async (id: string) => { runId(id); const current = await deps.daemon.status(id); if (!terminal(current.state)) schedule(id); return current; },
    abort: async (id: string) => { runId(id); await deps.pipeline.abort(id); return await deps.daemon.status(id); },
  });
}
