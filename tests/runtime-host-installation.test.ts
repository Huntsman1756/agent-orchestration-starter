import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { canonicalJsonV4, hashCanonicalV4 } from '../src/runtime/canonical.js';
import { runtimeHostCompositionCertificationHashV4 } from '../src/runtime/host-components.js';
import { activateRuntimeRepositoryV4, installRuntimeHostV4, verifyRuntimeHostInstallationV4, verifyRuntimeRepositoryActivationV4 } from '../src/runtime/host-installation.js';
import { createRuntimeHostFixtureV4 } from './runtime-host-fixtures.js';

const at = '2026-08-10T12:00:00.000Z';

async function fixtureBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'runtime-bundle-'));
  await mkdir(join(root, 'dist', 'host'), { recursive: true });
  await mkdir(join(root, 'dist', 'native', 'linux-x64'), { recursive: true });
  await mkdir(join(root, 'contracts'), { recursive: true });
  await writeFile(join(root, 'dist', 'host', 'agent-orchestration.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(root, 'dist', 'native', 'linux-x64', 'helper'), 'native');
  await writeFile(join(root, 'contracts', 'runtime.json'), '{}\n');
  await writeFile(join(root, 'LICENSE'), 'MIT\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  return root;
}

test('installs an immutable self-contained runtime and detects drift', async () => {
  const sourceRoot = await fixtureBundle();
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-host-'));
  const manifest = await installRuntimeHostV4({ sourceRoot, hostRoot, installedAt: at });

  assert.match(manifest.installationId, /^1\.2\.3-[a-f0-9]{16}$/u);
  assert.equal(await verifyRuntimeHostInstallationV4(manifest), manifest.installationHash);
  assert.equal((await installRuntimeHostV4({ sourceRoot, hostRoot, installedAt: '2026-08-10T12:01:00.000Z' })).installationHash, manifest.installationHash);

  await writeFile(manifest.entrypoint, 'drift');
  await assert.rejects(() => verifyRuntimeHostInstallationV4(manifest), /installed file drifted/u);
});

test('installs and verifies every separately certified host component plus the exact aggregate composition', async () => {
  const sourceRoot = await fixtureBundle();
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-host-components-'));
  const fixture = await createRuntimeHostFixtureV4();
  const manifest = await installRuntimeHostV4({
    sourceRoot,
    hostRoot,
    hostDriver: fixture.driverSource,
    hostComponentsManifest: fixture.componentManifestPath,
    installedAt: at,
  });

  assert.equal(manifest.hostComposition?.components.length, 8);
  assert.equal(manifest.hostComposition?.compositionCertificationHash, fixture.componentManifest.compositionCertificationHash);
  assert.equal(manifest.hostComposition?.components[0]?.path, join(manifest.root, 'host-components', 'credential_gateway.mjs'));
  assert.equal(await verifyRuntimeHostInstallationV4(manifest), manifest.installationHash);
  const schema = JSON.parse(await readFile(new URL('../contracts/runtime-host-installation-v4.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

  await writeFile(manifest.hostComposition!.components[0]!.path, 'drift');
  await assert.rejects(() => verifyRuntimeHostInstallationV4(manifest), /installed file drifted: host-components\/credential_gateway\.mjs/u);
});

test('requires the root driver and certified component composition together', async () => {
  const sourceRoot = await fixtureBundle();
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-host-components-pair-'));
  const fixture = await createRuntimeHostFixtureV4();

  await assert.rejects(() => installRuntimeHostV4({ sourceRoot, hostRoot, hostDriver: fixture.driverSource, installedAt: at }), /host driver and component manifest must be supplied together/u);
  await assert.rejects(() => installRuntimeHostV4({ sourceRoot, hostRoot, hostComponentsManifest: fixture.componentManifestPath, installedAt: at }), /host driver and component manifest must be supplied together/u);
});

test('creates a new immutable installation identity when aggregate evidence is renewed over unchanged binaries', async () => {
  const sourceRoot = await fixtureBundle();
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-host-certification-renewal-'));
  const fixture = await createRuntimeHostFixtureV4();
  const first = await installRuntimeHostV4({ sourceRoot, hostRoot, hostDriver: fixture.driverSource, hostComponentsManifest: fixture.componentManifestPath, installedAt: at });
  const integrationEvidenceHash = 'f'.repeat(64);
  const renewed = {
    ...fixture.componentManifest,
    integrationEvidenceHash,
    compositionCertificationHash: runtimeHostCompositionCertificationHashV4(fixture.componentManifest.driverSha256, integrationEvidenceHash, fixture.componentManifest.components),
  };
  await writeFile(fixture.componentManifestPath, `${canonicalJsonV4(renewed)}\n`);

  const second = await installRuntimeHostV4({ sourceRoot, hostRoot, hostDriver: fixture.driverSource, hostComponentsManifest: fixture.componentManifestPath, installedAt: at });

  assert.notEqual(second.installationId, first.installationId);
  assert.notEqual(second.hostComposition?.compositionCertificationHash, first.hostComposition?.compositionCertificationHash);
});

test('activates one central installation in an arbitrary Git repository without copying runtime code', async () => {
  const sourceRoot = await fixtureBundle();
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-host-'));
  const installation = await installRuntimeHostV4({ sourceRoot, hostRoot, installedAt: at });
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'runtime-repository-'));
  const worktreeParent = await mkdtemp(join(tmpdir(), 'runtime-worktrees-'));
  assert.equal(spawnSync('git', ['init', repositoryRoot], { windowsHide: true }).status, 0);
  const policyPath = join(repositoryRoot, 'repository-policy.yaml');
  const profilePath = join(repositoryRoot, 'runtime-profile.yaml');
  const policy = (await readFile(new URL('../policies/repository-policy.example.yaml', import.meta.url), 'utf8')).replace('example-repository', 'portable-repository');
  const profile = await readFile(new URL('../profiles/nan-opencode.example.yaml', import.meta.url), 'utf8');
  await writeFile(policyPath, policy);
  await writeFile(profilePath, profile);

  const activation = await activateRuntimeRepositoryV4({
    repositoryRoot, policyPath, profilePath, worktreeParent, hostRoot,
    installationManifest: join(installation.root, 'installation-v4.json'), target: 'ANALYSIS_ONLY', activatedAt: at,
  });
  const activationPath = join(repositoryRoot, '.agent-orchestration', 'activation-v4.json');
  const verified = await verifyRuntimeRepositoryActivationV4(activationPath);
  const codex = await readFile(join(repositoryRoot, '.codex', 'config.toml'), 'utf8');
  const activationSchema = JSON.parse(await readFile(new URL('../contracts/runtime-repository-activation-v4.schema.json', import.meta.url), 'utf8'));
  const validateActivation = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(activationSchema);

  assert.equal(verified.activation.activationHash, activation.activationHash);
  assert.equal(activation.hostCompositionHash, null);
  assert.equal(validateActivation(activation), true, JSON.stringify(validateActivation.errors));
  assert.match(codex, /runtime", "mcp-stdio", "--activation"/u);
  assert.match(codex, /agent-orchestration\.mjs/u);
  assert.equal((await activateRuntimeRepositoryV4({ repositoryRoot, policyPath, profilePath, worktreeParent, hostRoot, installationManifest: join(installation.root, 'installation-v4.json'), target: 'ANALYSIS_ONLY', activatedAt: '2026-08-10T12:01:00.000Z' })).activationHash, activation.activationHash);
  await writeFile(join(hostRoot, 'repository-registry-v4.json'), '{broken-json\n');
  await assert.rejects(() => activateRuntimeRepositoryV4({ repositoryRoot, policyPath, profilePath, worktreeParent, hostRoot, installationManifest: join(installation.root, 'installation-v4.json'), target: 'ANALYSIS_ONLY', activatedAt: '2026-08-10T12:02:00.000Z' }), /repository registry cannot be read/u);
  await assert.rejects(() => activateRuntimeRepositoryV4({ repositoryRoot, policyPath, profilePath, worktreeParent, hostRoot, installationManifest: join(installation.root, 'installation-v4.json'), target: 'ISOLATED_EXECUTION', activatedAt: at }), /different activation manifest/u);

  const { activationHash: ignored, ...activationBody } = activation;
  const driftedBody = { ...activationBody, hostCompositionHash: 'f'.repeat(64) };
  await writeFile(activationPath, `${canonicalJsonV4({ ...driftedBody, activationHash: hashCanonicalV4(driftedBody) })}\n`);
  await assert.rejects(() => verifyRuntimeRepositoryActivationV4(activationPath), /host composition binding drifted/u);
});
