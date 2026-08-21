import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

async function loadValidator(path: string) {
  const schema = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  return new Ajv2020({ strict: true }).compile(schema);
}

function validObservation() {
  return {
    schemaVersion: 2,
    taskId: 'task-1',
    caseFingerprint: 'a'.repeat(64),
    taskClass: 'mechanical-change',
    attemptedRoute: 'economy_only',
    firstPassAccepted: true,
    finalAccepted: true,
    totalCostUsd: 0.5,
    latencyMs: 1000,
    repairCount: 0,
    escalated: false,
    postAcceptanceDefective: false,
    postAcceptanceDefects: [],
    frontierTokens: { input: 0, output: 0 },
    economyTokens: { input: 100, output: 20 },
  };
}

test('public observation schema rejects every cross-field combination rejected by the loader', async () => {
  const validate = await loadValidator('../contracts/benchmark-observation.schema.json');
  const invalid = [
    { ...validObservation(), firstPassAccepted: true, finalAccepted: false },
    { ...validObservation(), escalated: true, firstPassAccepted: true },
    {
      ...validObservation(),
      finalAccepted: false,
      firstPassAccepted: false,
      postAcceptanceDefective: true,
      postAcceptanceDefects: [{ severity: 'high', description: 'late defect' }],
    },
    {
      ...validObservation(),
      postAcceptanceDefective: false,
      postAcceptanceDefects: [{ severity: 'high', description: 'hidden defect' }],
    },
    { ...validObservation(), postAcceptanceDefective: true, postAcceptanceDefects: [] },
  ];

  assert.equal(validate(validObservation()), true);
  for (const observation of invalid) assert.equal(validate(observation), false);
});

test('public routing-gate schema rejects the baseline route as a candidate', async () => {
  const validate = await loadValidator('../contracts/routing-gate.schema.json');
  const gate = {
    schemaVersion: 2,
    baselineRoute: 'frontier_execution',
    candidateRoutes: ['economy_only', 'frontier_execution'],
    minPairedSamplesPerRoute: 30,
    minAcceptedTaskCostSavingsRate: 0.2,
    maxFirstPassAcceptanceDropRate: 0,
    maxFinalAcceptanceDropRate: 0,
    maxEscalationRate: 0.2,
    maxPostAcceptanceDefectIncidenceRate: 0.02,
    maxHighSeverityPostAcceptanceDefects: 0,
    maxCriticalSeverityPostAcceptanceDefects: 0,
  };

  assert.equal(validate(gate), false);
  assert.equal(
    validate.errors?.some((error: ErrorObject) => error.keyword === 'additionalProperties'),
    false,
  );
  assert.ok(validate.errors?.some((error: ErrorObject) => error.keyword === 'not'));
});
