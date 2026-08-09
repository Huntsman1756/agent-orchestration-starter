import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

interface ProcessResultForTest {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runForPackageTest(
  executable: string,
  args: readonly string[],
  cwd = process.cwd(),
): Promise<ProcessResultForTest> {
  return new Promise<ProcessResultForTest>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
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

async function createDisposablePackageProjectForTest(container: string): Promise<string> {
  const project = join(container, 'project');
  await mkdir(join(project, 'scripts'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await copyFile(join(process.cwd(), 'package.json'), join(project, 'package.json'));
  await copyFile(join(process.cwd(), 'tsconfig.json'), join(project, 'tsconfig.json'));
  await copyFile(
    join(process.cwd(), 'scripts', 'build-linux-native-helper.mjs'),
    join(project, 'scripts', 'build-linux-native-helper.mjs'),
  );
  return project;
}

test('prepack cleans stale native output before a real TypeScript compilation failure', {
  skip: process.env.AO_NATIVE_PACKAGE_TEST !== '1',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'runner-v4-prepack-order-'));
  const packageDirectory = join(fixtureRoot, 'packed');
  try {
    const project = await createDisposablePackageProjectForTest(fixtureRoot);
    const staleNativeRoot = join(project, 'dist', 'native');
    const staleHelper = join(staleNativeRoot, 'linux-foreign', 'stale-helper');
    await mkdir(join(staleNativeRoot, 'linux-foreign'), { recursive: true });
    await writeFile(staleHelper, 'stale native output\n');
    await writeFile(
      join(project, 'src', 'forced-compilation-error.ts'),
      'const mustBeNumber: number = "not a number";\nexport { mustBeNumber };\n',
    );
    await mkdir(packageDirectory);

    const command = npmPackCommandForTest(['--pack-destination', packageDirectory]);
    const packed = await runForPackageTest(command.executable, command.args, project);
    assert.notEqual(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /TS2322/);
    await assert.rejects(() => lstat(staleNativeRoot), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.deepEqual((await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz')), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('clean-only refuses a bind-mounted native root without traversing external contents', {
  skip: process.platform !== 'linux' || process.env.AO_PRIVILEGED_BIND_MOUNT_TEST !== '1',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'runner-v4-native-bind-clean-'));
  const externalNative = join(fixtureRoot, 'external-native');
  const marker = join(externalNative, 'external-marker.txt');
  let mounted = false;
  try {
    const project = await createDisposablePackageProjectForTest(fixtureRoot);
    const nativeRoot = join(project, 'dist', 'native');
    await mkdir(nativeRoot, { recursive: true });
    await mkdir(externalNative);
    await writeFile(marker, 'external marker must survive\n');
    const markerBefore = await lstat(marker);
    const mountedResult = await runForPackageTest('/usr/bin/mount', ['--bind', externalNative, nativeRoot], project);
    assert.equal(mountedResult.code, 0, mountedResult.stderr);
    mounted = true;

    const cleaned = await runForPackageTest(
      process.execPath,
      [join(project, 'scripts', 'build-linux-native-helper.mjs'), '--clean-only'],
      project,
    );
    assert.notEqual(cleaned.code, 0, `${cleaned.stdout}\n${cleaned.stderr}`);
    assert.match(`${cleaned.stdout}\n${cleaned.stderr}`, /EBUSY|resource busy/i);
    const markerAfter = await lstat(marker);
    assert.equal(markerAfter.dev, markerBefore.dev);
    assert.equal(markerAfter.ino, markerBefore.ino);
    assert.equal(await readFile(marker, 'utf8'), 'external marker must survive\n');
  } finally {
    if (mounted) {
      const unmounted = await runForPackageTest('/usr/bin/umount', [join(fixtureRoot, 'project', 'dist', 'native')]);
      if (unmounted.code !== 0) throw new Error(`privileged test unmount failed: ${unmounted.stderr}`);
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

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
