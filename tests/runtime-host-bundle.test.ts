import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { activateRuntimeRepositoryV4, installRuntimeHostV4 } from '../src/runtime/host-installation.js';

test('the installed host bundle starts without a project node_modules tree', async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-real-host-'));
  const sourceRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, '$1');
  const installation = await installRuntimeHostV4({ sourceRoot, hostRoot, installedAt: '2026-08-10T12:00:00.000Z' });
  const result = spawnSync(process.execPath, [installation.entrypoint], { cwd: hostRoot, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, windowsHide: true });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: agent-orchestration/u);
});

test('the installed bundle loads only its hash-pinned host driver through a repository activation', async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'runtime-real-driver-host-'));
  const sourceRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, '$1');
  const driverSource = join(await mkdtemp(join(tmpdir(), 'runtime-driver-source-')), 'driver.mjs');
  await writeFile(driverSource, 'export function createRuntimeHostDriverV4(){return {daemon:async()=>{},doctor:async()=>["ready"],mcpStdio:async()=>{},status:async(id)=>({run_id:id})}}\n');
  const installation = await installRuntimeHostV4({ sourceRoot, hostRoot, hostDriver: driverSource, installedAt: '2026-08-10T12:00:00.000Z' });
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'runtime-driver-repository-'));
  const worktreeParent = await mkdtemp(join(tmpdir(), 'runtime-driver-worktrees-'));
  assert.equal(spawnSync('git', ['init', repositoryRoot], { windowsHide: true }).status, 0);
  const policyPath = join(repositoryRoot, 'repository-policy.yaml');
  const profilePath = join(repositoryRoot, 'runtime-profile.yaml');
  await writeFile(policyPath, (await readFile(new URL('../policies/repository-policy.example.yaml', import.meta.url), 'utf8')).replace('example-repository', 'driver-repository'));
  await writeFile(profilePath, await readFile(new URL('../profiles/nan-opencode.example.yaml', import.meta.url), 'utf8'));
  const activation = await activateRuntimeRepositoryV4({ repositoryRoot, policyPath, profilePath, worktreeParent, hostRoot, installationManifest: join(installation.root, 'installation-v4.json'), target: 'ANALYSIS_ONLY', activatedAt: '2026-08-10T12:00:00.000Z' });
  await writeFile(driverSource, 'throw new Error("external source must not be loaded")\n');

  const result = spawnSync(process.execPath, [installation.entrypoint, 'runtime', 'mcp-stdio', '--activation', join(repositoryRoot, '.agent-orchestration', 'activation-v4.json')], { cwd: repositoryRoot, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(activation.installationHash, installation.installationHash);
  assert.equal(installation.hostDriver?.path, join(installation.root, 'host-driver.mjs'));
});
