import type { ResolvedPolicy } from '../core/types.js';
import { compileCodex } from './codex.js';
import { compileHermes } from './hermes.js';
import { compileOpenCode } from './opencode.js';

export type Harness = 'codex' | 'opencode' | 'hermes';

export interface GeneratedFile {
  path: string;
  content: string;
}

export function compileHarness(harness: Harness, policy: ResolvedPolicy): GeneratedFile[] {
  if (harness === 'codex') return compileCodex(policy);
  if (harness === 'opencode') return compileOpenCode(policy);
  return compileHermes(policy);
}
