import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as path from 'node:path';

import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import type { AllowedChangeV4 } from './contracts.js';

const execFileAsync = promisify(execFile);

export interface PathOperationsV4 {
  readonly sep: string;
  resolve(...paths: string[]): string;
  dirname(value: string): string;
  relative(from: string, to: string): string;
  isAbsolute(value: string): boolean;
}

export interface PathEntryMetadataV4 {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: number;
}

export interface PathMetadataProviderV4 {
  realpath(value: string): Promise<string>;
  lstat(value: string): Promise<PathEntryMetadataV4>;
  stat(value: string): Promise<PathEntryMetadataV4>;
  mountIdentity(value: string): Promise<string | null>;
  isReparsePoint(value: string): Promise<boolean | null>;
}

export interface PathInspectionInputV4 {
  repositoryRoot: string;
  changes: readonly AllowedChangeV4[];
  platform: NodeJS.Platform;
  metadata?: PathMetadataProviderV4;
  pathApi?: PathOperationsV4;
}

export interface InspectedChangeV4 extends AllowedChangeV4 {
  canonical_parent: string;
  existed_at_freeze: boolean;
}

function outOfScope(message: string): never {
  throw new Error(`OUT_OF_SCOPE_CHANGE: ${message}`);
}

function selectPathApi(platform: NodeJS.Platform, supplied?: PathOperationsV4): PathOperationsV4 {
  if (supplied !== undefined) return supplied;
  return platform === 'win32' ? path.win32 : path.posix;
}

