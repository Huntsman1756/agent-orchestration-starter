import { hashCanonicalV4 } from './canonical.js';
import type { EffectiveRouteV4, RuntimeBindingV4, RuntimeProfileV4, RuntimeRoleV4, SourceSensitivityV4 } from './contracts.js';

export interface BindingResolutionInputV4 {
  profile: RuntimeProfileV4;
  route: EffectiveRouteV4;
  sourceSensitivity: SourceSensitivityV4;
}

export interface ResolvedBindingV4 {
  role: RuntimeRoleV4;
  binding: RuntimeBindingV4;
  binding_hash: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function resolveBinding(input: BindingResolutionInputV4): ResolvedBindingV4 {
  const role: RuntimeRoleV4 = input.route === 'FRONTIER' ? 'frontierExecutor' : 'executor';
  const binding = input.profile.bindings[role];
  if (binding.permissions !== 'contract-write') {
    throw new Error(`INVALID_CONTRACT: ${role} must have contract-write permission`);
  }
  if (!binding.allowedSourceSensitivity.includes(input.sourceSensitivity)) {
    throw new Error(`SOURCE_SENSITIVITY_UNSUPPORTED: ${role} cannot process ${input.sourceSensitivity}`);
  }
  const owned = deepFreeze(structuredClone(binding));
  return Object.freeze({ role, binding: owned, binding_hash: hashCanonicalV4(owned) });
}
