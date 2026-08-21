import type { AutonomousPostMergeVerifierV4, AutonomousTaskCandidateV4, AutonomousTaskSourceV4 } from './autonomous-dispatcher.js';
import type { CapabilityProbeInputV4, CapabilityRecordV4 } from './capabilities.js';
import type { RuntimeTaskRequestV4 } from './contracts.js';
import type { CredentialLeaseV4 } from './credential-adapter.js';
import type { ResolvedBindingV4 } from './bindings.js';
import { runtimeHostComponentPortMembersV4, type RuntimeHostComponentIdV4 } from './host-components.js';
import type { ProcessSandboxBackendV4 } from './process-sandbox.js';
import type { PublicationAdapterV4 } from './publication.js';

export interface RuntimeIssuePlannerPortV4 {
  plan(candidate: AutonomousTaskCandidateV4): Promise<RuntimeTaskRequestV4>;
}

export interface RuntimePracticePackResolutionInputV4 {
  readonly request: RuntimeTaskRequestV4;
  readonly repository_root: string;
  readonly base_sha: string;
  readonly policy_hash: string;
  readonly profile_hash: string;
}

export interface RuntimePracticePackResolutionV4 {
  readonly resolver_revision: string;
  readonly stack_evidence_hash: string;
  readonly selected_pack_hashes: readonly string[];
  readonly instruction_bundle_hash: string;
  readonly required_capabilities: readonly string[];
  readonly resolution_hash: string;
}

export interface RuntimePracticePackResolverPortV4 {
  resolve(input: RuntimePracticePackResolutionInputV4): Promise<RuntimePracticePackResolutionV4>;
}

export interface RuntimeCapabilityIssuerPortV4 {
  issue(input: CapabilityProbeInputV4): Promise<CapabilityRecordV4>;
}

export type RuntimeGitHubCredentialPurposeV4 = 'TASK_INTAKE' | 'PUBLICATION' | 'POST_MERGE_VERIFICATION';
export type RuntimeGitHubCredentialOperationV4 =
  'ISSUES_READ' | 'ISSUES_WRITE' | 'CONTENTS_READ' | 'CONTENTS_WRITE' | 'PULL_REQUESTS_WRITE' | 'CHECKS_READ';

export interface RuntimeGitHubCredentialLeaseV4 {
  readonly lease_id: string;
  readonly repository_id: string;
  readonly remote: string;
  readonly environment: Readonly<{ GITHUB_GATEWAY_TOKEN: 'broker-gateway' }>;
  readonly gateway_endpoint: 'http://github-gateway:8081';
  readonly internal_network: string;
  readonly expires_at: string;
}

export interface RuntimeCredentialGatewayPortV4 {
  leaseProvider(binding: ResolvedBindingV4): Promise<CredentialLeaseV4>;
  leaseGitHub(input: {
    readonly purpose: RuntimeGitHubCredentialPurposeV4;
    readonly repository_id: string;
    readonly remote: string;
    readonly operations: readonly RuntimeGitHubCredentialOperationV4[];
  }): Promise<RuntimeGitHubCredentialLeaseV4>;
  revoke(leaseId: string): Promise<void>;
}

function authenticationFailed(message: string): never {
  throw new Error(`AUTHENTICATION_FAILED: ${message}`);
}

export function validateRuntimeGitHubCredentialLeaseV4(lease: RuntimeGitHubCredentialLeaseV4, now: string): RuntimeGitHubCredentialLeaseV4 {
  if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) authenticationFailed('GitHub credential lease is invalid');
  const candidate = lease as unknown as Record<string, unknown>;
  const expected = ['lease_id', 'repository_id', 'remote', 'environment', 'gateway_endpoint', 'internal_network', 'expires_at'];
  if (Object.keys(candidate).sort().join(',') !== expected.sort().join(','))
    authenticationFailed('GitHub credential lease has unknown or missing fields');
  if (
    typeof lease.lease_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(lease.lease_id) ||
    typeof lease.repository_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(lease.repository_id) ||
    typeof lease.remote !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(lease.remote) ||
    lease.gateway_endpoint !== 'http://github-gateway:8081' ||
    typeof lease.internal_network !== 'string' ||
    !/^ao-int-github-[a-z0-9-]{4,80}$/u.test(lease.internal_network) ||
    typeof lease.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(lease.expires_at) <= Date.parse(now)
  ) {
    authenticationFailed('GitHub credential lease is invalid or expired');
  }
  if (
    lease.environment === null ||
    typeof lease.environment !== 'object' ||
    Array.isArray(lease.environment) ||
    Object.keys(lease.environment).join(',') !== 'GITHUB_GATEWAY_TOKEN' ||
    lease.environment.GITHUB_GATEWAY_TOKEN !== 'broker-gateway'
  ) {
    authenticationFailed('GitHub credential lease must expose only the broker gateway token');
  }
  return Object.freeze({
    lease_id: lease.lease_id,
    repository_id: lease.repository_id,
    remote: lease.remote,
    environment: Object.freeze({ GITHUB_GATEWAY_TOKEN: 'broker-gateway' as const }),
    gateway_endpoint: lease.gateway_endpoint,
    internal_network: lease.internal_network,
    expires_at: lease.expires_at,
  });
}

export interface RuntimeHostComponentSetV4 {
  readonly task_source: AutonomousTaskSourceV4;
  readonly issue_planner: RuntimeIssuePlannerPortV4;
  readonly practice_pack_resolver: RuntimePracticePackResolverPortV4;
  readonly credential_gateway: RuntimeCredentialGatewayPortV4;
  readonly sandbox_coordinator: ProcessSandboxBackendV4;
  readonly capability_issuer: RuntimeCapabilityIssuerPortV4;
  readonly github_publisher: PublicationAdapterV4;
  readonly post_merge_verifier: AutonomousPostMergeVerifierV4;
}

export type RuntimeHostComponentPortV4 = RuntimeHostComponentSetV4[RuntimeHostComponentIdV4];

function unavailable(message: string): never {
  throw new Error(`CAPABILITY_UNVERIFIED: ${message}`);
}

export function validateRuntimeHostComponentPortV4(id: RuntimeHostComponentIdV4, value: unknown): RuntimeHostComponentPortV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable(`host component ${id} returned an invalid port`);
  const candidate = value as Record<string, unknown>;
  const members = runtimeHostComponentPortMembersV4(id);
  if (
    Object.keys(candidate).sort().join(',') !==
    members
      .map((member) => member.name)
      .sort()
      .join(',')
  )
    unavailable(`host component ${id} exposed an invalid port surface`);
  for (const member of members) {
    if (typeof candidate[member.name] !== member.kind) unavailable(`host component ${id} exposed an invalid ${member.name} member`);
    if (member.kind === 'string' && String(candidate[member.name]).length === 0)
      unavailable(`host component ${id} exposed an empty ${member.name} member`);
  }
  return Object.freeze(candidate) as unknown as RuntimeHostComponentPortV4;
}