function withinRoot(root: string, candidate: string, platform: NodeJS.Platform, pathApi: PathOperationsV4): boolean {
  const from = platform === 'win32' ? root.toLocaleLowerCase() : root;
  const to = platform === 'win32' ? candidate.toLocaleLowerCase() : candidate;
  const pathToCandidate = pathApi.relative(from, to);
  return pathToCandidate === ''
    || (!pathApi.isAbsolute(pathToCandidate) && pathToCandidate !== '..' && !pathToCandidate.startsWith(`..${pathApi.sep}`));
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseLinuxMountIdentityV4(value: string, mountinfo: string): string | null {
  const entries = mountinfo.split('\n').flatMap((line) => {
    const fields = line.split(' ');
    if (fields.length < 5) return [];
    return [{ id: fields[0], device: fields[2], mountPoint: decodeMountPath(fields[4]) }];
  });
  const matching = entries
    .filter((entry) => entry.mountPoint === '/'
      ? value.startsWith('/')
      : value === entry.mountPoint || value.startsWith(`${entry.mountPoint}/`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  return matching === undefined ? null : `${matching.id}:${matching.device}`;
}

async function linuxMountIdentity(value: string): Promise<string | null> {
  try {
    return parseLinuxMountIdentityV4(value, await readFile('/proc/self/mountinfo', 'utf8'));
  } catch {
    return null;
  }
}

const windowsMetadataScript = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RunnerV4Volume {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetVolumePathName(string fileName, StringBuilder volumePathName, int cchBufferLength);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetVolumeNameForVolumeMountPoint(string volumeMountPoint, StringBuilder volumeName, int cchBufferLength);
}
'@
$literalPath = $env:RUNNER_V4_LITERAL_PATH
$item = Get-Item -Force -LiteralPath $literalPath
$volumePath = New-Object System.Text.StringBuilder 1024
if (-not [RunnerV4Volume]::GetVolumePathName($literalPath, $volumePath, $volumePath.Capacity)) { throw 'GetVolumePathName failed' }
$volumeName = New-Object System.Text.StringBuilder 1024
if (-not [RunnerV4Volume]::GetVolumeNameForVolumeMountPoint($volumePath.ToString(), $volumeName, $volumeName.Capacity)) { throw 'GetVolumeNameForVolumeMountPoint failed' }
[pscustomobject]@{
  reparse = (([System.IO.FileAttributes]$item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  mount = $volumeName.ToString()
} | ConvertTo-Json -Compress`;

interface WindowsMetadata { reparse: boolean; mount: string; }

function windowsMetadataProvider(): PathMetadataProviderV4 {
  const cache = new Map<string, Promise<WindowsMetadata | null>>();
  const metadataFor = (value: string): Promise<WindowsMetadata | null> => {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const pending = execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsMetadataScript,
    ], { env: { ...process.env, RUNNER_V4_LITERAL_PATH: value }, windowsHide: true, maxBuffer: 8_192 })
      .then(({ stdout }) => JSON.parse(stdout.trim()) as WindowsMetadata)
      .catch(() => null);
    cache.set(value, pending);
    return pending;
  };
  return {
    realpath,
    lstat,
    stat,
    mountIdentity: async (value) => (await metadataFor(value))?.mount ?? null,
    isReparsePoint: async (value) => (await metadataFor(value))?.reparse ?? null,
  };
}

function defaultMetadataProvider(platform: NodeJS.Platform): PathMetadataProviderV4 {
  if (platform === 'win32' && process.platform === 'win32') return windowsMetadataProvider();
  if (platform === 'linux' && process.platform === 'linux') {
    return {
      realpath,
      lstat,
      stat,
      mountIdentity: linuxMountIdentity,
      isReparsePoint: async () => false,
    };
  }
  return {
    realpath,
    lstat,
    stat,
    mountIdentity: async () => null,
    isReparsePoint: async () => null,
  };
}

async function exists(metadata: PathMetadataProviderV4, value: string): Promise<boolean> {
  try {
    await metadata.lstat(value);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectExistingComponent(
  metadata: PathMetadataProviderV4,
  value: string,
  expectedMountIdentity: string,
  expectedDevice: number,
  changePath: string,
): Promise<void> {
  const entry = await metadata.lstat(value);
  if (entry.isSymbolicLink()) outOfScope(`reparse path component: ${changePath}`);
  if (entry.dev !== expectedDevice) outOfScope(`component device differs from repository root: ${changePath}`);
  const reparse = await metadata.isReparsePoint(value);
  if (reparse === null) outOfScope(`reparse metadata unavailable: ${changePath}`);
  if (reparse) outOfScope(`reparse metadata set: ${changePath}`);
  const mountIdentity = await metadata.mountIdentity(value);
  if (mountIdentity === null) outOfScope(`mount identity unavailable: ${changePath}`);
  if (mountIdentity !== expectedMountIdentity) outOfScope(`mount identity changed: ${changePath}`);
}

export async function inspectAllowedChanges(input: PathInspectionInputV4): Promise<readonly InspectedChangeV4[]> {
  const pathApi = selectPathApi(input.platform, input.pathApi);
  const metadata = input.metadata ?? defaultMetadataProvider(input.platform);
  const canonicalRoot = await metadata.realpath(input.repositoryRoot).catch(() => outOfScope('repository root cannot be canonicalized'));
  const rootStats = await metadata.stat(canonicalRoot);
  if (!rootStats.isDirectory()) outOfScope('repository root is not a directory');
  const rootMountIdentity = await metadata.mountIdentity(canonicalRoot);
  if (rootMountIdentity === null) outOfScope('mount identity unavailable for repository root');
  await inspectExistingComponent(metadata, canonicalRoot, rootMountIdentity, rootStats.dev, '<repository-root>');

  const seen = new Set<string>();
  const inspected: InspectedChangeV4[] = [];
  for (const change of input.changes) {
    if (!isNormalizedRepositoryRelativePathV4(change.path)) outOfScope(`invalid path: ${change.path}`);
    const folded = change.path.toLowerCase();
    if (seen.has(folded)) outOfScope(`case-fold collision: ${change.path}`);
    seen.add(folded);

    const candidate = pathApi.resolve(canonicalRoot, ...change.path.split('/'));
    if (!withinRoot(canonicalRoot, candidate, input.platform, pathApi)) outOfScope(`outside repository root: ${change.path}`);
    const parent = pathApi.dirname(candidate);
    const canonicalParent = await metadata.realpath(parent).catch(() => outOfScope(`parent cannot be canonicalized: ${change.path}`));
    if (!withinRoot(canonicalRoot, canonicalParent, input.platform, pathApi)) outOfScope(`canonical parent outside repository root: ${change.path}`);
    if ((await metadata.stat(canonicalParent)).dev !== rootStats.dev) outOfScope(`parent device differs from repository root: ${change.path}`);

    let current = canonicalRoot;
    for (const segment of change.path.split('/').slice(0, -1)) {
      current = pathApi.resolve(current, segment);
      if (!(await exists(metadata, current))) break;
      await inspectExistingComponent(metadata, current, rootMountIdentity, rootStats.dev, change.path);
      const resolved = await metadata.realpath(current);
      if (resolved !== current) outOfScope(`canonical path component changed: ${change.path}`);
    }
    const existedAtFreeze = await exists(metadata, candidate);
    if (existedAtFreeze) {
      await inspectExistingComponent(metadata, candidate, rootMountIdentity, rootStats.dev, change.path);
    }
    inspected.push(Object.freeze({
      path: change.path,
      operations: Object.freeze([...change.operations]),
      canonical_parent: canonicalParent,
      existed_at_freeze: existedAtFreeze,
    }));
  }
  return Object.freeze(inspected);
}
