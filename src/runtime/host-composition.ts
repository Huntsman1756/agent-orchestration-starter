import { hashCanonicalV4 } from './canonical.js';
import { createBrokerDaemon, type BrokerDaemonDependenciesV4, type BrokerDaemonV4, type BrokerReplyV4 } from './broker-daemon.js';
import { createBrokerIpcServer, type BrokerIpcControlPlaneV4, type BrokerIpcDependenciesV4, type BrokerIpcFindingV4, type BrokerIpcServerV4 } from './broker-ipc.js';
import type { RuntimeFailureV4 } from './failures.js';
import { RUNTIME_FAILURE_CODES_V4 } from './failures.js';

export interface RuntimeHostOperationsV4 {
  advance(runId: string, daemon: BrokerDaemonV4): Promise<void>;
  prepareRepair(input: { command_id: string; run_id: string; findings: readonly BrokerIpcFindingV4[] }, daemon: BrokerDaemonV4): Promise<void>;
  finalize(input: { command_id: string; run_id: string }, daemon: BrokerDaemonV4): Promise<void>;
  stopExternal(runId: string, daemon: BrokerDaemonV4): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface ComposedRuntimeHostControlV4 {
  readonly daemon: BrokerDaemonV4;
  readonly controlPlane: BrokerIpcControlPlaneV4;
  close(): Promise<void>;
}

export interface RuntimeHostCompositionV4 extends ComposedRuntimeHostControlV4 {
  readonly ipc: BrokerIpcServerV4;
}

export interface RuntimeHostCompositionDependenciesV4 {
  readonly daemon: BrokerDaemonDependenciesV4;
  readonly ipc: Omit<BrokerIpcDependenciesV4, 'daemon' | 'controlPlane' | 'stateDirectory'>;
  readonly operations: RuntimeHostOperationsV4;
  readonly onBackgroundFailure?: (runId: string, failure: RuntimeFailureV4) => void;
}

function terminal(state: string): boolean {
  return state === 'FAILED' || state === 'ABORTED' || state === 'FINALIZED';
}

function boundedFailure(error: unknown): RuntimeFailureV4 {
  const match = error instanceof Error ? /^([A-Z_]+):/u.exec(error.message) : null;
  const code = match !== null && RUNTIME_FAILURE_CODES_V4.includes(match[1] as RuntimeFailureV4['code']) ? match[1] as RuntimeFailureV4['code'] : 'UNKNOWN_FAILURE';
  return Object.freeze({
    code,
    message: `${code}: composed host operation failed`,
    retryable: code === 'PROVIDER_UNAVAILABLE',
    evidence_hashes: Object.freeze([hashCanonicalV4({ code, boundary: 'runtime-host-v4' })]),
  });
}

async function replyFor(daemon: BrokerDaemonV4, runId: string): Promise<BrokerReplyV4> {
  const result = await daemon.status(runId);
  return Object.freeze({
    request_id: result.request_id,
    run_id: result.run_id,
    state: result.state,
    status_token: hashCanonicalV4({ run_id: result.run_id, state: result.state, artifact_manifest_hash: result.artifact_manifest_hash }),
  });
}

export function composeRuntimeHostControlV4(
  baseDaemon: BrokerDaemonV4,
  operations: RuntimeHostOperationsV4,
  onBackgroundFailure?: (runId: string, failure: RuntimeFailureV4) => void,
): ComposedRuntimeHostControlV4 {
  if (typeof baseDaemon.recordAcceptedCandidate !== 'function' || typeof baseDaemon.recordFailure !== 'function' || typeof baseDaemon.recordAbort !== 'function') {
    throw new Error('CAPABILITY_UNVERIFIED: daemon lifecycle persistence is incomplete');
  }
  const flights = new Map<string, Promise<void>>();
  const aborting = new Set<string>();
  let closing = false;

  const schedule = async (runId: string): Promise<void> => {
    if (closing || flights.has(runId)) return;
    const current = await baseDaemon.status(runId);
    if (terminal(current.state)) return;
    const flight = Promise.resolve()
      .then(() => operations.advance(runId, baseDaemon))
      .catch(async (error: unknown) => {
        if (aborting.has(runId)) return;
        const failure = boundedFailure(error);
        try {
          await baseDaemon.recordFailure!(runId, failure, `host-failed:${runId}:${failure.evidence_hashes[0]}`);
          onBackgroundFailure?.(runId, failure);
        } catch {
          onBackgroundFailure?.(runId, Object.freeze({ code: 'UNKNOWN_FAILURE', message: 'UNKNOWN_FAILURE: terminal host failure could not be persisted', retryable: false, evidence_hashes: failure.evidence_hashes }));
        }
      })
      .finally(() => { flights.delete(runId); });
    flights.set(runId, flight);
  };

  const daemon: BrokerDaemonV4 = Object.freeze({
    ...baseDaemon,
    submit: async (command: Parameters<BrokerDaemonV4['submit']>[0]) => {
      const reply = await baseDaemon.submit(command);
      await schedule(reply.run_id);
      return reply;
    },
  });

  const controlPlane: BrokerIpcControlPlaneV4 = Object.freeze({
    repair: async (input: Parameters<BrokerIpcControlPlaneV4['repair']>[0]) => {
      if (flights.has(input.run_id)) throw new Error('REPOSITORY_BUSY: run pipeline is still active');
      await operations.prepareRepair(input, baseDaemon);
      await schedule(input.run_id);
      return replyFor(baseDaemon, input.run_id);
    },
    finalize: async (input: Parameters<BrokerIpcControlPlaneV4['finalize']>[0]) => {
      if (flights.has(input.run_id)) throw new Error('REPOSITORY_BUSY: run pipeline is still active');
      await operations.finalize(input, baseDaemon);
      return replyFor(baseDaemon, input.run_id);
    },
    abort: async (input: Parameters<BrokerIpcControlPlaneV4['abort']>[0]) => {
      aborting.add(input.run_id);
      try {
        await operations.stopExternal(input.run_id, baseDaemon);
        await baseDaemon.recordAbort!(input.run_id, input.command_id);
        return replyFor(baseDaemon, input.run_id);
      } catch (error) {
        aborting.delete(input.run_id);
        throw error;
      }
    },
  });

  return Object.freeze({
    daemon,
    controlPlane,
    close: async () => {
      if (closing) return;
      closing = true;
      await operations.shutdown?.();
      await Promise.allSettled([...flights.values()]);
      await baseDaemon.close();
    },
  });
}

export async function createRuntimeHostCompositionV4(deps: RuntimeHostCompositionDependenciesV4): Promise<RuntimeHostCompositionV4> {
  if (deps.daemon.allowInProcessCoordinatorForTests || deps.ipc.allowInProcessCoordinatorForTests || deps.ipc.allowInProcessPhysicalPathBackendForTests) {
    throw new Error('CAPABILITY_UNVERIFIED: test-only host authorities are forbidden in production composition');
  }
  const baseDaemon = createBrokerDaemon(deps.daemon);
  await baseDaemon.recover();
  const control = composeRuntimeHostControlV4(baseDaemon, deps.operations, deps.onBackgroundFailure);
  let ipc: BrokerIpcServerV4;
  try {
    ipc = await createBrokerIpcServer({ ...deps.ipc, daemon: control.daemon, controlPlane: control.controlPlane, stateDirectory: deps.daemon.stateDirectory });
  } catch (error) {
    await control.close();
    throw error;
  }
  return Object.freeze({
    daemon: control.daemon,
    controlPlane: control.controlPlane,
    ipc,
    close: async () => {
      await ipc.close();
      await control.close();
    },
  });
}
