import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';
import { normalizedRepositoryRelativePathV4Schema } from './contract-schemas.js';
import { EconomyPolicyViolationErrorV4 } from './diff-policy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
const findingSchema = z.object({
  finding_id: identifier,
  source: z.enum(['VALIDATION', 'REVIEW']),
  category_code: identifier,
  path: normalizedRepositoryRelativePathV4Schema.max(512).nullable(),
  line: z.number().int().min(1).max(10_000_000).nullable(),
  instruction: z.string().min(1).max(512),
  evidence_hash: hash,
}).strict().superRefine((value, context) => {
  if (value.path === null && value.line !== null) context.addIssue({ code: 'custom', message: 'finding line requires a path' });
});
const failureSignatureFindingSchema = z.object({
  source: z.enum(['VALIDATION', 'REVIEW']),
  category_code: identifier,
  path: normalizedRepositoryRelativePathV4Schema.max(512).nullable(),
}).strict();

const bodySchema = z.object({
  schema_version: z.literal(4),
  story_id: z.string().regex(/^story_[A-Za-z0-9_-]{4,96}$/),
  failed_attempt: z.number().int().min(1).max(3),
  findings: z.array(findingSchema).min(1).max(32).superRefine((values, context) => {
    if (new Set(values.map((value) => value.finding_id)).size !== values.length) context.addIssue({ code: 'custom', message: 'finding IDs must be unique' });
    if (new Set(values.map((value) => value.evidence_hash)).size !== values.length) context.addIssue({ code: 'custom', message: 'finding evidence must be unique' });
  }),
}).strict();
const packetSchema = bodySchema.extend({ packet_hash: hash }).strict();

export type RepairPacketV4 = z.infer<typeof packetSchema>;
export type FailureSignatureFindingV4 = z.infer<typeof failureSignatureFindingSchema>;

export function createNormalizedFailureSignatureV4<T extends FailureSignatureFindingV4>(findings: readonly T[]): string {
  const projected = findings.map((finding) => ({ source: finding.source, category_code: finding.category_code, path: finding.path }));
  const parsed = z.array(failureSignatureFindingSchema).min(1).max(128).parse(structuredClone(projected));
  const canonical = [...new Map(parsed.map((finding) => [JSON.stringify(finding), finding])).values()]
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return hashCanonicalV4({ schema_version: 4, findings: canonical });
}

export function loadRepairPacketV4(input: unknown): RepairPacketV4 {
  const packet = packetSchema.parse(structuredClone(input));
  const { packet_hash: supplied, ...body } = packet;
  if (supplied !== hashCanonicalV4(body)) throw new Error('INVALID_CONTRACT: repair packet hash is invalid');
  return Object.freeze({
    ...packet,
    findings: Object.freeze(packet.findings.map((finding) => Object.freeze({ ...finding }))),
  }) as unknown as RepairPacketV4;
}

export function createEconomyPolicyRepairPacketV4(input: {
  readonly story_id: string;
  readonly failed_attempt: number;
  readonly violation: EconomyPolicyViolationErrorV4;
}): RepairPacketV4 {
  const body = {
    schema_version: 4 as const,
    story_id: input.story_id,
    failed_attempt: input.failed_attempt,
    findings: [{
      finding_id: `economy-policy-${input.violation.evidence_hash.slice(0, 24)}`,
      source: 'VALIDATION' as const,
      category_code: 'economy_policy_violation',
      path: input.violation.violation_path,
      line: null,
      instruction: input.violation.repair_instruction,
      evidence_hash: input.violation.evidence_hash,
    }],
  };
  return loadRepairPacketV4({ ...body, packet_hash: hashCanonicalV4(body) });
}
