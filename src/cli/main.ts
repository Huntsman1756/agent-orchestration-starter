#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Harness } from '../adapters/index.js';
import { loadPolicy, loadProfile } from '../core/load-config.js';
import { checkProject, renderProject } from '../core/render.js';
import { resolveRoles } from '../core/resolve.js';

export interface CliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  checkBinary?: (binary: string) => boolean;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function harnesses(argv: string[]): Harness[] {
  const value = option(argv, '--harnesses') ?? 'codex,opencode,hermes';
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of parsed) {
    if (!['codex', 'opencode', 'hermes'].includes(item)) throw new Error(`Unsupported harness: ${item}`);
  }
  return parsed as Harness[];
}

function localBinary(binary: string): boolean {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(command, [binary], { stdio: 'ignore' }).status === 0;
}

async function resolvedFromArgs(argv: string[]) {
  const policyPath = option(argv, '--policy');
  const profilePath = option(argv, '--profile');
  if (!policyPath || !profilePath) throw new Error('--policy and --profile are required');
  return resolveRoles(await loadPolicy(policyPath), await loadProfile(profilePath));
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  try {
    const command = argv[0];
    if (command === 'doctor') {
      let missing = false;
      for (const harness of harnesses(argv)) {
        const available = (io.checkBinary ?? localBinary)(harness);
        stdout(`${harness}: ${available ? 'available' : 'missing'}`);
        missing ||= !available;
      }
      return missing ? 1 : 0;
    }
    if (!['init', 'render', 'check'].includes(command ?? '')) {
      stderr('Usage: agent-orchestration <init|render|check|doctor> [options]');
      return 2;
    }
    const targetDir = option(argv, '--target') ?? process.cwd();
    const selectedHarnesses = harnesses(argv);
    const policy = await resolvedFromArgs(argv);
    if (command === 'check') {
      const report = await checkProject({ targetDir, policy, harnesses: selectedHarnesses });
      for (const issue of report.issues) stdout(`${issue.reason}: ${issue.path}`);
      if (report.issues.length === 0) stdout(`clean: ${report.clean.length} managed files`);
      return report.issues.length === 0 ? 0 : 1;
    }
    const dryRun = argv.includes('--dry-run');
    const forcePaths = argv.flatMap((value, index) => value === '--force' && argv[index + 1] ? [argv[index + 1]] : []);
    const report = await renderProject({ targetDir, policy, harnesses: selectedHarnesses, dryRun, forcePaths });
    for (const path of report.created) stdout(`${dryRun ? 'would create' : 'created'}: ${path}`);
    for (const path of report.updated) stdout(`${dryRun ? 'would update' : 'updated'}: ${path}`);
    for (const conflict of report.conflicts) stdout(`${conflict.reason}: ${conflict.path}`);
    return report.conflicts.length === 0 ? 0 : 1;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
