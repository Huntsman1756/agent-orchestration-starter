import { hashCanonicalV4 } from './canonical.js';

export interface CapabilityIdentityV4 {
  readonly profile_hash: string;
  readonly harness: string;
  readonly harness_version: string;
  readonly agent_policy_hash: string;
  readonly broker_version: string;
  readonly probe_version: number;
}

export interface CapabilityProbeEvidenceV4 {
  readonly structured_result: boolean;
  readonly exact_bounded_edit: boolean;
  readonly multi_step_file_tools: boolean;
  readonly repair_from_validation_evidence: boolean;
  readonly shell_used: boolean;
  readonly transcript_hash: string;
}

export interface CapabilityRecordV4 {
  readonly schema_version: 4;
  readonly identity: CapabilityIdentityV4;
  readonly status: 'VERIFIED' | 'UNQUALIFIED';
  readonly clean_runs: number;
  readonly probe_evidence_hashes: readonly string[];
  readonly evidence_hash: string;
  readonly probed_at: string;
  readonly expires_at: string;
}

export interface CapabilityProbeInputV4 {
  readonly identity: CapabilityIdentityV4;
  readonly probed_at: string;
  readonly ttl_seconds: number;
  readonly run_probe: (iteration: number) => Promise<CapabilityProbeEvidenceV4>;
}

function unverified(message: string): never { throw new Error(`CAPABILITY_UNVERIFIED: ${message}`); }
function validHash(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }

function validateIdentity(identity: CapabilityIdentityV4): void {
  if (!validHash(identity.profile_hash) || !validHash(identity.agent_policy_hash)
    || !/^[a-z][a-z0-9_-]{0,63}$/.test(identity.harness)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(identity.harness_version)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(identity.broker_version)
    || !Number.isSafeInteger(identity.probe_version) || identity.probe_version < 1) unverified('capability identity is invalid');
}

export async function probeRuntimeBinding(input: CapabilityProbeInputV4): Promise<CapabilityRecordV4> {
  validateIdentity(input.identity);
  const probedAt = Date.parse(input.probed_at);
  if (!Number.isFinite(probedAt) || !Number.isSafeInteger(input.ttl_seconds) || input.ttl_seconds < 1 || input.ttl_seconds > 86_400) {
    unverified('probe time-to-live is invalid');
  }
  const runs: CapabilityProbeEvidenceV4[] = [];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const evidence = await input.run_probe(iteration);
    if (!evidence.structured_result || !evidence.exact_bounded_edit || !evidence.multi_step_file_tools
      || !evidence.repair_from_validation_evidence || evidence.shell_used || !validHash(evidence.transcript_hash)) {
      unverified('probe did not demonstrate every required capability');
    }
    runs.push(Object.freeze({ ...evidence }));
  }
  const probeEvidenceHashes = Object.freeze(runs.map((run) => hashCanonicalV4(run)));
  const expiresAt = new Date(probedAt + input.ttl_seconds * 1000).toISOString();
  const evidenceHash = hashCanonicalV4({ schema_version: 4, identity: input.identity, probe_evidence_hashes: probeEvidenceHashes });
  return Object.freeze({
    schema_version: 4,
    identity: Object.freeze({ ...input.identity }),
    status: 'VERIFIED',
    clean_runs: 3,
    probe_evidence_hashes: probeEvidenceHashes,
    evidence_hash: evidenceHash,
    probed_at: new Date(probedAt).toISOString(),
    expires_at: expiresAt,
  });
}

export function assertFreshCapability(record: CapabilityRecordV4, expected: CapabilityIdentityV4, now = new Date().toISOString()): void {
  validateIdentity(expected);
  const evidenceHash = hashCanonicalV4({ schema_version: 4, identity: record.identity, probe_evidence_hashes: record.probe_evidence_hashes });
  if (record.schema_version !== 4 || record.status !== 'VERIFIED' || record.clean_runs !== 3
    || record.probe_evidence_hashes.length !== 3 || !record.probe_evidence_hashes.every(validHash)
    || record.evidence_hash !== evidenceHash || hashCanonicalV4(record.identity) !== hashCanonicalV4(expected)
    || !Number.isFinite(Date.parse(record.probed_at)) || !Number.isFinite(Date.parse(record.expires_at))
    || !Number.isFinite(Date.parse(now)) || Date.parse(record.expires_at) <= Date.parse(now) || Date.parse(record.probed_at) > Date.parse(now)) {
    unverified('qualification record is stale or does not match the selected binding');
  }
}

export function liveProviderProbesEnabledV4(environment: NodeJS.ProcessEnv): boolean {
  return environment.AO_LIVE_PROVIDER_PROBES === '1';
}
