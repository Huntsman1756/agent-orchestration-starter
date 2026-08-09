import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

interface ProcessResultForTest {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runForPackageTest(executable: string, args: readonly string[]): Promise<ProcessResultForTest> {
  return new Promise<ProcessResultForTest>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function npmPackCommandForTest(args: readonly string[]): { executable: string; args: readonly string[] } {
  const npmCli = process.env.npm_execpath;
  if (typeof npmCli !== 'string') throw new Error('npm_execpath must identify the npm CLI under the test runner');
  return { executable: process.execPath, args: [npmCli, 'pack', ...args] };
}

test('prepack fails closed on an unsupported build platform', {
  skip: process.env.AO_NATIVE_PACKAGE_TEST !== '1' || process.platform === 'linux',
}, async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-native-package-'));
  try {
    const command = npmPackCommandForTest([
      '--json',
      '--pack-destination',
      packageDirectory,
    ]);
    const packed = await runForPackageTest(command.executable, command.args);
    assert.notEqual(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /unsupported native package target/i);
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test('Linux prepack cleans a foreign architecture helper and emits the exact native tarball inventory', {
  skip: process.env.AO_NATIVE_PACKAGE_TEST !== '1' || process.platform !== 'linux',
}, async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-native-package-'));
  const foreignArchitecture = process.arch === 'x64' ? 'arm64' : 'x64';
  const foreignDirectory = join(process.cwd(), 'dist', 'native', `linux-${foreignArchitecture}`);
  const foreignHelper = join(foreignDirectory, 'agent-orchestration-renameat2');
  const foreignManifest = `${foreignHelper}.manifest.json`;
  try {
    await mkdir(foreignDirectory, { recursive: true });
    await writeFile(foreignHelper, 'foreign architecture helper', { mode: 0o755 });
    await writeFile(foreignManifest, '{"foreign":true}\n', { mode: 0o644 });

    const command = npmPackCommandForTest([
      '--json',
      '--pack-destination',
      packageDirectory,
    ]);
    const packed = await runForPackageTest(command.executable, command.args);
    assert.equal(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    const results = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    assert.equal(results.length, 1);
    const tarballPath = join(packageDirectory, results[0]!.filename);
    const listed = await runForPackageTest('/usr/bin/tar', ['-tzf', tarballPath]);
    assert.equal(listed.code, 0, listed.stderr);
    const nativeEntries = listed.stdout
      .split('\n')
      .filter((entry) => entry.includes('/dist/native/'))
      .sort();
    assert.deepEqual(nativeEntries, [
      `package/dist/native/linux-${process.arch}/agent-orchestration-renameat2`,
      `package/dist/native/linux-${process.arch}/agent-orchestration-renameat2.manifest.json`,
    ]);
    assert.equal(listed.stdout.includes(`linux-${foreignArchitecture}`), false);
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
    await rm(foreignDirectory, { recursive: true, force: true });
  }
});
