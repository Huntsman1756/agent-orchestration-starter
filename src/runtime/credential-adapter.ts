import type { ResolvedBindingV4 } from './bindings.js';

export interface CredentialLeaseV4 {
  readonly lease_id: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly provider_endpoint: 'http://provider-gateway:8080/v1';
  readonly internal_network: string;
  readonly expires_at: string;
}

export interface CredentialAdapterV4 {
  lease(binding: ResolvedBindingV4): Promise<CredentialLeaseV4>;
  revoke(leaseId: string): Promise<void>;
}

export function validateCredentialLeaseV4(lease: CredentialLeaseV4, now: string): CredentialLeaseV4 {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(lease.lease_id)
    || !Number.isFinite(Date.parse(lease.expires_at))
    || Date.parse(lease.expires_at) <= Date.parse(now)
    || lease.provider_endpoint !== 'http://provider-gateway:8080/v1'
    || !/^ao-int-exec-[a-z0-9-]{4,80}$/.test(lease.internal_network)) {
    throw new Error('AUTHENTICATION_FAILED: credential lease is invalid or expired');
  }
  const environment: Record<string, string> = {};
  if (Object.keys(lease.environment).length !== 1 || lease.environment.PROVIDER_GATEWAY_TOKEN !== 'broker-gateway') {
    throw new Error('AUTHENTICATION_FAILED: credential lease must expose only the broker gateway token');
  }
  for (const [key, value] of Object.entries(lease.environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)
      || key !== 'PROVIDER_GATEWAY_TOKEN'
      || value.length < 1 || value.length > 16_384 || value.includes('\0')) {
      throw new Error('AUTHENTICATION_FAILED: credential lease environment is invalid');
    }
    environment[key] = value;
  }
  return Object.freeze({ lease_id: lease.lease_id, environment: Object.freeze(environment), provider_endpoint: lease.provider_endpoint, internal_network: lease.internal_network, expires_at: lease.expires_at });
}
