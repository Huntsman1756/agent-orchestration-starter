import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(projectRoot, 'native', 'linux', 'renameat2-helper.c');
const outputDirectory = join(projectRoot, 'dist', 'native', `linux-${process.arch}`);
const helperPath = join(outputDirectory, 'agent-orchestration-renameat2');
const manifestPath = `${helperPath}.manifest.json`;
const compilerPath = '/usr/bin/cc';

if (process.platform !== 'linux') process.exit(0);

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  helper_name: 'agent-orchestration-renameat2',
  platform: 'linux',
  protocol: 'linux-renameat2-noreplace-v1',
  schema_version: 1,
  source_sha256: digest(normalizedSourceBytes),
};
await writeFile(temporaryManifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o444, flag: 'wx' });
await chmod(temporaryManifestPath, 0o444);
await rename(temporaryHelperPath, helperPath);
await rename(temporaryManifestPath, manifestPath);
