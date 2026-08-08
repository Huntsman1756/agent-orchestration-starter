export type RoleName = 'orchestrator' | 'executor' | 'reviewer';
export type HarnessName = 'codex' | 'opencode' | 'hermes';
export type RoutingStrategy = 'economy_only' | 'orchestrated' | 'frontier_execution';
export type WriteIsolation = 'hard' | 'degraded';

export type HarnessProviders = Partial<Record<HarnessName, string>>;

export interface Policy {
  version: number;
  roles: Record<RoleName, {
    tier: 'frontier' | 'economy';
    capabilities: string[];
    permissions: { read: boolean; write: boolean };
  }>;
  validation: { commands: string[] };
  routing: { strategies: RoutingStrategy[] };
  isolation: { required: WriteIsolation };
}

export interface ModelProfile {
  version: number;
  id: string;
  assignments: Record<RoleName, {
    provider: string;
    harnessProviders?: HarnessProviders;
    model: string;
    tier: 'frontier' | 'economy';
    reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    capabilities: string[];
  }>;
}

export interface ResolvedRole {
  provider: string;
  harnessProviders?: HarnessProviders;
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
  routing: { strategies: RoutingStrategy[] };
  isolation: { required: WriteIsolation };
}
