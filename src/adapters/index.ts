import type { HarnessName, ResolvedPolicy } from '../core/types.js';
import { compileCodex } from './codex.js';
import { compileHermes } from './hermes.js';
import { compileOpenCode } from './opencode.js';
import { harnessWriteIsolation } from './capabilities.js';

export type Harness = HarnessName;

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface CompileOptions {
  acceptDegradedIsolation?: Harness[];
}

export function compileHarness(harness: Harness, policy: ResolvedPolicy, options: CompileOptions = {}): GeneratedFile[] {
  const effectiveIsolation = harnessWriteIsolation[harness];
  if (
    policy.isolation.required === 'hard'
    && effectiveIsolation === 'degraded'
    && !options.acceptDegradedIsolation?.includes(harness)
  ) {
    throw new Error(`hard write isolation required; ${harness} provides degraded isolation and requires explicit acceptance`);
  }
  if (harness === 'codex') return compileCodex(policy, effectiveIsolation);
  if (harness === 'opencode') return compileOpenCode(policy, effectiveIsolation);
  return compileHermes(policy, effectiveIsolation);
}
