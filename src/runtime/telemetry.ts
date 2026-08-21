import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';

export const RUNTIME_EVENT_TYPES_V4 = [
  'RUN_PLANNED',
  'WORKTREE_CREATED',
  'CAPABILITY_CHECKED',
  'EXECUTION_STARTED',
  'EXECUTION_COMPLETED',
  'DIFF_POLICY_CHECKED',
  'VALIDATION_RECORDED',
  'REVIEW_STARTED',
  'REVIEW_COMPLETED',
  'ESCALATION_DECIDED',
  'FINALIZATION_STARTED',
  'COMMIT_CREATED',
  'BRANCH_PUSHED',
  'PULL_REQUEST_RECORDED',
  'REQUIRED_CHECKS_PASSED',
  'RUN_MERGED',
  'PUBLICATION_SKIPPED',
  'RUN_FAILED',
  'RUN_ABORTED',
] as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const finding = z
  .object({ id: z.string().min(1).max(128), severity: z.enum(['low', 'medium', 'high', 'critical']), evidence_hash: hash })
  .strict();
export const runtimeEventV4Schema = z
  .object({
    schema_version: z.literal(4),
    type: z.enum(RUNTIME_EVENT_TYPES_V4),
    event_id: z.string().regex(/^evt_[A-Za-z0-9_-]{16,96}$/),
    run_id: z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/),
    sequence: z.number().int().positive(),
    previous_hash: hash.nullable(),
    recorded_at: z.string().datetime({ offset: false }),
    contract_hash: hash,
    evidence_hashes: z
      .array(hash)
      .max(64)
      .refine((value) => new Set(value).size === value.length, 'evidence hashes must be unique'),
    duration_ms: z.number().int().min(0).max(86_400_000).optional(),
    counters: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
    findings: z
      .array(finding)
      .max(128)
      .refine((value) => new Set(value.map(({ id }) => id)).size === value.length, 'finding IDs must be unique')
      .optional(),
    binding_ref: z.string().min(1).max(128).optional(),
    sandbox_certification_hash: hash.optional(),
    event_hash: hash,
  })
  .strict();

export type RuntimeEventV4 = z.infer<typeof runtimeEventV4Schema>;
export type RuntimeEventDraftV4 = Omit<RuntimeEventV4, 'event_hash'>;

const FORBIDDEN_KEYS = new Set([
  'prompt',
  'response',
  'reasoning',
  'transcript',
  'diff',
  'source',
  'environment',
  'credential',
  'credentials',
  'secret',
  'password',
  'authorization',
  'apikey',
  'token',
  'privatekey',
]);
const CREDENTIALS = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9_]{20,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^eyJ[^.]+\.[^.]+\.[^.]+$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----$/,
];
function safe(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (value.length > 512 || CREDENTIALS.some((pattern) => pattern.test(value)))
      throw new Error('INVALID_CONTRACT: telemetry contains unbounded or credential-shaped text');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('INVALID_CONTRACT: telemetry is cyclic');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`INVALID_CONTRACT: telemetry contains forbidden field ${key}`);
    safe(child, seen);
  }
  seen.delete(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createRuntimeEventV4(draft: RuntimeEventDraftV4): RuntimeEventV4 {
  safe(draft);
  return freeze(runtimeEventV4Schema.parse({ ...structuredClone(draft), event_hash: hashCanonicalV4(draft) }));
}

export function appendRuntimeEventV4(log: readonly RuntimeEventV4[], supplied: RuntimeEventV4): readonly RuntimeEventV4[] {
  safe(supplied);
  const event = runtimeEventV4Schema.parse(structuredClone(supplied));
  const { event_hash: suppliedHash, ...draft } = event;
  if (suppliedHash !== hashCanonicalV4(draft)) throw new Error('EVIDENCE_HASH_MISMATCH: runtime event self-hash is invalid');
  let previous: RuntimeEventV4 | undefined;
  for (const [index, suppliedPrior] of log.entries()) {
    const prior = loadRuntimeEventV4(suppliedPrior);
    if (prior.sequence !== index + 1 || prior.previous_hash !== (previous?.event_hash ?? null))
      throw new Error('BROKER_STATE_CORRUPT: existing runtime telemetry chain is broken');
    if (previous !== undefined && (prior.run_id !== previous.run_id || prior.contract_hash !== previous.contract_hash))
      throw new Error('BROKER_STATE_CORRUPT: runtime telemetry identity changed');
    previous = prior;
  }
  for (const prior of log)
    if (prior.event_id === event.event_id) {
      if (prior.event_hash !== event.event_hash) throw new Error('BROKER_STATE_CORRUPT: runtime event ID collision');
      return log;
    }
  const expectedSequence = log.length + 1;
  const expectedPrevious = log.at(-1)?.event_hash ?? null;
  if (event.sequence !== expectedSequence || event.previous_hash !== expectedPrevious)
    throw new Error('BROKER_STATE_CORRUPT: runtime telemetry chain is broken');
  if (previous !== undefined && (event.run_id !== previous.run_id || event.contract_hash !== previous.contract_hash))
    throw new Error('BROKER_STATE_CORRUPT: runtime telemetry identity changed');
  return Object.freeze([...log, freeze(event)]);
}

export function loadRuntimeEventV4(value: unknown): RuntimeEventV4 {
  safe(value);
  const event = runtimeEventV4Schema.parse(structuredClone(value));
  const { event_hash: supplied, ...draft } = event;
  if (supplied !== hashCanonicalV4(draft)) throw new Error('EVIDENCE_HASH_MISMATCH: runtime event self-hash is invalid');
  return freeze(event);
}
