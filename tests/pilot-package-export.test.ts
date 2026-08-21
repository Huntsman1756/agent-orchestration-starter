import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as pilot from '../src/pilot/index.js';

test('pilot-v3 public barrel exposes every stable V3 runtime function without internal paths', () => {
  const expected = [
    'activeEvents',
    'aggregateUsage',
    'appendEvaluation',
    'appendEvent',
    'assertSafeEvent',
    'assignArms',
    'buildReviewPacket',
    'canonicalize',
    'computePilotMetrics',
    'deterministicBootstrapIndices',
    'evaluatePilot',
    'freezeManifest',
    'hashCanonical',
    'loadPilotBlockObservationV3',
    'loadPilotEvaluationReportV3',
    'loadPilotEventV3',
    'loadPilotManifestV3',
    'loadPilotRoutingGateV3',
    'parseContractualUtc',
    'priceUsage',
    'reduceEvents',
    'replayBlock',
    'transition',
    'verifyManifest',
  ];

  for (const name of expected) assert.equal(typeof pilot[name as keyof typeof pilot], 'function', name);
});

test('pilot barrel exposes the provider-neutral dogfood freeze and verification functions', () => {
  for (const name of [
    'freezeDogfoodManifestV1',
    'freezeDogfoodRunRecordV1',
    'loadDogfoodManifestV1',
    'loadDogfoodRunRecordV1',
    'verifyDogfoodManifestV1',
    'verifyDogfoodRunRecordV1',
  ])
    assert.equal(typeof pilot[name as keyof typeof pilot], 'function', name);
});

test('package publishes the pilot-v3 barrel with explicit types and import targets', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.deepEqual(packageJson.exports['./pilot-v3'], {
    types: './dist/pilot/index.d.ts',
    import: './dist/pilot/index.js',
  });
});

test('package publishes the dogfood-v1 evidence contract with explicit types and import targets', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.deepEqual(packageJson.exports['./dogfood-v1'], {
    types: './dist/pilot/dogfood-manifest.d.ts',
    import: './dist/pilot/dogfood-manifest.js',
  });
});

test('package policy excludes local superpowers evidence from published artifacts', async () => {
  const npmIgnore = await readFile('.npmignore', 'utf8');
  const rules = npmIgnore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(rules.includes('.superpowers/'));
});
