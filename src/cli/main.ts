#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import type { Harness } from '../adapters/index.js';
import { compileHarness } from '../adapters/index.js';
import { loadPolicy, loadProfile } from '../core/load-config.js';
import { checkProject, renderProject } from '../core/render.js';
import { resolveRoles } from '../core/resolve.js';
import { evaluateRouting } from '../routing/evaluate.js';
import { loadBenchmarkObservations, loadRoutingGatePolicy } from '../routing/load.js';
import { canonicalize } from '../pilot/canonical-json.js';
import { evaluatePilot, type PilotEvaluationContextV3 } from '../pilot/evaluate.js';
import {
  loadPilotEvaluationReportV3,
  loadPilotEventV3,
  loadPilotManifestV3,
  loadPilotRoutingGateV3,
} from '../pilot/load.js';
import { verifyManifest } from '../pilot/manifest.js';
import { reduceEvents } from '../pilot/reducer.js';
import type { PilotEventV3 } from '../pilot/contracts.js';

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

function acceptedDegradedIsolation(argv: string[]): Harness[] {
  const value = option(argv, '--accept-degraded-isolation');
  if (!value) return [];
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of parsed) {
    if (!['codex', 'opencode', 'hermes'].includes(item)) throw new Error(`Unsupported isolation acceptance: ${item}`);
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

function pilotArgumentError(message: string): Error {
  return new Error(`PILOT_V3_ARGUMENT_ERROR: ${message}`);
}

function pilotInputError(message: string): Error {
  return new Error(`PILOT_V3_INPUT_ERROR: ${message}`);
}

const pilotV3Options = new Set([
  '--manifest', '--events', '--gate', '--evaluation-id', '--evaluation-version', '--prior-report',
]);

function parsePilotV3Options(argv: string[]): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!pilotV3Options.has(name)) throw pilotArgumentError(`unsupported option ${name}`);
    if (seen.has(name)) throw pilotArgumentError(`duplicate option ${name}`);
    seen.add(name);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) continue;
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

async function readPilotYaml(path: string, kind: 'manifest' | 'gate'): Promise<unknown> {
  try {
    return parseYaml(await readFile(path, 'utf8'));
  } catch {
    throw pilotInputError(`${kind} YAML is not valid`);
  }
}

async function readPilotEvents(path: string): Promise<PilotEventV3[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw pilotInputError('events JSONL could not be read');
  }
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw pilotInputError('events JSONL is empty');
  return lines.map((line, index) => {
    try {
      return loadPilotEventV3(JSON.parse(line));
    } catch {
      throw pilotInputError(`event line ${index + 1} is not valid V3 evidence`);
    }
  });
}

