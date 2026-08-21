import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import { loadRuntimeProfileV4, loadRuntimeRepositoryPolicyV4 } from './load.js';
import { renderCodexProjectConfig } from './codex-project-config.js';
import type { RuntimeActivationTargetV4 } from './readiness.js';
import {
  bindRuntimeHostCompositionV4,
  loadRuntimeHostComponentSourceManifestV4,
  loadRuntimeHostCompositionBindingV4,
  type RuntimeHostCompositionBindingV4,
} from './host-components.js';

const hashPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const maxFiles = 4096;
const maxBytes = 256 * 1024 * 1024;
const maxHostComponentManifestBytes = 1024 * 1024;

export interface RuntimeInstalledFileV4 {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export interface RuntimeHostInstallationManifestV4 {
  readonly schemaVersion: 4;
  readonly installationId: string;
  readonly packageVersion: string;
  readonly root: string;
  readonly entrypoint: string;
  readonly hostDriver: { readonly path: string; readonly sha256: string } | null;
  readonly hostComposition: RuntimeHostCompositionBindingV4 | null;
  readonly installedAt: string;
  readonly files: readonly RuntimeInstalledFileV4[];
  readonly installationHash: string;
}

export interface RuntimeRepositoryActivationV4 {
  readonly schemaVersion: 4;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly policyPath: string;
  readonly policyHash: string;
  readonly profilePath: string;
  readonly profileHash: string;
  readonly worktreeParent: string;
  readonly stateDirectory: string;
  readonly installationManifest: string;
  readonly installationHash: string;
  readonly hostCompositionHash: string | null;
  readonly target: RuntimeActivationTargetV4;
  readonly activatedAt: string;
  readonly activationHash: string;
}

export function loadRuntimeRepositoryActivationV4(value: unknown): RuntimeRepositoryActivationV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('activation manifest is not an object');
  const item = value as Record<string, unknown>;
  const expected = [
    'activatedAt',
    'activationHash',
    'hostCompositionHash',
    'installationHash',
    'installationManifest',
    'policyHash',
    'policyPath',
    'profileHash',
    'profilePath',
    'repositoryId',
    'repositoryRoot',
    'schemaVersion',
    'stateDirectory',
    'target',
    'worktreeParent',
  ];
  if (Object.keys(item).sort().join(',') !== expected.sort().join(',')) invalid('activation manifest has unknown or missing fields');
  for (const field of [
    'repositoryRoot',
    'policyPath',
    'profilePath',
    'worktreeParent',
    'stateDirectory',
    'installationManifest',
  ] as const) {
    if (typeof item[field] !== 'string' || !isAbsolute(item[field] as string)) invalid(`activation ${field} is invalid`);
  }
  if (item.schemaVersion !== 4 || typeof item.repositoryId !== 'string' || !idPattern.test(item.repositoryId))
    invalid('activation identity is invalid');
  if (!['ANALYSIS_ONLY', 'ISOLATED_EXECUTION', 'AUTONOMOUS_PUBLICATION'].includes(String(item.target)))
    invalid('activation target is invalid');
  for (const field of ['policyHash', 'profileHash', 'installationHash', 'activationHash'] as const)
    if (!hashPattern.test(String(item[field]))) invalid(`activation ${field} is invalid`);
  if (item.hostCompositionHash !== null && !hashPattern.test(String(item.hostCompositionHash)))
    invalid('activation hostCompositionHash is invalid');
  timestamp(String(item.activatedAt), 'activatedAt');
  const draft = {
    schemaVersion: 4 as const,
    repositoryId: String(item.repositoryId),
    repositoryRoot: String(item.repositoryRoot),
    policyPath: String(item.policyPath),
    policyHash: String(item.policyHash),
    profilePath: String(item.profilePath),
    profileHash: String(item.profileHash),
    worktreeParent: String(item.worktreeParent),
    stateDirectory: String(item.stateDirectory),
    installationManifest: String(item.installationManifest),
    installationHash: String(item.installationHash),
    hostCompositionHash: item.hostCompositionHash === null ? null : String(item.hostCompositionHash),
    target: item.target as RuntimeActivationTargetV4,
    activatedAt: String(item.activatedAt),
  };
  if (hashCanonicalV4(draft) !== item.activationHash) invalid('activation hash is invalid');
  return Object.freeze({ ...draft, activationHash: String(item.activationHash) });
}

