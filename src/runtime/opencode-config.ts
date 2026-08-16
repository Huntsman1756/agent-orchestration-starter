import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJsonV4, hashCanonicalV4 } from './canonical.js';
import type { ResolvedBindingV4 } from './bindings.js';
import type { AllowedChangeV4 } from './contracts.js';
import { EconomyPolicyViolationErrorV4 } from './diff-policy.js';
import { openCodeModelOptionsV4 } from './model-guidance.js';

export interface OpenCodeConfigResultV4 {
  readonly host_path: string;
  readonly container_path: string;
  readonly config_hash: string;
}

export async function writeBrokerOpenCodeConfigV4(input: {
  readonly capsule_root: string;
  readonly binding: ResolvedBindingV4;
  readonly provider_endpoint: string;
  readonly acceptance_tests: readonly string[];
  readonly implementation_targets: readonly AllowedChangeV4[];
}): Promise<OpenCodeConfigResultV4> {
  if (input.binding.binding.harness !== 'opencode' || input.binding.binding.permissions !== 'contract-write') {
    throw new Error('EXECUTOR_POLICY_VIOLATION: binding cannot run the OpenCode executor');
  }
  let endpoint: URL;
  try { endpoint = new URL(input.provider_endpoint); } catch { throw new Error('EXECUTOR_POLICY_VIOLATION: provider gateway endpoint is invalid'); }
  if (endpoint.toString() !== 'http://provider-gateway:8080/v1' || endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
    throw new Error('EXECUTOR_POLICY_VIOLATION: provider gateway endpoint is not the broker-owned internal origin');
  }
  const edit: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  const acceptanceTests = new Set(input.acceptance_tests.map((path) => path.toLocaleLowerCase('en-US')));
  for (const change of input.implementation_targets) {
    if (acceptanceTests.has(change.path.toLocaleLowerCase('en-US'))) throw new EconomyPolicyViolationErrorV4(change.path);
    edit[`repo/${change.path}`] = 'allow';
  }
  const provider = input.binding.binding.provider;
  const model = input.binding.binding.model;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    autoupdate: false,
    enabled_providers: [provider],
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: `Broker-routed ${provider}`,
        options: {
          baseURL: endpoint.toString(),
          apiKey: '{env:PROVIDER_GATEWAY_TOKEN}',
        },
        models: { [model]: { name: model } },
      },
    },
    plugin: [],
    agent: {
      [input.binding.role]: {
        description: `Broker-owned ${input.binding.role} agent`,
        mode: 'primary',
        model: `${provider}/${model}`,
        ...openCodeModelOptionsV4(input.binding.binding.guidance),
      },
    },
    permission: {
      '*': 'deny',
      read: { '*': 'deny', 'repo/**': 'allow' },
      glob: { '*': 'deny', 'repo/**': 'allow' },
      grep: 'allow',
      edit,
    },
  } as const;
  const directory = join(input.capsule_root, 'config');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hostPath = join(directory, 'opencode.json');
  const serialized = `${canonicalJsonV4(config)}\n`;
  try {
    await writeFile(hostPath, serialized, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(hostPath, 'utf8').catch(() => '') !== serialized) {
      throw new Error('EXECUTOR_POLICY_VIOLATION: broker OpenCode config path is not immutable');
    }
  }
  return Object.freeze({ host_path: hostPath, container_path: '/capsule/config/opencode.json', config_hash: hashCanonicalV4(config) });
}
