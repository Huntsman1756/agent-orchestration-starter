import { resolveRoles } from '../src/core/resolve.js';
import type { ModelProfile, Policy } from '../src/core/types.js';

export function resolvedPolicy() {
  const policy: Policy = {
    version: 1,
    roles: {
      orchestrator: { tier: 'frontier', capabilities: ['planning', 'delegation'], permissions: { read: true, write: false } },
      executor: { tier: 'economy', capabilities: ['coding'], permissions: { read: true, write: true } },
      reviewer: { tier: 'frontier', capabilities: ['review'], permissions: { read: true, write: false } },
    },
    validation: { commands: ['npm test', 'npm run typecheck'] },
    routing: { strategies: ['economy_only', 'orchestrated', 'frontier_execution'] },
    isolation: { required: 'hard' },
  };
  const profile: ModelProfile = {
    version: 3,
    id: 'test-profile',
    assignments: {
      orchestrator: {
        provider: 'frontier-vendor',
        harnessProviders: { hermes: 'hermes-frontier' },
        model: 'frontier-main',
        tier: 'frontier',
        reasoningEffort: 'high',
        capabilities: ['planning', 'delegation', 'coding'],
      },
      executor: {
        provider: 'economy-vendor',
        harnessProviders: { hermes: 'hermes-economy' },
        model: 'economy-code',
        tier: 'economy',
        reasoningEffort: 'low',
        capabilities: ['coding'],
      },
      reviewer: {
        provider: 'frontier-vendor',
        harnessProviders: { hermes: 'hermes-frontier' },
        model: 'frontier-main',
        tier: 'frontier',
        reasoningEffort: 'high',
        capabilities: ['review'],
      },
    },
  };
  return resolveRoles(policy, profile);
}
