export type SandboxProfileV4 =
  | 'EXECUTOR_NETWORKED'
  | 'FRONTIER_NETWORKED'
  | 'VALIDATION_UNTRUSTED'
  | 'REVIEW_CAPSULE';

export interface SandboxMountV4 {
  readonly source: string;
  readonly target: '/capsule' | '/workspace' | '/scratch';
  readonly access: 'READ_ONLY' | 'READ_WRITE';
}

export type SandboxNetworkV4 =
  | { readonly mode: 'NONE' }
  | { readonly mode: 'INTERNAL'; readonly name: string };

export interface SandboxRunRequestV4 {
  readonly execution_id: string;
  readonly profile: SandboxProfileV4;
  readonly argv: readonly string[];
  readonly working_directory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mounts: readonly SandboxMountV4[];
  readonly network: SandboxNetworkV4;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}

export type SandboxProbeResultV4 =
  | {
      readonly status: 'SUPPORTED';
      readonly backend_id: string;
      readonly policy_hash: string;
      readonly certification_hash: string;
      readonly expires_at: string;
    }
  | {
      readonly status: 'UNSUPPORTED';
      readonly failure: 'PROCESS_SANDBOX_UNAVAILABLE';
    };

export interface SandboxRunResultV4 {
  readonly execution_id: string;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timed_out: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_truncated: boolean;
  readonly stderr_truncated: boolean;
  readonly duration_ms: number;
}

export interface ProcessSandboxBackendV4 {
  readonly id: string;
  probe(profile: SandboxProfileV4): Promise<SandboxProbeResultV4>;
  run(request: SandboxRunRequestV4): Promise<SandboxRunResultV4>;
  terminate(executionId: string): Promise<void>;
}

export interface DockerContainerRemovalEffectsV4 {
  readonly inspect_exact_id: (containerId: string) => Promise<boolean>;
  readonly force_remove_exact_id: (containerId: string) => Promise<void>;
  readonly poll_interval_ms: number;
  readonly absence_timeout_ms: number;
}

export interface DockerContainerRemovalControllerV4 {
  readonly container_id: string;
  remove(): Promise<void>;
}

export function createDockerContainerRemovalControllerV4(
  containerId: string,
  effects: DockerContainerRemovalEffectsV4,
): DockerContainerRemovalControllerV4 {
  const unavailable = (): never => {
    throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
  };
  if (!/^[a-f0-9]{64}$/.test(containerId)
    || !Number.isSafeInteger(effects.poll_interval_ms)
    || effects.poll_interval_ms < 1
    || effects.poll_interval_ms > 1_000
    || !Number.isSafeInteger(effects.absence_timeout_ms)
    || effects.absence_timeout_ms < 1
    || effects.absence_timeout_ms > 30_000) unavailable();
  let verifiedAbsent = false;
  let inFlight: Promise<void> | null = null;
  const remove = (): Promise<void> => {
    if (verifiedAbsent) return Promise.resolve();
    if (inFlight !== null) return inFlight;
    const operation = (async (): Promise<void> => {
      let present = true;
      try {
        present = await effects.inspect_exact_id(containerId);
      } catch {
        unavailable();
      }
      if (!present) {
        verifiedAbsent = true;
        return;
      }
      try {
        await effects.force_remove_exact_id(containerId);
      } catch {
        unavailable();
      }
      const deadline = Date.now() + effects.absence_timeout_ms;
      while (true) {
        try {
          present = await effects.inspect_exact_id(containerId);
        } catch {
          unavailable();
        }
        if (!present) {
          verifiedAbsent = true;
          return;
        }
        if (Date.now() >= deadline) unavailable();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, effects.poll_interval_ms));
      }
    })();
    inFlight = operation.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return Object.freeze({ container_id: containerId, remove });
}

const unsupportedProbe: SandboxProbeResultV4 = Object.freeze({
  status: 'UNSUPPORTED',
  failure: 'PROCESS_SANDBOX_UNAVAILABLE',
});

export function createUnsupportedProcessSandboxBackendV4(id: string): ProcessSandboxBackendV4 {
  return Object.freeze({
    id,
    probe: async () => unsupportedProbe,
    run: async () => {
      throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
    },
    terminate: async () => {},
  });
}
