import type { HarnessName, WriteIsolation } from '../core/types.js';

export const harnessWriteIsolation: Record<HarnessName, WriteIsolation> = {
  codex: 'hard',
  opencode: 'hard',
  hermes: 'degraded',
};
