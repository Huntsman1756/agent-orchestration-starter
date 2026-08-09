import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';

interface PhysicalIdentityV4 {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

export interface DockerLauncherIdentityV4 {
  readonly executable: string;
  readonly endpoint_context: string | null;
  readonly endpoint_host: string | null;
  readonly chain: readonly PhysicalIdentityV4[];
  readonly file: PhysicalIdentityV4 & {
    readonly bytes: string;
    readonly content_hash: `sha256:${string}`;
  };
}

const registered = new Map<string, DockerLauncherIdentityV4>();

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: Docker launcher identity is unavailable');
}

function normalized(value: string): string {
  const resolved = resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function dockerLauncherIdentityHashV4(identity: DockerLauncherIdentityV4): string {
  return hashCanonicalV4(identity);
}

async function inspect(executable: string, signal?: AbortSignal): Promise<DockerLauncherIdentityV4> {
  if (signal?.aborted) unavailable();
  if (!isAbsolute(executable) || resolve(executable) !== executable || !/^docker(?:\.exe)?$/i.test(basename(executable))) unavailable();
  const parents: string[] = [];
  let current = dirname(executable);
  const root = parse(current).root;
  while (true) {
    parents.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) unavailable();
    current = parent;
  }
  parents.reverse();
  const chain: PhysicalIdentityV4[] = [];
  for (const path of parents) {
    if (signal?.aborted) unavailable();
    const metadata = await lstat(path, { bigint: true }).catch(() => unavailable());
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev < 0n || metadata.ino <= 0n) unavailable();
    if (process.platform !== 'win32') {
      const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -1n;
      if ((metadata.uid !== 0n && metadata.uid !== uid) || (metadata.mode & 0o022n) !== 0n) unavailable();
    }
    chain.push(Object.freeze({ path, device: String(metadata.dev), inode: String(metadata.ino) }));
  }
  const metadata = await lstat(executable, { bigint: true }).catch(() => unavailable());
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev < 0n || metadata.ino <= 0n || metadata.size <= 0n) unavailable();
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : -1n;
    if ((metadata.uid !== 0n && metadata.uid !== uid) || (metadata.mode & 0o022n) !== 0n) unavailable();
  }
  if (normalized(await realpath(executable).catch(() => unavailable())) !== normalized(executable)) unavailable();
  const bytes = await readFile(executable, { signal }).catch(() => unavailable());
  const endpointHost = process.env.DOCKER_HOST ?? null;
  const endpointContext = process.env.DOCKER_CONTEXT ?? null;
  if (endpointHost?.includes('\0') === true || endpointContext?.includes('\0') === true) unavailable();
  return Object.freeze({
    executable,
    endpoint_context: endpointContext,
    endpoint_host: endpointHost,
    chain: Object.freeze(chain),
    file: Object.freeze({
      path: executable,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      bytes: String(metadata.size),
      content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }),
  });
}

export async function registerOrReproveDockerLauncherV4(
  executable: string,
  signal?: AbortSignal,
): Promise<DockerLauncherIdentityV4> {
  const observed = await inspect(executable, signal);
  const existing = registered.get(executable);
  if (existing !== undefined && dockerLauncherIdentityHashV4(existing) !== dockerLauncherIdentityHashV4(observed)) unavailable();
  if (existing === undefined) registered.set(executable, observed);
  return existing ?? observed;
}
