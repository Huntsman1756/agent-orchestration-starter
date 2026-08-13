import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const runId = z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/);
const uniqueHashes = z.array(hash).max(64).refine((values) => new Set(values).size === values.length, 'hashes must be unique');

const exemptionSchema = z.object({
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  authority_ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/),
  authority_evidence_hash: hash,
}).strict();

const bodySchema = z.object({
  schema_version: z.literal(4),
  kind: z.literal('DELEGATION_PROVENANCE'),
  run_id: runId,
  route: z.enum(['ECONOMY', 'ORCHESTRATED', 'FRONTIER_EXECUTION']),
  disposition: z.enum(['DELEGATED', 'FRONTIER_ONLY_EXEMPTION']),
  contract_hash: hash,
  policy_hash: hash,
  profile_hash: hash,
  worker_capability_hash: hash.nullable(),
  base_sha: sha,
  commit_sha: sha,
  git_tree_sha: sha,
  evidence_tree_hash: hash,
  diff_hash: hash,
  validation_manifest_hash: hash,
  review_attestation_hash: hash,
  accepted_story_receipt_hashes: uniqueHashes,
  frontier_decision_hashes: uniqueHashes,
  exemption: exemptionSchema.nullable(),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.disposition === 'DELEGATED') {
    if (value.route === 'FRONTIER_EXECUTION') context.addIssue({ code: 'custom', message: 'delegated evidence cannot claim the frontier-only route' });
    if (value.worker_capability_hash === null) context.addIssue({ code: 'custom', message: 'delegated evidence requires worker capability identity' });
    if (value.accepted_story_receipt_hashes.length < 1) context.addIssue({ code: 'custom', message: 'delegated evidence requires accepted worker receipts' });
    if (value.exemption !== null) context.addIssue({ code: 'custom', message: 'delegated evidence cannot carry an exemption' });
  } else {
    if (value.route !== 'FRONTIER_EXECUTION') context.addIssue({ code: 'custom', message: 'only frontier execution may use an exemption' });
    if (value.exemption === null) context.addIssue({ code: 'custom', message: 'frontier-only execution requires explicit authority evidence' });
    if (value.accepted_story_receipt_hashes.length !== 0) context.addIssue({ code: 'custom', message: 'frontier-only evidence cannot claim delegated receipts' });
  }
});

const evidenceSchema = bodySchema.and(z.object({
  provenance_hash: hash,
  signer_key_id: hash,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict());

export type DelegationProvenanceBodyV4 = z.input<typeof bodySchema>;
export type DelegationProvenanceV4 = z.infer<typeof evidenceSchema>;

export interface DelegationProvenanceBindingV4 {
  readonly commit_sha: string;
  readonly git_tree_sha: string;
  readonly policy_hash: string;
  readonly profile_hash: string;
}

export interface DelegationProvenanceSignerV4 {
  readonly public_key_spki_der: Uint8Array;
  readonly sign: (payload: Uint8Array) => Uint8Array;
}

function invalid(message: string): never {
  throw new Error(`DELEGATION_PROVENANCE_INVALID: ${message}`);
}

export function createDelegationProvenanceV4(input: Omit<DelegationProvenanceBodyV4, 'schema_version' | 'kind'>, signer: DelegationProvenanceSignerV4): DelegationProvenanceV4 {
  const parsed = bodySchema.safeParse({ schema_version: 4, kind: 'DELEGATION_PROVENANCE', ...input });
  if (!parsed.success) invalid('evidence body is invalid');
  const provenanceHash = hashCanonicalV4(parsed.data);
  const signature = Buffer.from(signer.sign(Buffer.from(provenanceHash, 'hex')));
  if (signature.byteLength !== 64) invalid('host signer returned an invalid Ed25519 signature');
  const signerKeyId = createHash('sha256').update(signer.public_key_spki_der).digest('hex');
  return Object.freeze({ ...parsed.data, provenance_hash: provenanceHash, signer_key_id: signerKeyId, signature: signature.toString('base64') });
}

export function verifyDelegationProvenanceV4(input: unknown, binding: DelegationProvenanceBindingV4, publicKey: string | Uint8Array): DelegationProvenanceV4 {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) invalid('evidence schema is invalid');
  const { provenance_hash: supplied, signer_key_id: signerKeyId, signature, ...body } = parsed.data;
  if (supplied !== hashCanonicalV4(body)) invalid('self-hash does not match');
  let key;
  try { key = createPublicKey(typeof publicKey === 'string' ? publicKey : Buffer.from(publicKey)); } catch { invalid('trusted public key is invalid'); }
  const exported = key.export({ type: 'spki', format: 'der' });
  if (createHash('sha256').update(exported).digest('hex') !== signerKeyId) invalid('signer key identity does not match');
  if (!verify(null, Buffer.from(supplied, 'hex'), key, Buffer.from(signature, 'base64'))) invalid('host signature does not match');
  if (body.commit_sha !== binding.commit_sha || body.git_tree_sha !== binding.git_tree_sha) invalid('commit or tree binding does not match');
  if (body.policy_hash !== binding.policy_hash || body.profile_hash !== binding.profile_hash) invalid('policy or profile binding does not match');
  return Object.freeze(parsed.data);
}