async function runPilotV3Evaluate(argv: string[], stdout: (line: string) => void): Promise<number> {
  const options = parsePilotV3Options(argv);
  const manifestPath = options.get('--manifest');
  const eventsPath = options.get('--events');
  const gatePath = options.get('--gate');
  if (!manifestPath || !eventsPath || !gatePath) {
    throw pilotArgumentError('--manifest, --events, and --gate are required');
  }
  const evaluationId = options.get('--evaluation-id');
  const evaluationVersionText = options.get('--evaluation-version');
  if (!evaluationId || !evaluationVersionText) {
    throw pilotArgumentError('--evaluation-id and --evaluation-version are required');
  }
  const evaluationVersion = Number(evaluationVersionText);
  if (!Number.isSafeInteger(evaluationVersion) || evaluationVersion <= 0) {
    throw pilotArgumentError('--evaluation-version must be a positive integer');
  }
  const priorReportPath = options.get('--prior-report');
  if (evaluationVersion === 1 && priorReportPath) {
    throw pilotArgumentError('--prior-report is forbidden for evaluation version 1');
  }
  if (evaluationVersion > 1 && !priorReportPath) {
    throw pilotArgumentError('--prior-report is required when --evaluation-version is greater than 1');
  }

  let manifest;
  let gate;
  let priorReport = null;
  try {
    manifest = loadPilotManifestV3(await readPilotYaml(manifestPath, 'manifest'));
    gate = loadPilotRoutingGateV3(await readPilotYaml(gatePath, 'gate'));
    if (priorReportPath) priorReport = loadPilotEvaluationReportV3(JSON.parse(await readFile(priorReportPath, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PILOT_V3_')) throw error;
    throw pilotInputError('manifest, gate, or prior report is not valid V3 evidence');
  }
  if (!verifyManifest(manifest).ok) throw pilotInputError('manifest verification failed');
  const events = await readPilotEvents(eventsPath);
  const context: PilotEvaluationContextV3 = {
    evaluation_id: evaluationId,
    evaluation_version: evaluationVersion,
    prior_report: priorReport,
  };
  try {
    const observations = reduceEvents(manifest, events);
    const report = evaluatePilot(manifest, observations, gate, context);
    stdout(canonicalize({ schema_version: 3, observations, report }));
    return 0;
  } catch {
    throw new Error('PILOT_V3_EVALUATION_ERROR: supplied evidence could not be reduced or evaluated');
  }
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? console.log;
  const stderr = io.stderr ?? console.error;
  try {
    const command = argv[0];
    if (command === 'pilot-v3') {
      if (argv[1] !== 'evaluate') throw pilotArgumentError('pilot-v3 requires the evaluate subcommand');
      return await runPilotV3Evaluate(argv.slice(2), stdout);
    }
    if (command === 'benchmark') {
      const observationsPath = option(argv, '--observations');
      const routingPolicyPath = option(argv, '--routing-policy');
      if (!observationsPath || !routingPolicyPath) {
        throw new Error('--observations and --routing-policy are required');
      }
      const report = evaluateRouting(
        await loadBenchmarkObservations(observationsPath),
        await loadRoutingGatePolicy(routingPolicyPath),
      );
      stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    if (command === 'doctor') {
      const selectedHarnesses = harnesses(argv);
      const isolationAcceptance = acceptedDegradedIsolation(argv);
      const hasPolicyConfig = option(argv, '--policy') !== undefined || option(argv, '--profile') !== undefined;
      if (hasPolicyConfig) {
        const policy = await resolvedFromArgs(argv);
        for (const harness of selectedHarnesses) compileHarness(harness, policy, { acceptDegradedIsolation: isolationAcceptance });
      }
      let missing = false;
      for (const harness of selectedHarnesses) {
        const available = (io.checkBinary ?? localBinary)(harness);
        stdout(`${harness}: ${available ? 'available' : 'missing'}`);
        missing ||= !available;
      }
      return missing ? 1 : 0;
    }
    if (!['init', 'render', 'check'].includes(command ?? '')) {
      stderr('Usage: agent-orchestration <init|render|check|doctor|benchmark|pilot-v3> [options]');
      return 2;
    }
    const targetDir = option(argv, '--target') ?? process.cwd();
    const selectedHarnesses = harnesses(argv);
    const isolationAcceptance = acceptedDegradedIsolation(argv);
    const policy = await resolvedFromArgs(argv);
    if (command === 'check') {
      const report = await checkProject({ targetDir, policy, harnesses: selectedHarnesses, acceptDegradedIsolation: isolationAcceptance });
      for (const issue of report.issues) stdout(`${issue.reason}: ${issue.path}`);
      if (report.issues.length === 0) stdout(`clean: ${report.clean.length} managed files`);
      return report.issues.length === 0 ? 0 : 1;
    }
    const dryRun = argv.includes('--dry-run');
    const forcePaths = argv.flatMap((value, index) => value === '--force' && argv[index + 1] ? [argv[index + 1]] : []);
    const report = await renderProject({ targetDir, policy, harnesses: selectedHarnesses, dryRun, forcePaths, acceptDegradedIsolation: isolationAcceptance });
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
