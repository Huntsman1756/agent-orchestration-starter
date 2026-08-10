import { hashCanonicalV4 } from './canonical.js';
import type { ReviewAttestationV4 } from './contracts.js';
import { loadReviewAttestationV4 } from './load.js';

export interface AttestationCurrentEvidenceV4 {
  readonly contract_hash: string;
  readonly base_sha: string;
  readonly tree_hash: string;
  readonly diff_hash: string;
  readonly validation_manifest_hash: string;
  readonly allowed_session_id: string;
  readonly prior_session_ids: readonly string[];
}
export interface AttestationVerificationInputV4 { readonly attestation: unknown; readonly current: AttestationCurrentEvidenceV4; }

function invalid(message: string): never { throw new Error(`REVIEW_ATTESTATION_INVALID: ${message}`); }
export function verifyReviewAttestation(input: AttestationVerificationInputV4): ReviewAttestationV4 {
  let attestation: ReviewAttestationV4;
  try { attestation = loadReviewAttestationV4(structuredClone(input.attestation)); } catch { return invalid('attestation does not match the strict contract'); }
  const { attestation_hash: supplied, ...body } = attestation;
  const findingIds = new Set(attestation.findings.map((finding) => finding.id));
  if (supplied !== hashCanonicalV4(body)
    || attestation.contract_hash !== input.current.contract_hash || attestation.base_sha !== input.current.base_sha
    || attestation.reviewed_tree_hash !== input.current.tree_hash || attestation.reviewed_diff_hash !== input.current.diff_hash
    || attestation.validation_manifest_hash !== input.current.validation_manifest_hash
    || attestation.reviewer_session_id !== input.current.allowed_session_id
    || input.current.prior_session_ids.includes(attestation.reviewer_session_id)
    || findingIds.size !== attestation.findings.length
    || attestation.unresolved_finding_ids.some((id) => !findingIds.has(id))
    || (attestation.decision === 'REJECT' && attestation.unresolved_finding_ids.length === 0)
    || (attestation.decision === 'REQUEST_CONTEXT' && attestation.requested_context_hashes.length === 0)
    || (attestation.decision === 'ACCEPT' && (attestation.unresolved_finding_ids.length > 0 || attestation.requested_context_hashes.length > 0))) invalid('attestation is stale, forged, reused, or mismatched');
  return Object.freeze({ ...attestation, findings: Object.freeze([...attestation.findings]), requested_context_hashes: Object.freeze([...attestation.requested_context_hashes]), unresolved_finding_ids: Object.freeze([...attestation.unresolved_finding_ids]) });
}
