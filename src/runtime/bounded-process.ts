import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface BoundedProcessResultV4 {
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdout_truncated: boolean;
  readonly stderr_truncated: boolean;
  readonly termination: 'ABORT' | 'OUTPUT_LIMIT' | 'TIMEOUT' | null;
}

export interface BoundedProcessHandleV4 {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<BoundedProcessResultV4>;
  terminate(): Promise<void>;
}

interface BoundedProcessRequestV4 {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly deadline_ms: number;
  readonly max_output_bytes: number;
  readonly signal?: AbortSignal;
}

function boundedAppend(chunks: Buffer[], size: number, chunk: Buffer | string, limit: number): { size: number; truncated: boolean } {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (size >= limit) return { size, truncated: true };
  const accepted = bytes.subarray(0, limit - size);
  if (accepted.length > 0) chunks.push(accepted);
  return { size: size + accepted.length, truncated: accepted.length < bytes.length };
}

export function startBoundedProcessV4(request: BoundedProcessRequestV4): BoundedProcessHandleV4 {
  if (!Number.isSafeInteger(request.deadline_ms) || request.deadline_ms < 1
    || !Number.isSafeInteger(request.max_output_bytes) || request.max_output_bytes < 1) {
    throw new Error('PROCESS_SANDBOX_UNAVAILABLE: bounded process policy is invalid');
  }
  const child = spawn(request.executable, [...request.argv], {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: request.environment,
  });
  let stdoutSize = 0;
  let stderrSize = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stopping = false;
  let settled = false;
  let termination: BoundedProcessResultV4['termination'] = null;
  let settlementTimer: NodeJS.Timeout | null = null;
  let resolveCompletion!: (result: BoundedProcessResultV4) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<BoundedProcessResultV4>((resolvePromise, reject) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = reject;
  });
  const cleanup = () => {
    clearTimeout(deadline);
    if (settlementTimer !== null) clearTimeout(settlementTimer);
    request.signal?.removeEventListener('abort', abort);
  };
  const failSettlement = () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(new Error('PROCESS_SANDBOX_UNAVAILABLE: process tree did not settle'));
  };
  const killTree = () => {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      const killerDeadline = setTimeout(() => killer.kill('SIGKILL'), 1_000);
      killerDeadline.unref();
      killer.once('close', () => clearTimeout(killerDeadline));
      killer.once('error', () => child.kill('SIGKILL'));
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  };
  const stop = (reason: Exclude<BoundedProcessResultV4['termination'], null>) => {
    if (stopping || settled) return;
    stopping = true;
    termination = reason;
    killTree();
    settlementTimer = setTimeout(failSettlement, 1_500);
    settlementTimer.unref();
  };
  const abort = () => stop('ABORT');
  const deadline = setTimeout(() => stop('TIMEOUT'), request.deadline_ms);
  deadline.unref();
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  child.stdout.on('data', (chunk: Buffer | string) => {
    const appended = boundedAppend(stdout, stdoutSize, chunk, request.max_output_bytes);
    stdoutSize = appended.size;
    stdoutTruncated ||= appended.truncated;
    if (stdoutTruncated) stop('OUTPUT_LIMIT');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const appended = boundedAppend(stderr, stderrSize, chunk, request.max_output_bytes);
    stderrSize = appended.size;
    stderrTruncated ||= appended.truncated;
    if (stderrTruncated) stop('OUTPUT_LIMIT');
  });
  child.once('error', () => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCompletion(new Error('PROCESS_SANDBOX_UNAVAILABLE: process spawn failed'));
  });
  child.once('close', (exitCode, signal) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCompletion(Object.freeze({
      exit_code: exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      termination,
    }));
  });
  return Object.freeze({
    child,
    completion,
    terminate: async () => {
      stop('ABORT');
      await completion.then(() => undefined);
    },
  });
}

export async function runBoundedProcessV4(request: BoundedProcessRequestV4): Promise<BoundedProcessResultV4> {
  const handle = startBoundedProcessV4(request);
  handle.child.stdin.end();
  return await handle.completion;
}
