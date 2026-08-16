import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderCodexProjectConfig } from '../src/runtime/codex-project-config.js';
import { renderProject } from '../src/core/render.js';
import type { ResolvedPolicy } from '../src/core/types.js';

function policy(): ResolvedPolicy {
  const role = { provider: 'provider', model: 'frontier-model', tier: 'frontier' as const, reasoningEffort: 'high' as const, capabilities: ['planning'], modelRef: 'provider/frontier-model', permissions: { read: true, write: false } };
  return { policyVersion: 1, profileVersion: 1, profileId: 'test', roles: { orchestrator: role, executor: { ...role, tier: 'economy', model: 'economy-model', modelRef: 'provider/economy-model', permissions: { read: true, write: true } }, reviewer: role }, validation: { commands: ['npm test'] }, routing: { strategies: ['orchestrated'] }, isolation: { required: 'hard' } };
}

test('renders required fail-closed project activation with one canonical runtime argv value', () => {
  const generated = renderCodexProjectConfig({ frontier_model: 'frontier-model', reasoning_effort: 'high' });
  assert.equal(generated.path, '.codex/config.toml');
  assert.match(generated.content, /^model = "frontier-model"\nmodel_reasoning_effort = "high"\ncli_auth_credentials_store = "keyring"\nforced_login_method = "chatgpt"\napproval_policy = "never"\nsandbox_mode = "read-only"/);
  assert.match(generated.content, /args = \["\.agent-orchestration\/runtime\/dist\/cli\/main\.js", "runtime", "mcp-stdio"\]/);
  assert.match(generated.content, /required = true/);
  assert.match(generated.content, /enabled_tools = \["run_coding_task", "repair_coding_task", "finalize_coding_task", "abort_coding_task", "get_coding_task_status"\]/);
  assert.doesNotMatch(generated.content, /env\s*=/);
});

test('renders a central immutable runtime binding without embedding credentials', () => {
  const generated = renderCodexProjectConfig({ frontier_model: 'frontier-model', reasoning_effort: 'high', runtime_entrypoint: 'G:/host/runtime.mjs', activation_manifest: 'G:/repo/.agent-orchestration/activation-v4.json' });
  assert.match(generated.content, /args = \["G:\/host\/runtime\.mjs", "runtime", "mcp-stdio", "--activation", "G:\/repo\/\.agent-orchestration\/activation-v4\.json"\]/u);
  assert.doesNotMatch(generated.content, /token|api_key|env\s*=/iu);
});

test('render inventory manages activation but never overwrites an unmanaged conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runner-v4-codex-config-'));
  const first = await renderProject({ targetDir: directory, policy: policy(), harnesses: ['codex'] });
  assert.ok(first.created.includes('.codex/config.toml'));
  const expected = await readFile(join(directory, '.codex', 'config.toml'), 'utf8');
  await writeFile(join(directory, '.codex', 'config.toml'), 'unmanaged = true\n');
  const conflict = await renderProject({ targetDir: directory, policy: policy(), harnesses: ['codex'] });
  assert.deepEqual(conflict.conflicts, [{ path: '.codex/config.toml', reason: 'locally-modified' }]);
  assert.equal(await readFile(join(directory, '.codex', 'config.toml'), 'utf8'), 'unmanaged = true\n');
  assert.notEqual(expected, 'unmanaged = true\n');

  const unmanagedDirectory = await mkdtemp(join(tmpdir(), 'runner-v4-codex-unmanaged-'));
  await writeFile(join(unmanagedDirectory, 'placeholder'), 'x');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(unmanagedDirectory, '.codex')));
  await writeFile(join(unmanagedDirectory, '.codex', 'config.toml'), 'foreign = true\n');
  const unmanaged = await renderProject({ targetDir: unmanagedDirectory, policy: policy(), harnesses: ['codex'] });
  assert.deepEqual(unmanaged.conflicts, [{ path: '.codex/config.toml', reason: 'unmanaged' }]);
  assert.equal(await readFile(join(unmanagedDirectory, '.codex', 'config.toml'), 'utf8'), 'foreign = true\n');
});
