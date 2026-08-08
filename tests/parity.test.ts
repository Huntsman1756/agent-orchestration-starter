import assert from 'node:assert/strict';
import test from 'node:test';

import { compileHarness } from '../src/adapters/index.js';
import { resolvedPolicy } from './fixtures.js';

test('all adapters publish the same resolved role and validation contract', () => {
  const manifests = (['codex', 'opencode', 'hermes'] as const).map((harness) => {
    const generated = compileHarness(harness, resolvedPolicy(), { acceptDegradedIsolation: harness === 'hermes' ? ['hermes'] : [] });
    const manifest = generated.find((file) => file.path.endsWith('policy-manifest.json'));
    assert.ok(manifest, `${harness} did not emit a policy manifest`);
    return JSON.parse(manifest.content);
  });

  for (const manifest of manifests.slice(1)) {
    assert.deepEqual(manifest.roles, manifests[0].roles);
    assert.deepEqual(manifest.validation, manifests[0].validation);
    assert.equal(manifest.policyVersion, 1);
    assert.equal(manifest.profileVersion, 3);
  }
});
