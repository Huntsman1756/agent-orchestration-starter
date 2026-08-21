import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import { resolveBinding } from '../src/runtime/bindings.js';
import { loadRuntimeProfileV4 } from '../src/runtime/load.js';
import {
  codexBrokerProviderConfigArgvV4,
  codexModelConfigArgvV4,
  openCodeModelOptionsV4,
  renderModelPromptV4,
  strictSddExecutorInstructionsV4,
  strictSddPlannerInstructionsV4,
} from '../src/runtime/model-guidance.js';
import { isProviderGatewayPathAllowedV4 } from '../src/runtime/provider-egress-gateway.js';
import { validModelGuidance, validRuntimeProfile, validWorkContract } from './runtime-contracts.test.js';

test('renders the selected model guidance without changing stable authority', () => {
  const markdown = renderModelPromptV4({
    guidance: validModelGuidance(),
    stableInstructions: ['Stable boundary.'],
    task: 'Change greeting.',
    context: '{"trusted":true}',
  });
  assert.match(markdown, /^# Instructions\n\nStable boundary\.\nKeep the change minimal\./);
  assert.ok(markdown.indexOf('# Context') < markdown.indexOf('# Task'));

  const xml = renderModelPromptV4({
    guidance: { ...validModelGuidance(), promptFormat: 'xml', contextPlacement: 'after-task' },
    stableInstructions: ['Never widen scope.'],
    task: 'Use <repo>.',
    context: 'A&B',
  });
  assert.ok(xml.indexOf('<task>') < xml.indexOf('<context>'));
  assert.match(xml, /Use &lt;repo&gt;\./);
  assert.match(xml, /A&amp;B/);
});

test('renders strict SDD planner and executor boundaries', () => {
  assert.match(strictSddPlannerInstructionsV4().join('\n'), /acceptance tests first/i);
  const instructions = strictSddExecutorInstructionsV4(validWorkContract()).join('\n');
  assert.match(instructions, /READ-ONLY.*immutable/i);
  assert.match(instructions, /PROHIBITED from editing/i);
  assert.match(instructions, /src\/greeting\.ts/);
  assert.match(instructions, /tests\/greeting\.test\.ts/);
  assert.match(instructions, /repository-root opencode\.json.*never.*personal.*global/is);
});

test('maps only bounded cross-provider controls and rejects unsupported Codex effort', () => {
  assert.deepEqual(openCodeModelOptionsV4({ ...validModelGuidance(), temperature: 0.2 }), {
    reasoningEffort: 'low',
    textVerbosity: 'low',
    temperature: 0.2,
    steps: 16,
  });
  assert.deepEqual(codexModelConfigArgvV4({ ...validModelGuidance(), reasoningEffort: 'provider-default' }), []);
  assert.deepEqual(codexModelConfigArgvV4({ ...validModelGuidance(), reasoningEffort: 'xhigh' }), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.throws(() => codexModelConfigArgvV4({ ...validModelGuidance(), reasoningEffort: 'vendor-ultra' }), /CAPABILITY_UNVERIFIED/);
});

test('pins Codex to the internal Responses gateway and keeps the path allowlist narrow', () => {
  assert.deepEqual(codexBrokerProviderConfigArgvV4('http://provider-gateway:8080/v1'), [
    '-c',
    'model_provider="broker_gateway"',
    '-c',
    'model_providers.broker_gateway.name="Broker Gateway"',
    '-c',
    'model_providers.broker_gateway.base_url="http://provider-gateway:8080/v1"',
    '-c',
    'model_providers.broker_gateway.env_key="PROVIDER_GATEWAY_TOKEN"',
    '-c',
    'model_providers.broker_gateway.wire_api="responses"',
    '-c',
    'model_providers.broker_gateway.requires_openai_auth=false',
  ]);
  assert.throws(() => codexBrokerProviderConfigArgvV4('https://api.nan.builders/v1'), /CAPABILITY_UNVERIFIED/);
  assert.equal(isProviderGatewayPathAllowedV4('/v1/chat/completions'), true);
  assert.equal(isProviderGatewayPathAllowedV4('/v1/responses'), true);
  assert.equal(isProviderGatewayPathAllowedV4('/v1/models'), false);
  assert.equal(isProviderGatewayPathAllowedV4('/v1/responses?debug=true'), false);
});

test('binds model guidance into qualification identity and loads the current subscription snapshot', async () => {
  const profile = loadRuntimeProfileV4(validRuntimeProfile());
  const original = resolveBinding({ profile, route: 'ECONOMY', sourceSensitivity: 'PUBLIC' });
  const changed = loadRuntimeProfileV4({
    ...profile,
    bindings: {
      ...profile.bindings,
      executor: {
        ...profile.bindings.executor,
        model: 'replacement-model',
        guidance: { ...profile.bindings.executor.guidance, id: 'replacement-guidance', revision: 'official-2' },
      },
    },
  });
  assert.notEqual(resolveBinding({ profile: changed, route: 'ECONOMY', sourceSensitivity: 'PUBLIC' }).binding_hash, original.binding_hash);

  const snapshot = loadRuntimeProfileV4(
    parse(await readFile(new URL('../profiles/runtime.chatgpt-subscription.example.yaml', import.meta.url), 'utf8')),
  );
  assert.equal(snapshot.bindings.executor.model, 'gpt-5.6-luna');
  assert.equal(snapshot.bindings.executor.authentication, 'provider-api-key');
  assert.equal(snapshot.bindings.executor.guidance.reasoningEffort, 'low');
  assert.equal(snapshot.bindings.orchestrator.model, 'gpt-5.6-sol');
  assert.equal(snapshot.bindings.orchestrator.authentication, 'chatgpt-subscription');
  assert.equal(snapshot.bindings.frontierExecutor.authentication, 'provider-api-key');
  assert.equal(snapshot.bindings.reviewer.authentication, 'chatgpt-subscription');
  assert.equal(snapshot.bindings.reviewer.guidance.id, 'openai-gpt-5p6-sol');

  const nan = loadRuntimeProfileV4(parse(await readFile(new URL('../profiles/nan-opencode.example.yaml', import.meta.url), 'utf8')));
  assert.equal(nan.bindings.orchestrator.harness, 'codex');
  assert.equal(nan.bindings.orchestrator.model, 'gpt-5.6-sol');
  assert.equal(nan.bindings.orchestrator.authentication, 'chatgpt-subscription');
  assert.equal(nan.bindings.reviewer.harness, 'codex');
  assert.equal(nan.bindings.reviewer.authentication, 'chatgpt-subscription');
  assert.equal(nan.bindings.executor.harness, 'opencode');
  assert.equal(nan.bindings.executor.model, 'qwen3.6');
  assert.equal(nan.bindings.executor.authentication, 'provider-api-key');
  assert.equal(nan.bindings.executor.guidance.id, 'qwen3p6-nan');
  assert.equal(nan.bindings.escalationExecutor.model, 'deepseek-v4-flash');
  assert.equal(nan.bindings.escalationExecutor.guidance.id, 'deepseek-v4-flash-nan');
  assert.equal(nan.bindings.frontierExecutor.harness, 'opencode');
  assert.equal(nan.bindings.frontierExecutor.provider, 'nan');
  assert.equal(nan.bindings.frontierExecutor.model, 'deepseek-v4-flash');
  assert.equal(nan.bindings.frontierExecutor.authentication, 'provider-api-key');
  assert.equal(nan.runtime.maxEconomyParallelRequests, 1);
});

test('requires guidance for every model binding and HTTPS provenance', () => {
  const profile = validRuntimeProfile() as any;
  delete profile.bindings.executor.guidance;
  assert.throws(() => loadRuntimeProfileV4(profile), /guidance/i);

  const insecure = validRuntimeProfile() as any;
  insecure.bindings.executor.guidance.sourceUrls = ['http://example.invalid/model'];
  assert.throws(() => loadRuntimeProfileV4(insecure), /HTTPS|sourceUrls/i);
});
