import type { HarnessName, ResolvedRole } from './types.js';

export function providerFor(role: ResolvedRole, harness: HarnessName): string {
  return role.harnessProviders?.[harness] ?? role.provider;
}
