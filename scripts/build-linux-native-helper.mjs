import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(projectRoot, 'native', 'linux', 'renameat2-helper.c');
const distRoot = join(projectRoot, 'dist');
const nativeRoot = join(distRoot, 'native');
const cleanupNamespace = join(projectRoot, '.agent-orchestration-native-clean');
const compilerPath = '/usr/bin/cc';
const helperName = 'agent-orchestration-renameat2';
const supportedTargets = new Set(['linux-x64']);
const cleanupHolderNamePattern = /^holder-[A-Za-z0-9]{6}$/;
const legacyCleanupHolderNamePattern = /^\.native-clean-[A-Za-z0-9]{6}$/;
const argumentsAfterScript = process.argv.slice(2);
if (
  argumentsAfterScript.length > 1
  || argumentsAfterScript.some((argument) => argument !== '--for-package' && argument !== '--clean-only')
) {
  throw new Error('Unknown native helper build argument');
}
const forPackage = argumentsAfterScript.includes('--for-package');
const cleanOnly = argumentsAfterScript.includes('--clean-only');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function loadMetadataOrNull(path) {
  return lstat(path, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function requirePhysicalDirectory(metadata) {
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Native cleanup path is not a physical directory');
  }
  return metadata;
}

function requireSameFilesystem(sourceMetadata, cleanupMetadata) {
  if (sourceMetadata.dev !== cleanupMetadata.dev) {
    throw new Error('Native cleanup requires a same-filesystem rename');
  }
}

async function createCleanupNamespace() {
  const projectMetadata = requirePhysicalDirectory(await loadMetadataOrNull(projectRoot));
  await mkdir(cleanupNamespace, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const cleanupMetadata = requirePhysicalDirectory(await loadMetadataOrNull(cleanupNamespace));
  requireSameFilesystem(projectMetadata, cleanupMetadata);
  return cleanupMetadata;
}

async function validateCleanupHolder(path, allowedChild, cleanupMetadata) {
  const metadata = requirePhysicalDirectory(await loadMetadataOrNull(path));
  requireSameFilesystem(metadata, cleanupMetadata);
  const entries = (await readdir(path)).sort();
  if (entries.length > 1 || entries.length === 1 && entries[0] !== allowedChild) {
    throw new Error('Native cleanup holder inventory is invalid');
  }
  if (entries.length === 1) {
    const childMetadata = requirePhysicalDirectory(await loadMetadataOrNull(join(path, allowedChild)));
    requireSameFilesystem(childMetadata, cleanupMetadata);
  }
  return metadata;
}

async function detachAndRemove(source, sourceMetadata, cleanupMetadata) {
  requireSameFilesystem(sourceMetadata, cleanupMetadata);
  const reaper = await mkdtemp(join(cleanupNamespace, 'holder-'));
  try {
    await rename(source, join(reaper, 'detached'));
  } catch (error) {
    await rmdir(reaper).catch(() => undefined);
    throw error;
  }
  await rm(reaper, { recursive: true, force: true });
}

async function auditCurrentCleanupHolders(cleanupMetadata) {
  const names = (await readdir(cleanupNamespace)).sort();
  for (const name of names) {
    if (!cleanupHolderNamePattern.test(name)) {
      throw new Error('Native cleanup holder name is invalid');
    }
    const path = join(cleanupNamespace, name);
    const metadata = await validateCleanupHolder(path, 'detached', cleanupMetadata);
    await detachAndRemove(path, metadata, cleanupMetadata);
  }
  if ((await readdir(cleanupNamespace)).length !== 0) {
    throw new Error('Native cleanup namespace changed during audit');
  }
}

async function auditLegacyCleanupHolders(cleanupMetadata) {
  const distMetadata = await loadMetadataOrNull(distRoot);
  if (distMetadata === null) return;
  requirePhysicalDirectory(distMetadata);
  requireSameFilesystem(distMetadata, cleanupMetadata);
  const names = (await readdir(distRoot)).filter((name) => name.startsWith('.native-clean-')).sort();
  for (const name of names) {
    if (!legacyCleanupHolderNamePattern.test(name)) {
      throw new Error('Legacy native cleanup holder name is invalid');
    }
    const path = join(distRoot, name);
    const metadata = await validateCleanupHolder(path, 'native', cleanupMetadata);
    await detachAndRemove(path, metadata, cleanupMetadata);
  }
}

async function cleanNativeRoot() {
  const cleanupMetadata = await createCleanupNamespace();
  await auditCurrentCleanupHolders(cleanupMetadata);
  await auditLegacyCleanupHolders(cleanupMetadata);

  const nativeMetadata = await loadMetadataOrNull(nativeRoot);
  if (nativeMetadata !== null) {
    requirePhysicalDirectory(nativeMetadata);
    await detachAndRemove(nativeRoot, nativeMetadata, cleanupMetadata);
  }

  if ((await readdir(cleanupNamespace)).length !== 0) {
    throw new Error('Native cleanup namespace changed during cleanup');
  }
  await rmdir(cleanupNamespace);
}

async function verifyExactInventory(outputDirectory, helperPath, manifestPath) {
  const packableCleanupEntries = (await readdir(distRoot)).filter((name) => name.startsWith('.native-clean-'));
  if (packableCleanupEntries.length !== 0 || await loadMetadataOrNull(cleanupNamespace) !== null) {
    throw new Error('Linux native helper inventory verification failed');
  }
  const rootEntries = (await readdir(nativeRoot)).sort();
  const expectedDirectory = `linux-${process.arch}`;
  if (rootEntries.length !== 1 || rootEntries[0] !== expectedDirectory) {
    throw new Error('Linux native helper inventory verification failed');
  }
  const outputEntries = (await readdir(outputDirectory)).sort();
  if (outputEntries.length !== 2 || outputEntries[0] !== helperName || outputEntries[1] !== `${helperName}.manifest.json`) {
    throw new Error('Linux native helper inventory verification failed');
  }
  const helperMetadata = await lstat(helperPath, { bigint: true });
  const manifestMetadata = await lstat(manifestPath, { bigint: true });
  if (
    !helperMetadata.isFile()
    || helperMetadata.nlink !== 1n
    || (helperMetadata.mode & 0o777n) !== 0o555n
    || !manifestMetadata.isFile()
    || manifestMetadata.nlink !== 1n
    || (manifestMetadata.mode & 0o777n) !== 0o444n
  ) throw new Error('Linux native helper inventory verification failed');
}

async function buildLinuxNativeHelper() {
  await cleanNativeRoot();
  if (cleanOnly) return;
  const target = `${process.platform}-${process.arch}`;
  if (!supportedTargets.has(target)) {
    if (forPackage || process.platform === 'linux') {
      throw new Error(`Unsupported native package target: ${target}`);
    }
    return;
  }

  const outputDirectory = join(nativeRoot, target);
  const helperPath = join(outputDirectory, helperName);
  const manifestPath = `${helperPath}.manifest.json`;
  const sourceBytes = await readFile(sourcePath);
  const normalizedSourceBytes = Buffer.from(sourceBytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  await chmod(outputDirectory, 0o755);

  const temporaryHelperPath = `${helperPath}.build-${process.pid}`;
  const temporaryManifestPath = `${manifestPath}.build-${process.pid}`;
  await rm(temporaryHelperPath, { force: true });
  await rm(temporaryManifestPath, { force: true });

  const compilerArguments = [
    '-std=c17',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fPIE',
    '-ffile-prefix-map=' + projectRoot + '=.',
    '-Wl,--build-id=none',
    '-Wl,-z,relro',
    '-Wl,-z,now',
    '-Wl,-z,noexecstack',
    '-pie',
    sourcePath,
    '-o',
    temporaryHelperPath,
  ];

  const compiler = spawn(compilerPath, compilerArguments, {
    cwd: '/',
    env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    stdio: 'inherit',
  });
  const compilerResult = await new Promise((resolve, reject) => {
    compiler.once('error', reject);
    compiler.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (compilerResult.code !== 0 || compilerResult.signal !== null) {
    await rm(temporaryHelperPath, { force: true });
    throw new Error('Linux native rename helper build failed');
  }

  await chmod(temporaryHelperPath, 0o555);
  const helperBytes = await readFile(temporaryHelperPath);
  const manifest = {
    architecture: process.arch,
    binary_sha256: digest(helperBytes),
    helper_name: helperName,
    platform: 'linux',
    protocol: 'linux-renameat2-noreplace-v2',
    schema_version: 1,
    source_sha256: digest(normalizedSourceBytes),
  };
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o444, flag: 'wx' });
  await chmod(temporaryManifestPath, 0o444);
  await rename(temporaryHelperPath, helperPath);
  await rename(temporaryManifestPath, manifestPath);
  await verifyExactInventory(outputDirectory, helperPath, manifestPath);
}

await buildLinuxNativeHelper();
