import { hashCanonicalV4 } from './canonical.js';
import { loadRuntimeRepositoryPolicyV4 } from './load.js';
import type { RuntimeRepositoryPolicyV4 } from './contracts.js';

export interface FrozenRepositoryPolicyV4 {
  policy: RuntimeRepositoryPolicyV4;
  hash: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function freezeRepositoryPolicy(input: RuntimeRepositoryPolicyV4): FrozenRepositoryPolicyV4 {
  const policy = deepFreeze(loadRuntimeRepositoryPolicyV4(input));
  return Object.freeze({ policy, hash: hashCanonicalV4(policy) });
}
