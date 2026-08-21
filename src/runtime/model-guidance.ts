import type { RuntimeModelGuidanceV4 } from './contracts.js';

export interface ModelPromptInputV4 {
  readonly guidance: RuntimeModelGuidanceV4;
  readonly stableInstructions: readonly string[];
  readonly task: string;
  readonly context?: string;
}

export function strictSddPlannerInstructionsV4(): readonly string[] {
  return Object.freeze([
    'Use strict Spec-Driven Development: generate the acceptance tests first so they define the expected behavior.',
    'Only after the acceptance tests are frozen may you request implementation from the Economy executor.',
    'The Work Contract must separate acceptance_tests (read-only) from implementation_targets (write-only).',
    'Static quality and security gates are deterministic acceptance criteria; never waive lint or format failures by model judgment.',
    'When planning OpenCode configuration work, the only configurable file is repository-root opencode.json; never target personal, user-level, home-directory, or global OpenCode configuration.',
  ]);
}

export function strictSddExecutorInstructionsV4(input: { readonly acceptance_tests: readonly string[]; readonly implementation_targets: readonly { readonly path: string; readonly operations: readonly string[] }[] }): readonly string[] {
  const acceptanceTests = input.acceptance_tests.join(', ');
  const implementationTargets = input.implementation_targets.map((change) => `${change.path} [${change.operations.join(', ')}]`).join(', ');
  return Object.freeze([
    'SDD STRICT: the repository snapshot is readable, but write authority is limited to the implementation targets below.',
    `Acceptance tests (READ-ONLY, immutable): ${acceptanceTests}`,
    `Implementation targets (READ-WRITE only): ${implementationTargets}`,
    'You are PROHIBITED from editing the supplied acceptance-test files. Your only objective is to modify implementation files so npm test passes.',
    'SHIFT-LEFT: npm run lint and npm run format:critical:check are networkless deterministic gates. Repair every reported static quality or security finding before claiming completion.',
    'If a repair packet is supplied, follow its bounded instruction without widening the implementation target list.',
    'For OpenCode configuration work, repository-root opencode.json is the only permitted config target and only when listed above; never read or edit personal, user-level, home-directory, or global OpenCode configuration.',
  ]);
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function ordered(input: ModelPromptInputV4): readonly [string, string][] {
  const guidance = [...input.stableInstructions, ...input.guidance.instructions].join('\n');
  const context = input.context ?? '';
  const body: [string, string][] = [['instructions', guidance]];
  if (input.guidance.contextPlacement === 'before-task' && context.length > 0) body.push(['context', context]);
  body.push(['task', input.task]);
  if (input.guidance.contextPlacement === 'after-task' && context.length > 0) body.push(['context', context]);
  return body;
}

export function renderModelPromptV4(input: ModelPromptInputV4): string {
  const sections = ordered(input);
  if (input.guidance.promptFormat === 'xml') {
    return sections.map(([name, value]) => `<${name}>\n${xml(value)}\n</${name}>`).join('\n\n');
  }
  if (input.guidance.promptFormat === 'markdown') {
    return sections.map(([name, value]) => `# ${name[0]!.toUpperCase()}${name.slice(1)}\n\n${value}`).join('\n\n');
  }
  return sections.map(([name, value]) => `${name.toUpperCase()}:\n${value}`).join('\n\n');
}

export function openCodeModelOptionsV4(guidance: RuntimeModelGuidanceV4): Readonly<Record<string, string | number>> {
  const options: Record<string, string | number> = {
    textVerbosity: guidance.textVerbosity,
    steps: guidance.maxSteps,
  };
  if (guidance.reasoningEffort !== 'provider-default') options.reasoningEffort = guidance.reasoningEffort;
  if (guidance.temperature !== null) options.temperature = guidance.temperature;
  return Object.freeze(options);
}

export function codexModelConfigArgvV4(guidance: RuntimeModelGuidanceV4): readonly string[] {
  if (guidance.reasoningEffort === 'provider-default') return Object.freeze([]);
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(guidance.reasoningEffort)) {
    throw new Error('CAPABILITY_UNVERIFIED: Codex reasoning effort is not supported by this adapter');
  }
  return Object.freeze(['-c', `model_reasoning_effort=${JSON.stringify(guidance.reasoningEffort)}`]);
}

export function codexBrokerProviderConfigArgvV4(providerEndpoint: string): readonly string[] {
  let endpoint: URL;
  try { endpoint = new URL(providerEndpoint); } catch { throw new Error('CAPABILITY_UNVERIFIED: Codex provider gateway endpoint is invalid'); }
  if (endpoint.toString() !== 'http://provider-gateway:8080/v1') {
    throw new Error('CAPABILITY_UNVERIFIED: Codex provider gateway endpoint is invalid');
  }
  return Object.freeze([
    '-c', 'model_provider="broker_gateway"',
    '-c', 'model_providers.broker_gateway.name="Broker Gateway"',
    '-c', `model_providers.broker_gateway.base_url=${JSON.stringify(endpoint.toString().replace(/\/$/u, ''))}`,
    '-c', 'model_providers.broker_gateway.env_key="PROVIDER_GATEWAY_TOKEN"',
    '-c', 'model_providers.broker_gateway.wire_api="responses"',
    '-c', 'model_providers.broker_gateway.requires_openai_auth=false',
  ]);
}
