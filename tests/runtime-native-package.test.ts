import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResultForTest> {
  return new Promise<ProcessResultForTest>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: { ...environment },
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

async function waitForPathForTest(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await lstat(path).catch(() => null) !== null) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for test path: ${path}`);
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
  await mkdir(join(project, 'native', 'linux'), { recursive: true });
  await copyFile(join(process.cwd(), 'package.json'), join(project, 'package.json'));
  const fixturePackagePath = join(project, 'package.json');
  const fixturePackage = JSON.parse(await readFile(fixturePackagePath, 'utf8')) as {
    scripts: Record<string, string>;
  };
  // Keep the production prepack chain, but isolate this native-package fixture
  // from the unrelated host bundle and its complete source/dependency graph.
  fixturePackage.scripts['build:host'] = 'node -e ""';
  await writeFile(fixturePackagePath, `${JSON.stringify(fixturePackage, null, 2)}\n`);
  await copyFile(join(process.cwd(), 'tsconfig.json'), join(project, 'tsconfig.json'));
  await copyFile(
    join(process.cwd(), 'scripts', 'build-linux-native-helper.mjs'),
    join(project, 'scripts', 'build-linux-native-helper.mjs'),
  );
  await copyFile(
    join(process.cwd(), 'native', 'linux', 'renameat2-helper.c'),
    join(project, 'native', 'linux', 'renameat2-helper.c'),
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

test('Linux prepack recovers a legacy cleanup holder within the current invocation', {
  skip: process.platform !== 'linux' || process.env.AO_NATIVE_PACKAGE_TEST !== '1',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'runner-v4-native-interruption-'));
  const packageDirectory = join(fixtureRoot, 'packed');
  try {
    const project = await createDisposablePackageProjectForTest(fixtureRoot);
    const legacyHolder = join(project, 'dist', '.native-clean-ABC123');
    await mkdir(join(legacyHolder, 'native', 'linux-arm64'), { recursive: true });
    await writeFile(join(legacyHolder, 'native', 'linux-arm64', 'foreign-helper'), 'legacy foreign helper\n');
    await writeFile(join(project, 'src', 'index.ts'), 'export const packageFixture = true;\n');
    await mkdir(packageDirectory);
    assert.equal(await lstat(join(project, 'dist', 'native')).catch(() => null), null);

    const command = npmPackCommandForTest(['--json', '--pack-destination', packageDirectory]);
    const packed = await runForPackageTest(command.executable, command.args, project);
    assert.equal(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    const results = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    assert.equal(results.length, 1);
    const listed = await runForPackageTest('/usr/bin/tar', ['-tzf', join(packageDirectory, results[0]!.filename)]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(listed.stdout.includes('.native-clean-'), false);
    assert.equal(listed.stdout.includes('.agent-orchestration-native-clean'), false);
    assert.equal(listed.stdout.includes('foreign-helper'), false);
    await assert.rejects(() => lstat(legacyHolder), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Linux prepack fails closed on an inherited current cleanup holder without changing it', {
  skip: process.platform !== 'linux' || process.env.AO_NATIVE_PACKAGE_TEST !== '1',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'runner-v4-native-inherited-holder-'));
  const packageDirectory = join(fixtureRoot, 'packed');
  try {
    const project = await createDisposablePackageProjectForTest(fixtureRoot);
    const currentHolder = join(project, '.agent-orchestration-native-clean', 'holder-ABC123');
    const currentMarker = join(currentHolder, 'detached', 'linux-arm64', 'foreign-helper');
    await mkdir(join(currentHolder, 'detached', 'linux-arm64'), { recursive: true });
    await writeFile(currentMarker, 'inherited holder requires offline remediation\n');
    await writeFile(join(project, 'src', 'index.ts'), 'export const inheritedHolderFixture = true;\n');
    await mkdir(packageDirectory);
    const holderBefore = await lstat(currentHolder);

    const command = npmPackCommandForTest(['--pack-destination', packageDirectory]);
    const packed = await runForPackageTest(command.executable, command.args, project);
    assert.notEqual(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    assert.deepEqual((await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz')), []);
    const holderAfter = await lstat(currentHolder);
    assert.equal(holderAfter.dev, holderBefore.dev);
    assert.equal(holderAfter.ino, holderBefore.ino);
    assert.equal(await readFile(currentMarker, 'utf8'), 'inherited holder requires offline remediation\n');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Linux prepack retains a same-device holder substitution and emits no tarball', {
  skip: process.platform !== 'linux' || process.env.AO_NATIVE_PACKAGE_TEST !== '1',
}, async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'runner-v4-native-substitution-'));
  const packageDirectory = join(fixtureRoot, 'packed');
  const barrier = join(fixtureRoot, 'cleanup-barrier');
  try {
    const project = await createDisposablePackageProjectForTest(fixtureRoot);
    const legacyHolder = join(project, 'dist', '.native-clean-ABC123');
    const preservedOriginal = join(project, 'dist', 'preserved-original-holder');
    const unrelated = join(project, 'dist', 'unrelated.txt');
    const originalMarker = join(legacyHolder, 'native', 'linux-arm64', 'original-helper');
    await mkdir(join(legacyHolder, 'native', 'linux-arm64'), { recursive: true });
    await writeFile(originalMarker, 'original holder must survive\n');
    await writeFile(unrelated, 'unrelated name must survive\n');
    await writeFile(join(project, 'src', 'index.ts'), 'export const substitutionFixture = true;\n');
    await mkdir(packageDirectory);
    const originalMetadata = await lstat(legacyHolder);
    const unrelatedMetadata = await lstat(unrelated);

    const command = npmPackCommandForTest(['--pack-destination', packageDirectory]);
    const packedPromise = runForPackageTest(command.executable, command.args, project, {
      ...process.env,
      AO_NATIVE_CLEANUP_BARRIER_FOR_TESTS: barrier,
    });
    await waitForPathForTest(`${barrier}.ready`);
    await rename(legacyHolder, preservedOriginal);
    await mkdir(join(legacyHolder, 'native', 'linux-arm64'), { recursive: true });
    const substituteMarker = join(legacyHolder, 'native', 'linux-arm64', 'substitute-helper');
    await writeFile(substituteMarker, 'substitute holder must survive\n');
    const substituteMetadata = await lstat(legacyHolder);
    assert.equal(substituteMetadata.dev, originalMetadata.dev);
    assert.notEqual(substituteMetadata.ino, originalMetadata.ino);
    await writeFile(`${barrier}.release`, 'release\n');

    const packed = await packedPromise;
    assert.notEqual(packed.code, 0, `${packed.stdout}\n${packed.stderr}`);
    assert.deepEqual((await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz')), []);
    const preservedMetadata = await lstat(preservedOriginal);
    assert.equal(preservedMetadata.dev, originalMetadata.dev);
    assert.equal(preservedMetadata.ino, originalMetadata.ino);
    assert.equal(await readFile(join(preservedOriginal, 'native', 'linux-arm64', 'original-helper'), 'utf8'), 'original holder must survive\n');
    assert.equal(await readFile(unrelated, 'utf8'), 'unrelated name must survive\n');
    await assert.rejects(() => lstat(legacyHolder), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

    const cleanupNamespace = join(project, '.agent-orchestration-native-clean');
    const retained = await Promise.all((await readdir(cleanupNamespace)).map(async (name) => {
      const moved = join(cleanupNamespace, name, 'detached');
      const metadata = await lstat(moved).catch(() => null);
      return metadata?.dev === substituteMetadata.dev && metadata.ino === substituteMetadata.ino ? moved : null;
    }));
    const retainedSubstitute = retained.filter((path): path is string => path !== null);
    assert.equal(retainedSubstitute.length, 1);
    assert.equal(
      await readFile(join(retainedSubstitute[0]!, 'native', 'linux-arm64', 'substitute-helper'), 'utf8'),
      'substitute holder must survive\n',
    );

    for (const subsequentRun of [2, 3]) {
      const retried = await runForPackageTest(command.executable, command.args, project);
      assert.notEqual(retried.code, 0, `run ${subsequentRun}: ${retried.stdout}\n${retried.stderr}`);
      assert.deepEqual((await readdir(packageDirectory)).filter((name) => name.endsWith('.tgz')), []);

      const retainedMetadata = await lstat(retainedSubstitute[0]!);
      assert.equal(retainedMetadata.dev, substituteMetadata.dev);
      assert.equal(retainedMetadata.ino, substituteMetadata.ino);
      assert.equal(
        await readFile(join(retainedSubstitute[0]!, 'native', 'linux-arm64', 'substitute-helper'), 'utf8'),
        'substitute holder must survive\n',
      );

      const originalAfterRetry = await lstat(preservedOriginal);
      assert.equal(originalAfterRetry.dev, originalMetadata.dev);
      assert.equal(originalAfterRetry.ino, originalMetadata.ino);
      assert.equal(
        await readFile(join(preservedOriginal, 'native', 'linux-arm64', 'original-helper'), 'utf8'),
        'original holder must survive\n',
      );
      const unrelatedAfterRetry = await lstat(unrelated);
      assert.equal(unrelatedAfterRetry.dev, unrelatedMetadata.dev);
      assert.equal(unrelatedAfterRetry.ino, unrelatedMetadata.ino);
      assert.equal(await readFile(unrelated, 'utf8'), 'unrelated name must survive\n');
    }
  } finally {
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
