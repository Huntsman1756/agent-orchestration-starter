import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/main.js';

async function configFiles(): Promise<{ directory: string; policy: string; profile: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-orchestration-cli-'));
  const policy = join(directory, 'orchestration.yaml');
  const profile = join(directory, 'profile.yaml');
  await writeFile(policy, `
version: 1
roles:
  orchestrator: { tier: frontier, capabilities: [planning, delegation], permissions: { read: true, write: false } }
  executor: { tier: economy, capabilities: [coding], permissions: { read: true, write: true } }
  reviewer: { tier: frontier, capabilities: [review], permissions: { read: true, write: false } }
validation: { commands: [npm test] }
`, 'utf8');
  await writeFile(profile, `
version: 1
id: cli-test
assignments:
  orchestrator: { provider: frontier, model: main, tier: frontier, reasoningEffort: high, capabilities: [planning, delegation] }
  executor: { provider: economy, model: code, tier: economy, reasoningEffort: low, capabilities: [coding] }
  reviewer: { provider: frontier, model: main, tier: frontier, reasoningEffort: high, capabilities: [review] }
`, 'utf8');
  return { directory, policy, profile };
}

test('render dry-run and check expose machine-actionable status', async () => {
  const files = await configFiles();
  const output: string[] = [];
  const args = ['--target', files.directory, '--policy', files.policy, '--profile', files.profile, '--harnesses', 'codex'];

  const dryCode = await runCli(['render', ...args, '--dry-run'], { stdout: (line) => output.push(line) });
  const checkCode = await runCli(['check', ...args], { stdout: (line) => output.push(line) });

  assert.equal(dryCode, 0);
  assert.equal(checkCode, 1);
  assert.match(output.join('\n'), /would create.*executor\.toml/i);
  assert.match(output.join('\n'), /missing.*executor\.toml/i);
});

test('doctor reports local harness availability without network access', async () => {
  const output: string[] = [];
  const code = await runCli(['doctor', '--harnesses', 'codex,opencode,hermes'], {
    stdout: (line) => output.push(line),
    checkBinary: (binary) => binary !== 'opencode',
  });

  assert.equal(code, 1);
  assert.match(output.join('\n'), /codex: available/);
  assert.match(output.join('\n'), /opencode: missing/);
  assert.match(output.join('\n'), /hermes: available/);
});

test('requires exact CLI acceptance before rendering a degraded-isolation harness', async () => {
  const files = await configFiles();
  const errors: string[] = [];
  const args = ['--target', files.directory, '--policy', files.policy, '--profile', files.profile, '--harnesses', 'hermes', '--dry-run'];

  const rejected = await runCli(['render', ...args], { stderr: (line) => errors.push(line) });
  const accepted = await runCli(['render', ...args, '--accept-degraded-isolation', 'hermes']);

  assert.equal(rejected, 2);
  assert.match(errors.join('\n'), /hard.*hermes.*degraded/i);
  assert.equal(accepted, 0);
});

test('doctor rejects an installed harness that cannot meet the requested isolation', async () => {
  const files = await configFiles();
  const errors: string[] = [];
  const args = ['doctor', '--harnesses', 'hermes', '--policy', files.policy, '--profile', files.profile];

  const rejected = await runCli(args, { checkBinary: () => true, stderr: (line) => errors.push(line) });
  const accepted = await runCli([...args, '--accept-degraded-isolation', 'hermes'], { checkBinary: () => true });

  assert.equal(rejected, 2);
  assert.match(errors.join('\n'), /hard.*hermes.*degraded/i);
  assert.equal(accepted, 0);
});

test('benchmark prints a deterministic provider-neutral routing report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-orchestration-benchmark-'));
  const observations = join(directory, 'observations.jsonl');
  const routingPolicy = join(directory, 'routing-gate.yaml');
  const record = (taskId: string, attemptedRoute: 'economy_only' | 'frontier_execution', totalCostUsd: number) => ({
    schemaVersion: 1,
    taskId,
    taskClass: 'mechanical-change',
    attemptedRoute,
    firstPassAccepted: true,
    finalAccepted: true,
    totalCostUsd,
    latencyMs: 100,
    repairCount: 0,
    escalated: false,
    postAcceptanceDefects: 0,
    frontierTokens: { input: attemptedRoute === 'frontier_execution' ? 100 : 0, output: 0 },
    economyTokens: { input: attemptedRoute === 'economy_only' ? 100 : 0, output: 0 },
  });
  await writeFile(observations, `${JSON.stringify(record('task-1', 'economy_only', 0.5))}\n${JSON.stringify(record('task-1', 'frontier_execution', 1))}\n`, 'utf8');
  await writeFile(routingPolicy, `
schemaVersion: 1
baselineRoute: frontier_execution
candidateRoutes: [economy_only]
minPairedSamplesPerRoute: 1
minAcceptedTaskCostSavingsRate: 0.2
maxFirstPassAcceptanceDropRate: 0
maxFinalAcceptanceDropRate: 0
maxEscalationRate: 0
maxPostAcceptanceDefectRate: 0
`, 'utf8');
  const output: string[] = [];

  const code = await runCli(['benchmark', '--observations', observations, '--routing-policy', routingPolicy], {
    stdout: (line) => output.push(line),
  });

  assert.equal(code, 0);
  const report = JSON.parse(output.join('\n'));
  assert.equal(report.decisions[0].decision, 'promote');
  assert.equal(report.decisions[0].candidateRoute, 'economy_only');
});
