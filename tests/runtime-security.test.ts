import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCodexProjectConfig } from '../src/runtime/codex-project-config.js';
import { createRuntimeEventV4 } from '../src/runtime/telemetry.js';
import * as runtime from '../src/runtime/index.js';

test('broker unavailability has no direct-write fallback and project activation is mandatory read-only', () => {
  const config = renderCodexProjectConfig({ frontier_model: 'frontier', reasoning_effort: 'high' }).content;
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /required = true/);
  assert.doesNotMatch(config, /workspace-write|danger-full-access|fallback/i);
});

test('telemetry rejects nested credentials without influencing the existing failed gate', () => {
  const state = { state: 'FAILED' };
  assert.throws(() => createRuntimeEventV4({ schema_version: 4, type: 'RUN_FAILED', event_id: 'evt_0000000000000001', run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1', sequence: 1, previous_hash: null, recorded_at: '2026-08-10T12:00:00.000Z', contract_hash: 'a'.repeat(64), evidence_hashes: [], counters: { attempts: 1 }, findings: [], environment: { token: `ghp_${'x'.repeat(24)}` } } as never), /telemetry/);
  assert.equal(state.state, 'FAILED');
});

test('runtime-v4 public barrel exposes the stable orchestration and evidence surface', async () => {
  for (const name of ['createRuntimeOrchestratorV4', 'appendRuntimeEventV4', 'createUnavailableV3TelemetryPortV4', 'verifyReviewAttestation', 'finalizeRun']) assert.equal(typeof runtime[name as keyof typeof runtime], 'function', name);
  const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile('package.json', 'utf8')));
  assert.deepEqual(manifest.exports['./runtime-v4'], { types: './dist/runtime/index.d.ts', import: './dist/runtime/index.js' });
});