export async function verifyRuntimeRepositoryActivationV4(
  path: string,
): Promise<{ activation: RuntimeRepositoryActivationV4; installation: RuntimeHostInstallationManifestV4 }> {
  const canonicalPath = await realpath(resolve(path)).catch(() => invalid('activation manifest cannot be canonicalized'));
  const activation = loadRuntimeRepositoryActivationV4(JSON.parse(await readFile(canonicalPath, 'utf8')));
  const repositoryRoot = await canonicalGitRoot(activation.repositoryRoot);
  if (canonicalPath !== join(repositoryRoot, '.agent-orchestration', 'activation-v4.json'))
    invalid('activation manifest is outside its canonical repository location');
  for (const recorded of [activation.policyPath, activation.profilePath, activation.worktreeParent]) {
    if ((await realpath(recorded).catch(() => invalid('an activated path is unavailable'))) !== recorded)
      invalid('an activated path drifted from its canonical location');
  }
  const policy = loadRuntimeRepositoryPolicyV4(await loadYaml(activation.policyPath));
  const profile = loadRuntimeProfileV4(await loadYaml(activation.profilePath));
  if (
    policy.repositoryId !== activation.repositoryId ||
    hashCanonicalV4(policy) !== activation.policyHash ||
    hashCanonicalV4(profile) !== activation.profileHash
  )
    invalid('activation policy or profile drifted');
  const installation = loadRuntimeHostInstallationV4(JSON.parse(await readFile(activation.installationManifest, 'utf8')));
  if (
    activation.installationManifest !== join(installation.root, 'installation-v4.json') ||
    installation.installationHash !== activation.installationHash
  )
    invalid('activation installation binding drifted');
  if (activation.hostCompositionHash !== (installation.hostComposition?.compositionCertificationHash ?? null))
    invalid('activation host composition binding drifted');
  const hostRoot = dirname(dirname(installation.root));
  if (activation.stateDirectory !== join(hostRoot, 'state', activation.repositoryId))
    invalid('activation state directory is outside the host root');
  await verifyRuntimeHostInstallationV4(installation);
  return Object.freeze({ activation, installation });
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: ${message}`);
}
function timestamp(value: string, field: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid(`${field} is invalid`);
}
function portable(path: string): string {
  return path.split(sep).join('/');
}
async function rejectWindowsPathLinks(path: string, message: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const root = parse(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const metadata = await lstat(current).catch(() => invalid(`${message}: path component unavailable`));
    if (metadata.isSymbolicLink()) invalid(message);
  }
}
function within(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
async function fileHash(path: string): Promise<{ sha256: string; size: number }> {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, `${canonicalJsonV4(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, path).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
}
async function sourceFiles(root: string): Promise<readonly RuntimeInstalledFileV4[]> {
  const selected = [
    { path: 'dist/host/agent-orchestration.mjs', required: true },
    { path: 'contracts', required: true },
    { path: 'dist/native', required: false },
    { path: 'LICENSE', required: true },
    { path: 'package.json', required: true },
  ];
  const files: RuntimeInstalledFileV4[] = [];
  let total = 0;
  async function visit(absolute: string): Promise<void> {
    const metadata = await lstat(absolute).catch(() =>
      invalid(`required bundle path is unavailable: ${portable(relative(root, absolute))}`),
    );
    if (metadata.isSymbolicLink()) invalid(`bundle contains a symbolic link: ${portable(relative(root, absolute))}`);
    if (metadata.isDirectory()) {
      const names = (await readdir(absolute)).sort();
      for (const name of names) await visit(join(absolute, name));
      return;
    }
    if (!metadata.isFile()) invalid('bundle contains a non-regular entry');
    const path = portable(relative(root, absolute));
    const hashed = await fileHash(absolute);
    total += hashed.size;
    files.push(Object.freeze({ path, ...hashed }));
    if (files.length > maxFiles || total > maxBytes) invalid('bundle exceeds installation limits');
  }
  for (const value of selected) {
    const absolute = join(root, ...value.path.split('/'));
    if (
      !value.required &&
      (await lstat(absolute).then(
        () => false,
        () => true,
      ))
    )
      continue;
    await visit(absolute);
  }
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

export async function installRuntimeHostV4(input: {
  sourceRoot: string;
  hostRoot: string;
  hostDriver?: string;
  hostComponentsManifest?: string;
  installedAt: string;
}): Promise<RuntimeHostInstallationManifestV4> {
  timestamp(input.installedAt, 'installedAt');
  const sourceRoot = await realpath(resolve(input.sourceRoot)).catch(() => invalid('sourceRoot cannot be canonicalized'));
  await mkdir(resolve(input.hostRoot), { recursive: true, mode: 0o700 });
  const hostRoot = await realpath(resolve(input.hostRoot)).catch(() => invalid('hostRoot cannot be canonicalized'));
  if (within(sourceRoot, hostRoot) || within(hostRoot, sourceRoot)) invalid('hostRoot and sourceRoot must not overlap');
  const packageManifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageManifest.version !== 'string' || !idPattern.test(packageManifest.version)) invalid('package version is invalid');
  const sourceBundleFiles = await sourceFiles(sourceRoot);
  const configuredHostDriver = input.hostDriver;
  const configuredHostComponents = input.hostComponentsManifest;
  if ((configuredHostDriver === undefined) !== (configuredHostComponents === undefined))
    invalid('host driver and component manifest must be supplied together');
  const hostDriverSource =
    configuredHostDriver === undefined
      ? null
      : await (async () => {
          const configuredPath = resolve(configuredHostDriver);
          const configuredMetadata = await lstat(configuredPath).catch(() => invalid('host driver cannot be canonicalized'));
          if (!configuredMetadata.isFile() || configuredMetadata.isSymbolicLink())
            invalid('host driver must be a regular non-symbolic file');
          if (configuredMetadata.size > maxBytes) invalid('host driver exceeds installation limits');
          await rejectWindowsPathLinks(configuredPath, 'host driver source path contains a symbolic link or reparse point');
          const path = await realpath(configuredPath).catch(() => invalid('host driver cannot be canonicalized'));
          if (path !== configuredPath && process.platform !== 'win32') invalid('host driver source path contains a symbolic link or alias');
          const metadata = await lstat(path);
          if (!metadata.isFile() || metadata.isSymbolicLink()) invalid('host driver must be a regular non-symbolic file');
          return Object.freeze({ path, ...(await fileHash(path)) });
        })();
  const hostComponentSources =
    configuredHostComponents === undefined
      ? null
      : await (async () => {
          const configuredPath = resolve(configuredHostComponents);
          const configuredMetadata = await lstat(configuredPath).catch(() => invalid('host component manifest cannot be canonicalized'));
          if (!configuredMetadata.isFile() || configuredMetadata.isSymbolicLink())
            invalid('host component manifest must be a regular non-symbolic file');
          if (configuredMetadata.size > maxHostComponentManifestBytes) invalid('host component manifest exceeds installation limits');
          await rejectWindowsPathLinks(configuredPath, 'host component manifest path contains a symbolic link or reparse point');
          const manifestPath = await realpath(configuredPath).catch(() => invalid('host component manifest cannot be canonicalized'));
          if (manifestPath !== configuredPath && process.platform !== 'win32')
            invalid('host component manifest path contains a symbolic link or alias');
          const sourceManifest = loadRuntimeHostComponentSourceManifestV4(JSON.parse(await readFile(manifestPath, 'utf8')));
          if (hostDriverSource === null || sourceManifest.driverSha256 !== hostDriverSource.sha256)
            invalid('host composition does not bind the selected root driver');
          const manifestRoot = dirname(manifestPath);
          const modules: Array<{
            readonly id: string;
            readonly sourcePath: string;
            readonly installedPath: string;
            readonly sha256: string;
            readonly size: number;
          }> = [];
          let selectedBytes = sourceBundleFiles.reduce((total, file) => total + file.size, hostDriverSource.size);
          for (const component of sourceManifest.components) {
            const requestedPath = resolve(manifestRoot, ...component.modulePath.split('/'));
            const configuredModuleMetadata = await lstat(requestedPath).catch(() =>
              invalid(`host component ${component.id} is unavailable`),
            );
            if (!configuredModuleMetadata.isFile() || configuredModuleMetadata.isSymbolicLink())
              invalid(`host component ${component.id} must be a regular non-symbolic file`);
            await rejectWindowsPathLinks(requestedPath, `host component ${component.id} contains a symbolic link or reparse point`);
            selectedBytes += configuredModuleMetadata.size;
            if (configuredModuleMetadata.size > maxBytes || selectedBytes > maxBytes) invalid('bundle exceeds installation limits');
            const path = await realpath(requestedPath).catch(() => invalid(`host component ${component.id} cannot be canonicalized`));
            if ((path !== requestedPath && process.platform !== 'win32') || !within(manifestRoot, path))
              invalid(`host component ${component.id} escaped its source root`);
            const hashed = await fileHash(path);
            if (hashed.sha256 !== component.moduleSha256) invalid(`host component ${component.id} artifact drifted from its certification`);
            modules.push(
              Object.freeze({ id: component.id, sourcePath: path, installedPath: `host-components/${component.id}.mjs`, ...hashed }),
            );
          }
          return Object.freeze({ sourceManifest, modules: Object.freeze(modules) });
        })();
  const files = Object.freeze(
    [
      ...sourceBundleFiles,
      ...(hostDriverSource === null
        ? []
        : [Object.freeze({ path: 'host-driver.mjs', sha256: hostDriverSource.sha256, size: hostDriverSource.size })]),
      ...(hostComponentSources === null
        ? []
        : hostComponentSources.modules.map((module) =>
            Object.freeze({ path: module.installedPath, sha256: module.sha256, size: module.size }),
          )),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  );
  if (files.length > maxFiles || files.reduce((total, file) => total + file.size, 0) > maxBytes)
    invalid('bundle exceeds installation limits');
  const bundleHash = hashCanonicalV4({
    files,
    hostCompositionCertificationHash: hostComponentSources?.sourceManifest.compositionCertificationHash ?? null,
  });
  const installationId = `${packageManifest.version}-${bundleHash.slice(0, 16)}`;
  const installationRoot = join(hostRoot, 'installations', installationId);
  const hostDriver =
    hostDriverSource === null ? null : Object.freeze({ path: join(installationRoot, 'host-driver.mjs'), sha256: hostDriverSource.sha256 });
  const hostComposition =
    hostComponentSources === null || hostDriverSource === null
      ? null
      : bindRuntimeHostCompositionV4(hostComponentSources.sourceManifest, installationRoot, hostDriverSource.sha256);
  const draft = {
    schemaVersion: 4 as const,
    installationId,
    packageVersion: packageManifest.version,
    root: installationRoot,
    entrypoint: join(installationRoot, 'dist', 'host', 'agent-orchestration.mjs'),
    hostDriver,
    hostComposition,
    installedAt: input.installedAt,
    files,
  };
  const manifest = Object.freeze({ ...draft, installationHash: hashCanonicalV4(draft) });
  const manifestPath = join(installationRoot, 'installation-v4.json');
  const existing = await readFile(manifestPath, 'utf8').catch(() => null);
  if (existing !== null) {
    const loaded = loadRuntimeHostInstallationV4(JSON.parse(existing));
    const stable = (value: RuntimeHostInstallationManifestV4) => ({
      installationId: value.installationId,
      packageVersion: value.packageVersion,
      root: value.root,
      entrypoint: value.entrypoint,
      hostDriver: value.hostDriver,
      hostComposition: value.hostComposition,
      files: value.files,
    });
    if (canonicalJsonV4(stable(loaded)) !== canonicalJsonV4(stable(manifest)))
      invalid('installation id already exists with different bytes');
    await verifyRuntimeHostInstallationV4(loaded);
    return loaded;
  }
  const temporary = `${installationRoot}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: false, mode: 0o700 });
  try {
    const componentSourceByInstalledPath = new Map<string, string>(
      hostComponentSources?.modules.map((module) => [module.installedPath, module.sourcePath]),
    );
    for (const file of files) {
      const target = join(temporary, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const source =
        file.path === 'host-driver.mjs' && hostDriverSource !== null
          ? hostDriverSource.path
          : (componentSourceByInstalledPath.get(file.path) ?? join(sourceRoot, ...file.path.split('/')));
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      const copied = await fileHash(target);
      if (copied.sha256 !== file.sha256 || copied.size !== file.size) invalid(`source changed while installing: ${file.path}`);
    }
    await writeFile(join(temporary, 'installation-v4.json'), `${canonicalJsonV4(manifest)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    await mkdir(dirname(installationRoot), { recursive: true, mode: 0o700 });
    await rename(temporary, installationRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export function loadRuntimeHostInstallationV4(value: unknown): RuntimeHostInstallationManifestV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('installation manifest is not an object');
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(',');
  if (
    keys !==
    [
      'entrypoint',
      'files',
      'hostComposition',
      'hostDriver',
      'installationHash',
      'installationId',
      'installedAt',
      'packageVersion',
      'root',
      'schemaVersion',
    ]
      .sort()
      .join(',')
  )
    invalid('installation manifest has unknown or missing fields');
  if (
    item.schemaVersion !== 4 ||
    typeof item.installationId !== 'string' ||
    !idPattern.test(item.installationId) ||
    typeof item.packageVersion !== 'string' ||
    !idPattern.test(item.packageVersion)
  )
    invalid('installation identity is invalid');
  if (
    typeof item.root !== 'string' ||
    !isAbsolute(item.root) ||
    basename(item.root) !== item.installationId ||
    typeof item.entrypoint !== 'string' ||
    item.entrypoint !== join(item.root, 'dist', 'host', 'agent-orchestration.mjs')
  )
    invalid('installation paths are invalid');
  if (typeof item.installedAt !== 'string') invalid('installedAt is invalid');
  timestamp(item.installedAt, 'installedAt');
  if (!Array.isArray(item.files) || item.files.length < 1 || item.files.length > maxFiles) invalid('installation file list is invalid');
  const files = item.files.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('installed file is invalid');
    const file = raw as Record<string, unknown>;
    if (
      Object.keys(file).sort().join(',') !== 'path,sha256,size' ||
      typeof file.path !== 'string' ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(file.path) ||
      file.path.split('/').some((part) => part === '.' || part === '..') ||
      !hashPattern.test(String(file.sha256)) ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0
    )
      invalid('installed file is invalid');
    return Object.freeze({ path: file.path, sha256: String(file.sha256), size: Number(file.size) });
  });
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)
  )
    invalid('installation file list is duplicated or unsorted');
  if (
    !files.some((file) => file.path === 'dist/host/agent-orchestration.mjs') ||
    !files.some((file) => file.path === 'package.json') ||
    !files.some((file) => file.path === 'LICENSE')
  )
    invalid('installation file list is incomplete');
  const hostDriver =
    item.hostDriver === null
      ? null
      : (() => {
          if (typeof item.hostDriver !== 'object' || Array.isArray(item.hostDriver)) invalid('host driver binding is invalid');
          const driver = item.hostDriver as Record<string, unknown>;
          if (
            Object.keys(driver).sort().join(',') !== 'path,sha256' ||
            driver.path !== join(String(item.root), 'host-driver.mjs') ||
            !hashPattern.test(String(driver.sha256)) ||
            !files.some((file) => file.path === 'host-driver.mjs' && file.sha256 === driver.sha256)
          )
            invalid('host driver binding is invalid');
          return Object.freeze({ path: driver.path, sha256: String(driver.sha256) });
        })();
  if ((hostDriver === null) !== (item.hostComposition === null)) invalid('host driver and composition binding must be present together');
  const hostComposition =
    hostDriver === null ? null : loadRuntimeHostCompositionBindingV4(item.hostComposition, String(item.root), hostDriver.sha256);
  const componentFiles = files.filter((file) => file.path.startsWith('host-components/'));
  if (hostComposition === null) {
    if (files.some((file) => file.path === 'host-driver.mjs') || componentFiles.length > 0)
      invalid('installation contains unbound host code');
  } else if (
    hostComposition.components.length !== componentFiles.length ||
    hostComposition.components.some((component) => {
      const relativePath = portable(relative(String(item.root), component.path));
      return !componentFiles.some((file) => file.path === relativePath && file.sha256 === component.sha256);
    })
  )
    invalid('host component files do not match the certified composition');
  const identityHash = hashCanonicalV4({
    files,
    hostCompositionCertificationHash: hostComposition?.compositionCertificationHash ?? null,
  });
  if (item.installationId !== `${item.packageVersion}-${identityHash.slice(0, 16)}`)
    invalid('installation identity does not match its files and host composition');
  const draft = {
    schemaVersion: 4 as const,
    installationId: item.installationId,
    packageVersion: item.packageVersion,
    root: item.root,
    entrypoint: item.entrypoint,
    hostDriver,
    hostComposition,
    installedAt: item.installedAt,
    files: Object.freeze(files),
  };
  if (!hashPattern.test(String(item.installationHash)) || hashCanonicalV4(draft) !== item.installationHash)
    invalid('installation hash is invalid');
  return Object.freeze({ ...draft, installationHash: String(item.installationHash) }) as RuntimeHostInstallationManifestV4;
}

