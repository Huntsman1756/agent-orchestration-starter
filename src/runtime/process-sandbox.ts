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
