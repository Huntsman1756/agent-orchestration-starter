import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
const mutableAliases = new Set(['auto', 'current', 'default', 'latest', 'stable']);
const exactRevision = identifier.refine(
  (value) => !mutableAliases.has(value.toLowerCase()),
  'revision must be an exact immutable revision',
);
const uniqueCapabilities = z
  .array(identifier)
  .min(1)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'capabilities must be unique' });
  });

const deploymentSchema = z
  .object({
    provider_ref: identifier,
    model_ref: identifier,
    model_revision: exactRevision,
    model_artifact_hash: hash.nullable(),
    endpoint_revision: exactRevision,
    harness_ref: identifier,
    harness_revision: exactRevision,
    tool_protocol: identifier,
    tool_parser_revision: exactRevision,
    tool_bundle_hash: hash,
    instruction_bundle_hash: hash,
    qualification_evidence_hash: hash,
  })
  .strict();

const limitsSchema = z
  .object({
    max_story_files: z.number().int().min(1).max(64),
    max_story_changed_lines: z.number().int().min(1).max(100_000),
    max_story_context_bytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024),
    max_acceptance_criteria: z.number().int().min(1).max(32),
    max_dependency_depth: z.number().int().min(0).max(32),
    max_steps_per_attempt: z.number().int().min(1).max(128),
    max_attempts: z.number().int().min(1).max(3),
    no_progress_repeat_limit: z.number().int().min(2).max(3),
  })
  .strict();

const bodySchema = z
  .object({
    schema_version: z.literal(4),
    binding_ref: identifier,
    deployment: deploymentSchema,
    capabilities: uniqueCapabilities,
    limits: limitsSchema,
  })
  .strict();

const capabilitySchema = bodySchema.extend({ worker_capability_hash: hash }).strict();

export type WorkerCapabilityBodyV4 = z.input<typeof bodySchema>;
export type WorkerCapabilityV4 = z.infer<typeof capabilitySchema>;

function normalizeBody(value: z.infer<typeof bodySchema>): z.infer<typeof bodySchema> {
  return {
    ...value,
    capabilities: [...value.capabilities].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}

function own(value: z.infer<typeof bodySchema>, workerCapabilityHash: string): WorkerCapabilityV4 {
  return Object.freeze({
    ...value,
    deployment: Object.freeze({ ...value.deployment }),
    capabilities: Object.freeze([...value.capabilities]),
    limits: Object.freeze({ ...value.limits }),
    worker_capability_hash: workerCapabilityHash,
  }) as unknown as WorkerCapabilityV4;
}

export function createWorkerCapabilityV4(input: WorkerCapabilityBodyV4): WorkerCapabilityV4 {
  const body = normalizeBody(bodySchema.parse(structuredClone(input)));
  return own(body, hashCanonicalV4(body));
}

export function loadWorkerCapabilityV4(input: unknown): WorkerCapabilityV4 {
  const capability = capabilitySchema.parse(structuredClone(input));
  const { worker_capability_hash: supplied, ...parsedBody } = capability;
  const body = normalizeBody(parsedBody);
  if (supplied !== hashCanonicalV4(body)) throw new Error('INVALID_CONTRACT: worker capability hash is invalid');
  return own(body, supplied);
}