export async function verifyRuntimeHostInstallationV4(manifestInput: RuntimeHostInstallationManifestV4): Promise<string> {
  const manifest = loadRuntimeHostInstallationV4(structuredClone(manifestInput));
  const rootMetadata = await lstat(manifest.root).catch(() => invalid('installation root is unavailable'));
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (await realpath(manifest.root)) !== manifest.root)
    invalid('installation root is unsafe');
  for (const file of manifest.files) {
    const path = join(manifest.root, ...file.path.split('/'));
    const metadata = await lstat(path).catch(() => invalid(`installed file is missing: ${file.path}`));
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalid(`installed file is unsafe: ${file.path}`);
    const actual = await fileHash(path);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) invalid(`installed file drifted: ${file.path}`);
  }
  if (
    manifest.hostDriver !== null &&
    (await fileHash(manifest.hostDriver.path).catch(() => invalid('host driver is unavailable'))).sha256 !== manifest.hostDriver.sha256
  )
    invalid('host driver drifted');
  return manifest.installationHash;
}

async function loadYaml(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, 'utf8'));
}
async function canonicalGitRoot(path: string): Promise<string> {
  const root = await realpath(resolve(path)).catch(() => invalid('repository root cannot be canonicalized'));
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) invalid('repository root is not a Git worktree');
  const discovered = await realpath(result.stdout.trim()).catch(() => invalid('Git root cannot be canonicalized'));
  if (discovered !== root) invalid('repositoryRoot must be the Git worktree root');
  return root;
}

