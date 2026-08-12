import type { RuntimeModelGuidanceV4 } from './contracts.js';

export interface ModelPromptInputV4 {
  readonly guidance: RuntimeModelGuidanceV4;
  readonly stableInstructions: readonly string[];
  readonly task: string;
  readonly context?: string;
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
