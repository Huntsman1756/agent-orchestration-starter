import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';

import { compileHarness } from '../src/adapters/index.js';
import { resolvedPolicy } from './fixtures.js';

function file(harness: 'codex' | 'opencode' | 'hermes', path: string): string {
  const output = compileHarness(harness, resolvedPolicy(), { acceptDegradedIsolation: harness === 'hermes' ? ['hermes'] : [] });
  const generated = output.find((entry) => entry.path === path);
  assert.ok(generated, `missing ${harness} file ${path}`);
  return generated.content;
}

test('rejects degraded Hermes isolation unless that harness is explicitly accepted', () => {
  assert.throws(() => compileHarness('hermes', resolvedPolicy()), /hard.*hermes.*degraded/i);

  const output = compileHarness('hermes', resolvedPolicy(), { acceptDegradedIsolation: ['hermes'] });
  const manifest = output.find((entry) => entry.path.endsWith('policy-manifest.json'));
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest.content).effectiveWriteIsolation, 'degraded');
});

test('compiles explicit Codex custom agents with role-specific sandboxes', () => {
  const config = file('codex', '.codex/config.toml');
  const orchestrator = file('codex', '.codex/agents/orchestrator.toml');
  const executor = file('codex', '.codex/agents/executor.toml');
  const reviewer = file('codex', '.codex/agents/reviewer.toml');

  assert.match(config, /^model = "frontier-main"/m);
  assert.match(config, /^model_reasoning_effort = "high"/m);
  assert.match(config, /^sandbox_mode = "read-only"/m);
  assert.match(orchestrator, /model = "frontier-main"/);
  assert.match(orchestrator, /sandbox_mode = "read-only"/);
  assert.match(orchestrator, /acceptance tests first/i);
  assert.match(executor, /model = "economy-code"/);
  assert.match(executor, /sandbox_mode = "workspace-write"/);
  assert.match(executor, /PROHIBITED from editing.*acceptance-test/i);
  assert.match(reviewer, /sandbox_mode = "read-only"/);
});

test('compiles a writable frontier executor for direct frontier execution', () => {
  const codex = file('codex', '.codex/agents/frontier-executor.toml');
  const openCode = file('opencode', '.opencode/agents/frontier-executor.md');

  assert.match(codex, /model = "frontier-main"/);
  assert.match(codex, /sandbox_mode = "workspace-write"/);
  assert.match(openCode, /model: frontier-vendor\/frontier-main/);
  assert.match(openCode, /edit: allow/);
});

test('compiles OpenCode agents with explicit models and permissions', () => {
  const orchestrator = file('opencode', '.opencode/agents/orchestrator.md');
  const executor = file('opencode', '.opencode/agents/executor.md');
  const reviewer = file('opencode', '.opencode/agents/reviewer.md');

  assert.match(orchestrator, /model: frontier-vendor\/frontier-main/);
  assert.match(orchestrator, /edit: deny/);
  assert.match(orchestrator, /bash:\n\s+["']\*["']: deny/);
  assert.match(executor, /model: economy-vendor\/economy-code/);
  assert.match(executor, /edit: allow/);
  assert.match(executor, /PROHIBITED from editing.*acceptance-test/i);
  assert.match(executor, /bash:\n\s+["']\*["']: ask/);
  assert.match(reviewer, /edit: deny/);
  assert.match(reviewer, /bash:\n\s+["']\*["']: deny/);
  assert.doesNotMatch(reviewer, /git diff\*: allow/);
  assert.doesNotMatch(reviewer, /npm test\*: allow/);
});

test('compiles a Hermes distribution with frontier parent and economy delegation', () => {
  const config = parse(file('hermes', 'hermes-profile/config.yaml'));
  const soul = file('hermes', 'hermes-profile/SOUL.md');

  assert.deepEqual(config.model, { provider: 'hermes-frontier', default: 'frontier-main' });
  assert.equal(config.delegation.provider, 'hermes-economy');
  assert.equal(config.delegation.model, 'economy-code');
  assert.deepEqual(config.fallback_providers, []);
  assert.match(soul, /deterministic validation/i);
  assert.match(soul, /work contract/i);
  assert.match(soul, /acceptance tests first/i);
  assert.match(soul, /PROHIBITED from editing/i);
});

test('uses harness-specific provider aliases without changing the canonical model identity', () => {
  const openCode = file('opencode', '.opencode/agents/orchestrator.md');
  const hermes = parse(file('hermes', 'hermes-profile/config.yaml'));

  assert.match(openCode, /model: frontier-vendor\/frontier-main/);
  assert.equal(hermes.model.provider, 'hermes-frontier');
});

test('requires reviewer execution in a clean context with an evidence-only envelope', () => {
  const reviewer = file('codex', '.codex/agents/reviewer.toml');
  const hermes = file('hermes', 'hermes-profile/SOUL.md');

  for (const instructions of [reviewer, hermes]) {
    assert.match(instructions, /fresh review context/i);
    assert.match(instructions, /original work contract/i);
    assert.match(instructions, /complete diff/i);
    assert.match(instructions, /deterministic.*results/i);
    assert.match(instructions, /exclude.*planner rationale.*executor reasoning/i);
  }
});

test('rejects a Hermes profile that cannot represent a separate reviewer model', () => {
  const resolved = resolvedPolicy();
  resolved.roles.reviewer.model = 'different-reviewer';
  resolved.roles.reviewer.modelRef = 'frontier-vendor/different-reviewer';

  assert.throws(() => compileHarness('hermes', resolved, { acceptDegradedIsolation: ['hermes'] }), /reviewer.*same frontier parent/i);
});
