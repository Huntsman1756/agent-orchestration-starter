import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateRouting } from '../src/routing/evaluate.js';
import { loadBenchmarkObservations, loadRoutingGatePolicy } from '../src/routing/load.js';
import type { BenchmarkObservation, RoutingGatePolicy, RoutingStrategy } from '../src/routing/types.js';

const gate: RoutingGatePolicy = {
  schemaVersion: 2,
  baselineRoute: 'frontier_execution',
  candidateRoutes: ['economy_only', 'orchestrated'],
  minPairedSamplesPerRoute: 30,
  minAcceptedTaskCostSavingsRate: 0.2,
  maxFirstPassAcceptanceDropRate: 0,
  maxFinalAcceptanceDropRate: 0,
  maxEscalationRate: 0.2,
  maxPostAcceptanceDefectIncidenceRate: 0.02,
};

function observation(index: number, route: RoutingStrategy, overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation {
  return {
    schemaVersion: 2,
    taskId: `task-${index}`,
    caseFingerprint: 'a'.repeat(64),
    taskClass: 'mechanical-change',
    attemptedRoute: route,
    firstPassAccepted: true,
    finalAccepted: true,
    totalCostUsd: route === 'frontier_execution' ? 1 : 0.5,
    latencyMs: route === 'frontier_execution' ? 2000 : 1000,
    repairCount: 0,
    escalated: false,
    postAcceptanceDefective: false,
    postAcceptanceDefects: [],
    frontierTokens: { input: route === 'frontier_execution' ? 1000 : 0, output: route === 'frontier_execution' ? 200 : 0 },
    economyTokens: { input: route === 'frontier_execution' ? 0 : 1000, output: route === 'frontier_execution' ? 0 : 200 },
    ...overrides,
  };
}

function observations(count: number, route: RoutingStrategy, overrides: Partial<BenchmarkObservation> = {}): BenchmarkObservation[] {
  return Array.from({ length: count }, (_, index) => observation(index, route, overrides));
}

function unpairedObservations(count: number, route: RoutingStrategy): BenchmarkObservation[] {
  return Array.from({ length: count }, (_, index) => observation(index, route, { taskId: `${route}-${index}` }));
}

test('reports insufficient evidence until a candidate and baseline have enough comparable pairs', () => {
  const report = evaluateRouting([
    ...observations(29, 'economy_only'),
    ...observations(30, 'frontier_execution'),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.equal(decision.decision, 'insufficient_evidence');
  assert.equal(decision.pairedSamples, 29);
  assert.deepEqual(decision.reasons, ['paired_sample_below_minimum']);
});

test('does not count unpaired candidate and baseline observations toward the gate minimum', () => {
  const report = evaluateRouting([
    ...unpairedObservations(30, 'economy_only'),
    ...unpairedObservations(30, 'frontier_execution'),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.equal(decision.decision, 'insufficient_evidence');
  assert.equal(decision.pairedSamples, 0);
  assert.deepEqual(decision.reasons, ['paired_sample_below_minimum']);
});

test('does not pair equal task IDs produced from different case conditions', () => {
  const report = evaluateRouting([
    ...observations(30, 'economy_only', { caseFingerprint: 'a'.repeat(64) }),
    ...observations(30, 'frontier_execution', { caseFingerprint: 'b'.repeat(64) }),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.equal(decision.pairedSamples, 0);
  assert.equal(decision.decision, 'insufficient_evidence');
});

test('rejects a candidate that does not reduce accepted-task cost enough', () => {
  const report = evaluateRouting([
    ...observations(30, 'economy_only', { totalCostUsd: 0.85 }),
    ...observations(30, 'frontier_execution', { totalCostUsd: 1 }),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.ok(decision.candidate.acceptedTaskCostUsd !== null);
  assert.ok(Math.abs(decision.candidate.acceptedTaskCostUsd - 0.85) < 1e-9);
  assert.equal(decision.decision, 'reject');
  assert.deepEqual(decision.reasons, ['accepted_task_cost_savings_below_minimum']);
});

test('promotes a sufficiently sampled candidate with lower accepted-task cost and equal quality', () => {
  const report = evaluateRouting([
    ...observations(30, 'orchestrated'),
    ...observations(30, 'frontier_execution'),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'orchestrated');
  assert.ok(decision);
  assert.equal(decision.decision, 'promote');
  assert.deepEqual(decision.reasons, []);
});

test('records rescued economy attempts as first-pass failures and rejects excessive escalation', () => {
  const report = evaluateRouting([
    ...observations(30, 'economy_only', {
      firstPassAccepted: false,
      finalAccepted: true,
      escalated: true,
      frontierTokens: { input: 500, output: 100 },
    }),
    ...observations(30, 'frontier_execution'),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.equal(decision.candidate.finalAcceptanceRate, 1);
  assert.equal(decision.candidate.firstPassAcceptanceRate, 0);
  assert.equal(decision.decision, 'reject');
  assert.deepEqual(decision.reasons, [
    'first_pass_acceptance_drop_above_maximum',
    'escalation_rate_above_maximum',
  ]);
});

test('rejects equal first-pass performance when the candidate leaves fewer tasks finally accepted', () => {
  const candidate = Array.from({ length: 30 }, (_, index) => observation(index, 'economy_only', {
    firstPassAccepted: index < 20,
    finalAccepted: index < 20,
    totalCostUsd: 0.1,
  }));
  const baseline = Array.from({ length: 30 }, (_, index) => observation(index, 'frontier_execution', {
    firstPassAccepted: index < 20,
    finalAccepted: true,
    totalCostUsd: 1,
    repairCount: index < 20 ? 0 : 1,
  }));

  const report = evaluateRouting([...candidate, ...baseline], gate);
  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');

  assert.ok(decision);
  assert.equal(decision.candidate.firstPassAcceptanceRate, decision.baseline.firstPassAcceptanceRate);
  assert.equal(decision.candidate.finalAcceptanceRate, 20 / 30);
  assert.equal(decision.baseline.finalAcceptanceRate, 1);
  assert.equal(decision.decision, 'reject');
  assert.deepEqual(decision.reasons, ['final_acceptance_drop_above_maximum']);
});

test('gates post-acceptance defect incidence while retaining severity counts', () => {
  const candidate = observations(30, 'economy_only');
  candidate[0] = {
    ...candidate[0],
    postAcceptanceDefective: true,
    postAcceptanceDefects: [
      { severity: 'high', description: 'contract regression' },
      { severity: 'low', description: 'diagnostic wording' },
    ],
  };
  const report = evaluateRouting([
    ...candidate,
    ...observations(30, 'frontier_execution'),
  ], gate);

  const decision = report.decisions.find((item) => item.candidateRoute === 'economy_only');
  assert.ok(decision);
  assert.equal(decision.candidate.postAcceptanceDefectIncidenceRate, 1 / 30);
  assert.equal(decision.candidate.postAcceptanceDefectCount, 2);
  assert.deepEqual(decision.candidate.postAcceptanceDefectsBySeverity, { low: 1, medium: 0, high: 1, critical: 0 });
  assert.equal(decision.decision, 'reject');
  assert.ok(decision.reasons.includes('post_acceptance_defect_incidence_above_maximum'));
});

test('loads strict provider-neutral JSONL observations and YAML gate policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-load-'));
  const observationsPath = join(directory, 'observations.jsonl');
  const gatePath = join(directory, 'gate.yaml');
  const economy = observation(1, 'economy_only', { taskId: 'shared-task' });
  const frontier = observation(1, 'frontier_execution', { taskId: 'shared-task' });
  await writeFile(observationsPath, `${JSON.stringify(economy)}\n${JSON.stringify(frontier)}\n`, 'utf8');
  await writeFile(gatePath, `
schemaVersion: 2
baselineRoute: frontier_execution
candidateRoutes: [economy_only, orchestrated]
minPairedSamplesPerRoute: 30
minAcceptedTaskCostSavingsRate: 0.2
maxFirstPassAcceptanceDropRate: 0
maxFinalAcceptanceDropRate: 0
maxEscalationRate: 0.2
maxPostAcceptanceDefectIncidenceRate: 0.02
`, 'utf8');

  const loadedObservations = await loadBenchmarkObservations(observationsPath);
  const loadedGate = await loadRoutingGatePolicy(gatePath);

  assert.equal(loadedObservations.length, 2);
  assert.equal(loadedGate.minPairedSamplesPerRoute, 30);
});

test('rejects inconsistent post-acceptance incidence and defect details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'routing-defect-integrity-'));
  const observationsPath = join(directory, 'observations.jsonl');
  const inconsistent = observation(1, 'economy_only', {
    postAcceptanceDefective: false,
    postAcceptanceDefects: [{ severity: 'high', description: 'hidden incidence' }],
  });
  await writeFile(observationsPath, `${JSON.stringify(inconsistent)}\n`, 'utf8');

  await assert.rejects(loadBenchmarkObservations(observationsPath), /postAcceptanceDefective.*details/i);
});
