import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compileHarness, type GeneratedFile, type Harness } from '../adapters/index.js';
import { contentHash, INVENTORY_PATH, readInventory, type Inventory } from './inventory.js';
import type { ResolvedPolicy } from './types.js';

export interface RenderOptions {
  targetDir: string;
  policy: ResolvedPolicy;
  harnesses: Harness[];
  dryRun?: boolean;
  forcePaths?: string[];
  acceptDegradedIsolation?: Harness[];
}

export interface RenderReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  conflicts: Array<{ path: string; reason: 'unmanaged' | 'locally-modified' }>;
}

export interface CheckReport {
  clean: string[];
  issues: Array<{ path: string; reason: 'missing' | 'outdated' | 'locally-modified' | 'unmanaged' }>;
}

function orchestrationInstructions(policy: ResolvedPolicy): GeneratedFile {
  return {
    path: 'AGENTS.md',
    content: [
      '# Agent orchestration contract',
      '',
      `Allowed routing strategies: ${policy.routing.strategies.join(', ')}. Use economy_only for mechanical work with strong deterministic gates, orchestrated for hard-to-understand but bounded work, and frontier_execution for cross-cutting, ambiguous, security-sensitive, or delicate work.`,
      'Route recommendations require benchmark evidence for the task class; orchestrated is not a universal default.',
      'Pass work contracts, never the full conversation. A work contract includes: id, objective, allowed files, inputs, constraints, validation commands, success criteria, budget, and result format.',
      'The executor returns only status, files changed, validation result, and risks. Start review in a fresh context containing only the original contract, complete diff, deterministic results, and requested files.',
      'The reviewer stays read-only and cannot overrule failed deterministic validation. Exclude planner rationale, executor reasoning, and prior verdicts from review evidence.',
      `Required write isolation: ${policy.isolation.required}. A degraded harness requires exact explicit acceptance and records its effective guarantee in the manifest.`,
      'Fallback is allowed only for typed provider/model availability failures. Authentication, policy, invalid output, grounding, and validation failures fail closed.',
      '',
      'Project validation commands:',
      ...policy.validation.commands.map((command) => `- \`${command}\``),
      '',
    ].join('\n'),
  };
}

function desiredFiles(policy: ResolvedPolicy, harnesses: Harness[], acceptDegradedIsolation: Harness[] = []): GeneratedFile[] {
  const byPath = new Map<string, GeneratedFile>();
  for (const generated of [orchestrationInstructions(policy), ...harnesses.flatMap((harness) => compileHarness(harness, policy, { acceptDegradedIsolation }))]) {
    const prior = byPath.get(generated.path);
    if (prior && prior.content !== generated.content) throw new Error(`Conflicting generated content for ${generated.path}`);
    byPath.set(generated.path, generated);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

export async function renderProject(options: RenderOptions): Promise<RenderReport> {
  const report: RenderReport = { created: [], updated: [], unchanged: [], conflicts: [] };
  const inventory = await readInventory(options.targetDir);
  const nextFiles: Record<string, string> = { ...(inventory?.files ?? {}) };
  const force = new Set(options.forcePaths ?? []);

  for (const generated of desiredFiles(options.policy, options.harnesses, options.acceptDegradedIsolation)) {
    const absolute = join(options.targetDir, generated.path);
    const existing = await readExisting(absolute);
    const desiredHash = contentHash(generated.content);
    const recordedHash = inventory?.files[generated.path];
    if (existing === null) {
      report.created.push(generated.path);
      nextFiles[generated.path] = desiredHash;
      if (!options.dryRun) await atomicWrite(absolute, generated.content);
      continue;
    }
    const existingHash = contentHash(existing);
    if (existingHash === desiredHash) {
      report.unchanged.push(generated.path);
      nextFiles[generated.path] = desiredHash;
      continue;
    }
    const reason = recordedHash === undefined ? 'unmanaged' : existingHash !== recordedHash ? 'locally-modified' : null;
    if (reason && !force.has(generated.path)) {
      report.conflicts.push({ path: generated.path, reason });
      continue;
    }
    report.updated.push(generated.path);
    nextFiles[generated.path] = desiredHash;
    if (!options.dryRun) await atomicWrite(absolute, generated.content);
  }

  if (!options.dryRun) {
    const nextInventory: Inventory = {
      schemaVersion: 1,
      policyVersion: options.policy.policyVersion,
      profileVersion: options.policy.profileVersion,
      profileId: options.policy.profileId,
      files: nextFiles,
    };
    await atomicWrite(join(options.targetDir, INVENTORY_PATH), `${JSON.stringify(nextInventory, null, 2)}\n`);
  }
  return report;
}

export async function checkProject(options: Omit<RenderOptions, 'dryRun' | 'forcePaths'>): Promise<CheckReport> {
  const inventory = await readInventory(options.targetDir);
  const report: CheckReport = { clean: [], issues: [] };
  for (const generated of desiredFiles(options.policy, options.harnesses, options.acceptDegradedIsolation)) {
    const existing = await readExisting(join(options.targetDir, generated.path));
    if (existing === null) {
      report.issues.push({ path: generated.path, reason: 'missing' });
      continue;
    }
    const existingHash = contentHash(existing);
    const desiredHash = contentHash(generated.content);
    const recordedHash = inventory?.files[generated.path];
    if (recordedHash === undefined) {
      report.issues.push({ path: generated.path, reason: 'unmanaged' });
    } else if (existingHash !== recordedHash) {
      report.issues.push({ path: generated.path, reason: 'locally-modified' });
    } else if (existingHash !== desiredHash) {
      report.issues.push({ path: generated.path, reason: 'outdated' });
    } else {
      report.clean.push(generated.path);
    }
  }
  return report;
}
