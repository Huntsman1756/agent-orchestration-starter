import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFreshCapability, liveProviderProbesEnabledV4, probeRuntimeBinding } from '../src/runtime/capabilities.js';

const identity = {
  profile_hash: 'a'.repeat(64),
  harness: 'opencode',
  harness_version: '1.18.15',
  agent_policy_hash: 'b'.repeat(64),
  broker_version: '0.1.0',
  probe_version: 1,
} as const;

test('qualifies only three identical complete probe runs and binds their evidence to the identity', async () => {
  const evidence = {
    structured_result: true,
    exact_bounded_edit: true,
    multi_step_file_tools: true,
    repair_from_validation_evidence: true,
    shell_used: false,
    transcript_hash: 'c'.repeat(64),
  } as const;
  let calls = 0;
  const record = await probeRuntimeBinding({
    identity,
    probed_at: '2026-08-10T08:00:00.000Z',
    ttl_seconds: 3600,
    run_probe: async () => { calls += 1; return evidence; },
  });
  assert.equal(calls, 3);
  assert.equal(record.status, 'VERIFIED');
  assert.equal(record.clean_runs, 3);
  assert.equal(record.evidence_hash.length, 64);
  assertFreshCapability(record, identity, '2026-08-10T08:30:00.000Z');
});

test('identity drift, expiry, or incomplete evidence is CAPABILITY_UNVERIFIED', async () => {
  let iteration = 0;
  await assert.rejects(() => probeRuntimeBinding({
    identity,
    probed_at: '2026-08-10T08:00:00.000Z',
    ttl_seconds: 60,
    run_probe: async () => ({
      structured_result: true,
      exact_bounded_edit: iteration++ !== 0,
      multi_step_file_tools: true,
      repair_from_validation_evidence: true,
      shell_used: false,
      transcript_hash: 'c'.repeat(64),
    }),
  }), /CAPABILITY_UNVERIFIED/);
  const record = await probeRuntimeBinding({
    identity,
    probed_at: '2026-08-10T08:00:00.000Z',
    ttl_seconds: 60,
    run_probe: async () => ({ structured_result: true, exact_bounded_edit: true, multi_step_file_tools: true, repair_from_validation_evidence: true, shell_used: false, transcript_hash: 'c'.repeat(64) }),
  });
  assert.throws(() => assertFreshCapability(record, { ...identity, harness_version: '1.18.16' }, '2026-08-10T08:00:30.000Z'), /CAPABILITY_UNVERIFIED/);
  assert.throws(() => assertFreshCapability(record, identity, '2026-08-10T08:01:01.000Z'), /CAPABILITY_UNVERIFIED/);
  assert.equal(liveProviderProbesEnabledV4({}), false);
  assert.equal(liveProviderProbesEnabledV4({ AO_LIVE_PROVIDER_PROBES: '1' }), true);
});