export async function activateRuntimeRepositoryV4(input: {
  repositoryRoot: string;
  policyPath: string;
  profilePath: string;
  worktreeParent: string;
  installationManifest: string;
  hostRoot: string;
  target: RuntimeActivationTargetV4;
  activatedAt: string;
}): Promise<RuntimeRepositoryActivationV4> {
  timestamp(input.activatedAt, 'activatedAt');
  if (!['ANALYSIS_ONLY', 'ISOLATED_EXECUTION', 'AUTONOMOUS_PUBLICATION'].includes(input.target)) invalid('activation target is invalid');
  const repositoryRoot = await canonicalGitRoot(input.repositoryRoot);
  const policyPath = await realpath(resolve(input.policyPath)).catch(() => invalid('policy cannot be canonicalized'));
  const profilePath = await realpath(resolve(input.profilePath)).catch(() => invalid('profile cannot be canonicalized'));
  const policy = loadRuntimeRepositoryPolicyV4(await loadYaml(policyPath));
  const profile = loadRuntimeProfileV4(await loadYaml(profilePath));
  const worktreeParent = await realpath(resolve(input.worktreeParent)).catch(() => invalid('worktree parent cannot be canonicalized'));
  if (within(repositoryRoot, worktreeParent) || within(worktreeParent, repositoryRoot))
    invalid('worktree parent must be outside the repository tree');
  const manifestPath = await realpath(resolve(input.installationManifest)).catch(() =>
    invalid('installation manifest cannot be canonicalized'),
  );
  const installation = loadRuntimeHostInstallationV4(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (manifestPath !== join(installation.root, 'installation-v4.json')) invalid('installation manifest is outside its installation root');
  await verifyRuntimeHostInstallationV4(installation);
  const hostRoot = await realpath(resolve(input.hostRoot)).catch(() => invalid('hostRoot cannot be canonicalized'));
  if (!within(hostRoot, installation.root)) invalid('installation is outside hostRoot');
  const stateDirectory = join(hostRoot, 'state', policy.repositoryId);
  const draft = {
    schemaVersion: 4 as const,
    repositoryId: policy.repositoryId,
    repositoryRoot,
    policyPath,
    policyHash: hashCanonicalV4(policy),
    profilePath,
    profileHash: hashCanonicalV4(profile),
    worktreeParent,
    stateDirectory,
    installationManifest: manifestPath,
    installationHash: installation.installationHash,
    hostCompositionHash: installation.hostComposition?.compositionCertificationHash ?? null,
    target: input.target,
    activatedAt: input.activatedAt,
  };
  let activation = Object.freeze({ ...draft, activationHash: hashCanonicalV4(draft) });
  const activationPath = join(repositoryRoot, '.agent-orchestration', 'activation-v4.json');
  const codexPath = join(repositoryRoot, '.codex', 'config.toml');
  const reasoningEffort = profile.bindings.orchestrator.guidance.reasoningEffort;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort))
    invalid('orchestrator guidance is not compatible with Codex project activation');
  const codex = renderCodexProjectConfig({
    frontier_model: profile.bindings.orchestrator.model,
    reasoning_effort: reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    runtime_entrypoint: installation.entrypoint,
    activation_manifest: activationPath,
  });
  const priorCodex = await readFile(codexPath, 'utf8').catch(() => null);
  if (priorCodex !== null && priorCodex !== codex.content)
    invalid(`existing ${portable(relative(repositoryRoot, codexPath))} is unmanaged; merge the generated MCP block manually`);
  const existing = await readFile(activationPath, 'utf8').catch(() => null);
  if (existing !== null) {
    const loaded = loadRuntimeRepositoryActivationV4(JSON.parse(existing));
    const stable = (value: RuntimeRepositoryActivationV4) => ({
      repositoryId: value.repositoryId,
      repositoryRoot: value.repositoryRoot,
      policyPath: value.policyPath,
      policyHash: value.policyHash,
      profilePath: value.profilePath,
      profileHash: value.profileHash,
      worktreeParent: value.worktreeParent,
      stateDirectory: value.stateDirectory,
      installationManifest: value.installationManifest,
      installationHash: value.installationHash,
      hostCompositionHash: value.hostCompositionHash,
      target: value.target,
    });
    if (canonicalJsonV4(stable(loaded)) !== canonicalJsonV4(stable(activation)))
      invalid('repository already has a different activation manifest');
    activation = loaded;
  }
  if (existing === null) await atomicJson(activationPath, activation);
  const registryPath = join(hostRoot, 'repository-registry-v4.json');
  const registryLockPath = `${registryPath}.lock`;
  const registryLock = await open(registryLockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') invalid('repository registry is busy');
    throw error;
  });
  try {
    let registryValue: unknown = {};
    try {
      registryValue = JSON.parse(await readFile(registryPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid('repository registry cannot be read');
    }
    if (
      registryValue === null ||
      typeof registryValue !== 'object' ||
      Array.isArray(registryValue) ||
      Object.values(registryValue).some((value) => typeof value !== 'string' || !isAbsolute(value))
    )
      invalid('repository registry is invalid');
    const registry = new Map(Object.entries(registryValue as Record<string, string>));
    if (registry.has(policy.repositoryId) && registry.get(policy.repositoryId) !== activationPath)
      invalid('repository id is already registered to another activation');
    registry.set(policy.repositoryId, activationPath);
    await atomicJson(registryPath, Object.fromEntries([...registry.entries()].sort(([a], [b]) => a.localeCompare(b))));
  } finally {
    await registryLock.close().catch(() => undefined);
    await rm(registryLockPath, { force: true }).catch(() => undefined);
  }
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if (priorCodex === null) {
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, codex.content, { flag: 'wx', mode: 0o600 });
  }
  return activation;
}

export function activationManifestPathV4(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), '.agent-orchestration', 'activation-v4.json');
}
