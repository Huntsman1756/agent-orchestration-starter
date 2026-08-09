import { hashCanonicalV4 } from './canonical.js';
import type { SandboxProfileV4 } from './process-sandbox.js';

export const REQUIRED_SANDBOX_EFFECTS_V4 = Object.freeze([
  'outside_sentinel_blocked',
  'host_home_blocked',
  'credential_environment_blocked',
  'credential_argv_blocked',
  'credential_files_blocked',
  'descendant_state_blocked',
  'outside_write_blocked',
  'pid_limit_enforced',
  'timeout_tree_killed',
  'docker_socket_blocked',
  'loopback_blocked',
  'gateway_allowlisted_success',
  'gateway_non_allowlisted_blocked',
  'direct_ip_blocked',
  'gateway_credential_separated',
  'gateway_no_repository_mount',
  'metadata_only_logs',
] as const);

export type SandboxHostileEffectV4 = (typeof REQUIRED_SANDBOX_EFFECTS_V4)[number];

export interface SandboxCertificationIdentityV4 {
  readonly backend_id: 'docker-engine-linux-v4';
  readonly docker_server_id: string;
  readonly docker_server_version: string;
  readonly docker_server_os: 'linux';
  readonly docker_server_architecture: string;
  readonly image_id: `sha256:${string}`;
  readonly image_os: 'linux';
  readonly image_architecture: string;
  readonly profile: SandboxProfileV4;
  readonly policy_hash: `sha256:${string}`;
  readonly broker_version: string;
}

export interface SandboxCertificationV4 {
  readonly identity: SandboxCertificationIdentityV4;
  readonly evidence_hash: `sha256:${string}`;
  readonly certified_at: string;
  readonly expires_at: string;
  readonly certification_hash: `sha256:${string}`;
}

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

function certificationPayload(record: Omit<SandboxCertificationV4, 'certification_hash'>): unknown {
  return {
    certified_at: record.certified_at,
    evidence_hash: record.evidence_hash,
    expires_at: record.expires_at,
    identity: record.identity,
  };
}

export function createSandboxCertificationV4(
  identity: SandboxCertificationIdentityV4,
  effects: Readonly<Partial<Record<SandboxHostileEffectV4, boolean>>>,
  ttlSeconds: number,
  now: string,
): SandboxCertificationV4 {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) unavailable();
  const certifiedAt = new Date(now);
  if (!Number.isFinite(certifiedAt.getTime()) || certifiedAt.toISOString() !== now) unavailable();
  if (REQUIRED_SANDBOX_EFFECTS_V4.some((effect) => effects[effect] !== true)) unavailable();
  const normalizedEffects = Object.freeze(Object.fromEntries(
    REQUIRED_SANDBOX_EFFECTS_V4.map((effect) => [effect, true]),
  )) as Readonly<Record<SandboxHostileEffectV4, true>>;
  const record = {
    identity: Object.freeze({ ...identity }),
    evidence_hash: `sha256:${hashCanonicalV4(normalizedEffects)}` as const,
    certified_at: now,
    expires_at: new Date(certifiedAt.getTime() + ttlSeconds * 1_000).toISOString(),
  };
  return Object.freeze({
    ...record,
    certification_hash: `sha256:${hashCanonicalV4(certificationPayload(record))}`,
  });
}

export function matchesSandboxCertificationV4(
  certification: SandboxCertificationV4,
  identity: SandboxCertificationIdentityV4,
  now: string,
): boolean {
  const checkedAt = new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  if (checkedAt.getTime() > new Date(certification.expires_at).getTime()) return false;
  if (hashCanonicalV4(certification.identity) !== hashCanonicalV4(identity)) return false;
  const expectedHash = `sha256:${hashCanonicalV4(certificationPayload(certification))}`;
  return certification.certification_hash === expectedHash;
}
