import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'yaml';

import { compileHarness } from '../src/adapters/index.js';
import { resolvedPolicy } from './fixtures.js';

function file(harness: 'codex' | 'opencode' | 'hermes', path: string): string {
  const output = compileHarness(harness, resolvedPolicy());
  const generated = output.find((entry) => entry.path === path);
  assert.ok(generated, `missing ${harness} file ${path}`);
  return generated.content;
}

test('compiles explicit Codex custom agents with role-specific sandboxes', () => {
  const config = file('codex', '.codex/config.toml');
  const orchestrator = file('codex', '.codex/agents/orchestrator.toml');
  const executor = file('codex', '.codex/agents/executor.toml');
  const reviewer = file('codex', '.codex/agents/reviewer.toml');

  assert.match(config, /^model = "frontier-main"/m);
  assert.match(config, /^model_reasoning_effort = "high"/m);
  assert.match(orchestrator, /model = "frontier-main"/);
  assert.match(orchestrator, /sandbox_mode = "read-only"/);
  assert.match(executor, /model = "economy-code"/);
  assert.match(executor, /sandbox_mode = "workspace-write"/);
  assert.match(reviewer, /sandbox_mode = "read-only"/);
});

test('compiles OpenCode agents with explicit models and permissions', () => {
  const orchestrator = file('opencode', '.opencode/agents/orchestrator.md');
  const executor = file('opencode', '.opencode/agents/executor.md');

  assert.match(orchestrator, /model: frontier-vendor\/frontier-main/);
  assert.match(orchestrator, /edit: deny/);
  assert.match(executor, /model: economy-vendor\/economy-code/);
  assert.match(executor, /edit: allow/);
});

test('compiles a Hermes distribution with frontier parent and economy delegation', () => {
  const config = parse(file('hermes', 'hermes-profile/config.yaml'));
  const soul = file('hermes', 'hermes-profile/SOUL.md');

  assert.deepEqual(config.model, { provider: 'frontier-vendor', default: 'frontier-main' });
  assert.equal(config.delegation.provider, 'economy-vendor');
  assert.equal(config.delegation.model, 'economy-code');
  assert.deepEqual(config.fallback_providers, []);
  assert.match(soul, /deterministic validation/i);
  assert.match(soul, /work contract/i);
});

test('rejects a Hermes profile that cannot represent a separate reviewer model', () => {
  const resolved = resolvedPolicy();
  resolved.roles.reviewer.model = 'different-reviewer';
  resolved.roles.reviewer.modelRef = 'frontier-vendor/different-reviewer';

  assert.throws(() => compileHarness('hermes', resolved), /reviewer.*same frontier parent/i);
});
