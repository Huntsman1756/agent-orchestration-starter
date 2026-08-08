export type RoleName = 'orchestrator' | 'executor' | 'reviewer';

export interface Policy {
  version: number;
  roles: Record<RoleName, {
    tier: 'frontier' | 'economy';
    capabilities: string[];
    permissions: { read: boolean; write: boolean };
  }>;
  validation: { commands: string[] };
}

export interface ModelProfile {
  version: number;
  id: string;
  assignments: Record<RoleName, {
    provider: string;
    model: string;
    tier: 'frontier' | 'economy';
    reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    capabilities: string[];
  }>;
}

export interface ResolvedRole {
  provider: string;
  model: string;
  modelRef: string;
  tier: 'frontier' | 'economy';
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  capabilities: string[];
  permissions: { read: boolean; write: boolean };
}

export interface ResolvedPolicy {
  policyVersion: number;
  profileVersion: number;
  profileId: string;
  roles: Record<RoleName, ResolvedRole>;
  validation: { commands: string[] };
}
