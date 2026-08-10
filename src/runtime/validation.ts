import { hashCanonicalV4 } from './canonical.js';
import type { ArtifactReferenceV4, ArtifactStoreV4 } from './artifact-store.js';
import { assertResolvedValidationV4, type ResolvedValidationV4 } from './process-policy.js';
import type { ProcessSandboxBackendV4 } from './process-sandbox.js';

export interface ValidationRunInputV4 {
  readonly execution_id: string;
  readonly validation: ResolvedValidationV4;
  readonly expected_policy_hash: string;
  readonly expected_sandbox_policy_hash: string;
  readonly capsule_root: string;
  readonly repository_root: string;
  readonly tree_hash: string;
}

export interface ValidationResultV4 {
  readonly validation_id: string;
  readonly passed: boolean;
  readonly failure_code: 'VALIDATION_FAILED' | null;
  readonly policy_hash: string;
  readonly sandbox_policy_hash: string;
  readonly sandbox_backend_id: string;
  readonly sandbox_certification_hash: string;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly stdout_preview: string;
  readonly stderr_preview: string;
  readonly stdout_artifact: ArtifactReferenceV4;
  readonly stderr_artifact: ArtifactReferenceV4;
  readonly validated_tree_hash: string;
  readonly result_hash: string;
}

export interface ValidationRunnerV4 { run(input: ValidationRunInputV4): Promise<ValidationResultV4>; }
export interface ValidationRunnerDependenciesV4 {
  readonly sandbox: ProcessSandboxBackendV4;
  readonly artifacts: ArtifactStoreV4;
  readonly current_tree_hash: (repositoryRoot: string) => Promise<string>;
  readonly preview_bytes: number;
  readonly now?: () => string;
}

function failed(message: string): never { throw new Error(`VALIDATION_FAILED: ${message}`); }
function preview(value: string, maximumBytes: number): string {
  let result = '';
  let size = 0;
  for (const symbol of value) {
    const bytes = Buffer.byteLength(symbol, 'utf8');
    if (size + bytes > maximumBytes) break;
    result += symbol;
    size += bytes;
  }
  return result;
}

export function createValidationRunner(deps: ValidationRunnerDependenciesV4): ValidationRunnerV4 {
  if (!Number.isSafeInteger(deps.preview_bytes) || deps.preview_bytes < 0 || deps.preview_bytes > 64 * 1024) failed('preview byte policy is invalid');
  return Object.freeze({
    run: async (input: ValidationRunInputV4): Promise<ValidationResultV4> => {
      const expectedKeys = ['capsule_root', 'execution_id', 'expected_policy_hash', 'expected_sandbox_policy_hash', 'repository_root', 'tree_hash', 'validation'];
      const suppliedKeys = Object.keys(input).sort();
      if (suppliedKeys.length !== expectedKeys.length || suppliedKeys.some((key, index) => key !== expectedKeys[index])) {
        failed('caller supplied non-policy validation fields');
      }
      assertResolvedValidationV4(input.validation, input.expected_policy_hash);
      if (!/^[a-f0-9]{64}$/.test(input.tree_hash) || !/^[a-f0-9]{64}$/.test(input.expected_sandbox_policy_hash)) failed('validation identity is invalid');
      const now = (deps.now ?? (() => new Date().toISOString()))();
      const beforeTreeHash = await deps.current_tree_hash(input.repository_root);
      const probe = await deps.sandbox.probe('VALIDATION_UNTRUSTED');
      if (probe.status !== 'SUPPORTED' || probe.policy_hash !== input.expected_sandbox_policy_hash || Date.parse(probe.expires_at) <= Date.parse(now)) {
        failed('validation sandbox is unavailable or stale');
      }
      const run = beforeTreeHash === input.tree_hash
        ? await deps.sandbox.run({
          execution_id: input.execution_id,
          profile: 'VALIDATION_UNTRUSTED',
          argv: input.validation.argv,
          working_directory: input.validation.working_directory === '.' ? '/capsule/repo' : `/capsule/repo/${input.validation.working_directory}`,
          environment: Object.freeze({ HOME: '/capsule/home', TMPDIR: '/capsule/tmp', NO_COLOR: '1' }),
          mounts: [
            { source: input.capsule_root, target: '/capsule', access: 'READ_WRITE' },
            { source: input.repository_root, target: '/capsule/repo', access: 'READ_WRITE' },
          ],
          network: { mode: 'NONE' },
          timeout_ms: input.validation.timeout_ms,
          max_output_bytes: 16 * 1024 * 1024,
        })
        : { execution_id: input.execution_id, exit_code: null, signal: null, timed_out: false, stdout: '', stderr: 'tree changed before validation', stdout_truncated: false, stderr_truncated: false, duration_ms: 0 };
      const stdoutBytes = Buffer.from(run.stdout, 'utf8');
      const stderrBytes = Buffer.from(run.stderr, 'utf8');
      const [stdoutArtifact, stderrArtifact] = await Promise.all([
        deps.artifacts.put('VALIDATION_STDOUT', stdoutBytes),
        deps.artifacts.put('VALIDATION_STDERR', stderrBytes),
      ]);
      const artifactsValid = await Promise.all([deps.artifacts.verify(stdoutArtifact), deps.artifacts.verify(stderrArtifact)]).then((values) => values.every(Boolean));
      const afterTreeHash = await deps.current_tree_hash(input.repository_root);
      const passed = beforeTreeHash === input.tree_hash
        && afterTreeHash === input.tree_hash
        && artifactsValid
        && run.exit_code === 0
        && !run.timed_out
        && !run.stdout_truncated
        && !run.stderr_truncated;
      const body = {
        validation_id: input.validation.validation_id,
        passed,
        failure_code: passed ? null : 'VALIDATION_FAILED' as const,
        policy_hash: input.expected_policy_hash,
        sandbox_policy_hash: probe.policy_hash,
        sandbox_backend_id: probe.backend_id,
        sandbox_certification_hash: probe.certification_hash,
        exit_code: run.exit_code,
        duration_ms: run.duration_ms,
        stdout_preview: preview(run.stdout, deps.preview_bytes),
        stderr_preview: preview(run.stderr, deps.preview_bytes),
        stdout_artifact: stdoutArtifact,
        stderr_artifact: stderrArtifact,
        validated_tree_hash: input.tree_hash,
      };
      return Object.freeze({ ...body, result_hash: hashCanonicalV4(body) });
    },
  });
}
