import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(projectRoot, 'native', 'linux', 'renameat2-helper.c');
const nativeRoot = join(projectRoot, 'dist', 'native');
const compilerPath = '/usr/bin/cc';
const helperName = 'agent-orchestration-renameat2';
const supportedTargets = new Set(['linux-x64']);
const argumentsAfterScript = process.argv.slice(2);
if (argumentsAfterScript.some((argument) => argument !== '--for-package')) {
  throw new Error('Unknown native helper build argument');
}
const forPackage = argumentsAfterScript.includes('--for-package');

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function verifyExactInventory(outputDirectory, helperPath, manifestPath) {
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
  await rm(nativeRoot, { recursive: true, force: true });
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
