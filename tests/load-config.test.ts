import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadPolicy, loadProfile } from '../src/core/load-config.js';

async function yamlFile(name: string, contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-orchestration-config-'));
  const path = join(directory, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

test('rejects a concrete model in the stable role policy', async () => {
  const path = await yamlFile('orchestration.yaml', `
version: 1
roles:
  orchestrator:
    tier: frontier
    capabilities: [planning]
    permissions: { read: true, write: false }
    model: vendor/model-that-will-change
  executor:
    tier: economy
    capabilities: [coding]
    permissions: { read: true, write: true }
  reviewer:
    tier: frontier
    capabilities: [review]
    permissions: { read: true, write: false }
validation:
  commands: [npm test]
`);

  await assert.rejects(loadPolicy(path), /model|unrecognized/i);
});

test('rejects a profile without an explicit executor assignment', async () => {
  const path = await yamlFile('profile.yaml', `
version: 1
id: incomplete
assignments:
  orchestrator:
    provider: example
    model: frontier
    tier: frontier
    reasoningEffort: high
    capabilities: [planning]
  reviewer:
    provider: example
    model: frontier
    tier: frontier
    reasoningEffort: high
    capabilities: [review]
`);

  await assert.rejects(loadProfile(path), /executor/i);
});

test('loads a provider-agnostic policy and explicit profile', async () => {
  const policyPath = await yamlFile('orchestration.yaml', `
version: 1
roles:
  orchestrator:
    tier: frontier
    capabilities: [planning, delegation]
    permissions: { read: true, write: false }
  executor:
    tier: economy
    capabilities: [coding]
    permissions: { read: true, write: true }
  reviewer:
    tier: frontier
    capabilities: [review]
    permissions: { read: true, write: false }
validation:
  commands: [npm test]
`);
  const profilePath = await yamlFile('profile.yaml', `
version: 1
id: example
assignments:
  orchestrator: { provider: vendor-a, model: frontier-a, tier: frontier, reasoningEffort: high, capabilities: [planning, delegation] }
  executor: { provider: vendor-b, model: economy-b, tier: economy, reasoningEffort: low, capabilities: [coding] }
  reviewer: { provider: vendor-a, model: frontier-a, tier: frontier, reasoningEffort: high, capabilities: [review] }
`);

  const policy = await loadPolicy(policyPath);
  const profile = await loadProfile(profilePath);

  assert.equal(policy.roles.executor.tier, 'economy');
  assert.equal(profile.assignments.executor.model, 'economy-b');
});
