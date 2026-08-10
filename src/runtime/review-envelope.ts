import { hashCanonicalV4 } from './canonical.js';
import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';
import type { ReviewFindingV4, RuntimeWorkContractV4 } from './contracts.js';
import { loadRuntimeWorkContractV4 } from './load.js';

export interface ReviewValidationEvidenceV4 {
  readonly validation_id: string;
  readonly passed: boolean;
  readonly result_hash: string;
  readonly validated_tree_hash: string;
}

export interface ReviewEnvelopeInputV4 {
  readonly contract: RuntimeWorkContractV4;
  readonly complete_diff: string;
  readonly changed_files: readonly string[];
  readonly diff_hash: string;
  readonly tree_hash: string;
  readonly validation_results: readonly ReviewValidationEvidenceV4[];
  readonly unresolved_findings: readonly ReviewFindingV4[];
}

export interface ReviewEnvelopeV4 {
  readonly schema_version: 4;
  readonly contract: RuntimeWorkContractV4;
  readonly base_sha: string;
  readonly complete_diff: string;
  readonly changed_files: readonly string[];
  readonly validation_manifest: readonly ReviewValidationEvidenceV4[];
  readonly validation_manifest_hash: string;
  readonly tree_hash: string;
  readonly diff_hash: string;
  readonly unresolved_findings: readonly ReviewFindingV4[];
  readonly envelope_hash: string;
}

function invalid(message: string): never { throw new Error(`REVIEW_ATTESTATION_INVALID: ${message}`); }
function hash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildReviewEnvelope(input: ReviewEnvelopeInputV4): ReviewEnvelopeV4 {
  const expected = ['changed_files', 'complete_diff', 'contract', 'diff_hash', 'tree_hash', 'unresolved_findings', 'validation_results'];
  const keys = Object.keys(input).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid('review envelope input contains hidden context');
  if (!hash(input.diff_hash) || !hash(input.tree_hash) || Buffer.byteLength(input.complete_diff, 'utf8') > 2 * 1024 * 1024
    || input.changed_files.length > 256 || new Set(input.changed_files.map((path) => path.toLowerCase())).size !== input.changed_files.length
    || input.changed_files.some((path) => !isNormalizedRepositoryRelativePathV4(path))
    || input.validation_results.length < 1 || input.validation_results.length > 64
    || new Set(input.validation_results.map((result) => result.validation_id)).size !== input.validation_results.length
    || input.validation_results.some((result) => !result.passed || !hash(result.result_hash) || result.validated_tree_hash !== input.tree_hash)
    || input.unresolved_findings.length > 128 || new Set(input.unresolved_findings.map((finding) => finding.id)).size !== input.unresolved_findings.length) invalid('review evidence is malformed or mismatched');
  let contract: RuntimeWorkContractV4;
  try { contract = deepFreeze(loadRuntimeWorkContractV4(structuredClone(input.contract))); } catch { return invalid('work contract is not strict V4 evidence'); }
  const { contract_hash: suppliedContractHash, ...contractBody } = contract;
  if (suppliedContractHash !== hashCanonicalV4(contractBody)) invalid('work contract hash is forged');
  const changedFiles = Object.freeze([...input.changed_files]);
  const validationManifest = deepFreeze(structuredClone(input.validation_results));
  const unresolvedFindings = deepFreeze(structuredClone(input.unresolved_findings));
  const validationManifestHash = hashCanonicalV4({ schema_version: 4, results: validationManifest });
  const body = { schema_version: 4 as const, contract, base_sha: contract.base_sha, complete_diff: input.complete_diff, changed_files: changedFiles, validation_manifest: validationManifest, validation_manifest_hash: validationManifestHash, tree_hash: input.tree_hash, diff_hash: input.diff_hash, unresolved_findings: unresolvedFindings };
  return deepFreeze({ ...body, envelope_hash: hashCanonicalV4(body) });
}
