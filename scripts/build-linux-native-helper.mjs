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
const legacyCleanupHolderNamePattern = /^\.native-clean-[A-Za-z0-9]{6}$/;
const argumentsAfterScript = process.argv.slice(2);
if (
  argumentsAfterScript.length > 1 ||
  argumentsAfterScript.some((argument) => argument !== '--for-package' && argument !== '--clean-only')
) {
  throw new Error('Unknown native helper build argument');
}
const forPackage = argumentsAfterScript.includes('--for-package');
const cleanOnly = argumentsAfterScript.includes('--clean-only');
let cleanupBarrierUsedForTests = false;

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

function requireSameObjectIdentity(actualMetadata, expectedMetadata) {
  if (actualMetadata.dev !== expectedMetadata.dev || actualMetadata.ino !== expectedMetadata.ino) {
    throw new Error('Native cleanup object identity changed');
  }
}

async function createCleanupNamespace() {
  const projectMetadata = requirePhysicalDirectory(await loadMetadataOrNull(projectRoot));
  if ((await loadMetadataOrNull(cleanupNamespace)) !== null) {
    throw new Error('Inherited native cleanup state requires offline remediation');
  }
  await mkdir(cleanupNamespace, { mode: 0o700 });
  const cleanupMetadata = requirePhysicalDirectory(await loadMetadataOrNull(cleanupNamespace));
  requireSameFilesystem(projectMetadata, cleanupMetadata);
  return cleanupMetadata;
}

async function reproveCleanupNamespace(cleanupMetadata) {
  const reproved = requirePhysicalDirectory(await loadMetadataOrNull(cleanupNamespace));
  requireSameObjectIdentity(reproved, cleanupMetadata);
  return reproved;
}

async function waitAtCleanupBarrierForTests() {
  const barrier = process.env.AO_NATIVE_CLEANUP_BARRIER_FOR_TESTS;
  if (process.env.AO_NATIVE_PACKAGE_TEST !== '1' || typeof barrier !== 'string' || barrier.length === 0 || cleanupBarrierUsedForTests)
    return;
  cleanupBarrierUsedForTests = true;
  await writeFile(`${barrier}.ready`, 'ready\n', { flag: 'wx' });
  const deadline = Date.now() + 10_000;
  while ((await loadMetadataOrNull(`${barrier}.release`)) === null) {
    if (Date.now() >= deadline) throw new Error('Native cleanup test barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function validateCleanupHolder(path, allowedChild, cleanupMetadata) {
  const metadata = requirePhysicalDirectory(await loadMetadataOrNull(path));
  requireSameFilesystem(metadata, cleanupMetadata);
  const entries = (await readdir(path)).sort();
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== allowedChild)) {
    throw new Error('Native cleanup holder inventory is invalid');
  }
  if (entries.length === 1) {
    const childMetadata = requirePhysicalDirectory(await loadMetadataOrNull(join(path, allowedChild)));
    requireSameFilesystem(childMetadata, cleanupMetadata);
  }
  return metadata;
}

async function validateMovedSource(path, sourceMetadata, cleanupMetadata, allowedChild) {
  const movedMetadata =
    allowedChild === null
      ? requirePhysicalDirectory(await loadMetadataOrNull(path))
      : await validateCleanupHolder(path, allowedChild, cleanupMetadata);
  requireSameObjectIdentity(movedMetadata, sourceMetadata);
  return movedMetadata;
}

async function detachAndRemove(source, sourceMetadata, cleanupMetadata, allowedChild) {
  requireSameFilesystem(sourceMetadata, cleanupMetadata);
  await reproveCleanupNamespace(cleanupMetadata);
  const reaper = await mkdtemp(join(cleanupNamespace, 'holder-'));
  const reaperMetadata = requirePhysicalDirectory(await loadMetadataOrNull(reaper));
  requireSameFilesystem(reaperMetadata, cleanupMetadata);
  await reproveCleanupNamespace(cleanupMetadata);
  await waitAtCleanupBarrierForTests();
  await reproveCleanupNamespace(cleanupMetadata);
  const moved = join(reaper, 'detached');
  await rename(source, moved);
  await validateMovedSource(moved, sourceMetadata, cleanupMetadata, allowedChild);
  await reproveCleanupNamespace(cleanupMetadata);
  const reprovedReaper = requirePhysicalDirectory(await loadMetadataOrNull(reaper));
  requireSameObjectIdentity(reprovedReaper, reaperMetadata);
  await validateMovedSource(moved, sourceMetadata, cleanupMetadata, allowedChild);
  await rm(reaper, { recursive: true, force: true });
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
    await detachAndRemove(path, metadata, cleanupMetadata, 'native');
  }
}

async function cleanNativeRoot() {
  const cleanupMetadata = await createCleanupNamespace();
  await auditLegacyCleanupHolders(cleanupMetadata);

  const nativeMetadata = await loadMetadataOrNull(nativeRoot);
  if (nativeMetadata !== null) {
    requirePhysicalDirectory(nativeMetadata);
    await detachAndRemove(nativeRoot, nativeMetadata, cleanupMetadata, null);
  }

  await reproveCleanupNamespace(cleanupMetadata);
  if ((await readdir(cleanupNamespace)).length !== 0) {
    throw new Error('Native cleanup namespace changed during cleanup');
  }
  await reproveCleanupNamespace(cleanupMetadata);
  await rmdir(cleanupNamespace);
}

async function verifyExactInventory(outputDirectory, helperPath, manifestPath) {
  const packableCleanupEntries = (await readdir(distRoot)).filter((name) => name.startsWith('.native-clean-'));
  if (packableCleanupEntries.length !== 0 || (await loadMetadataOrNull(cleanupNamespace)) !== null) {
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
    !helperMetadata.isFile() ||
    helperMetadata.nlink !== 1n ||
    (helperMetadata.mode & 0o777n) !== 0o555n ||
    !manifestMetadata.isFile() ||
    manifestMetadata.nlink !== 1n ||
    (manifestMetadata.mode & 0o777n) !== 0o444n
  )
    throw new Error('Linux native helper inventory verification failed');
}

async function buildLinuxNativeHelper() {
  await cleanNativeRoot();
  if (cleanOnly) return;
  const target = `${process.platform}-${process.arch}`;
  if (!supportedTargets.has(target)) {
    if (forPackage || process.platform === 'linux') {
      throw new Error(
        `Unsupported native package target: ${target}. Release tarballs are built only on certified linux-x64; ` +
          'Windows and macOS cannot manufacture the Linux native broker artifact.',
      );
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
