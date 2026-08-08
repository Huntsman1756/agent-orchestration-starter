export type RoutingStrategy = 'economy_only' | 'orchestrated' | 'frontier_execution';
export type RoutingDecision = 'promote' | 'reject' | 'insufficient_evidence';

export interface TokenUsage {
  input: number;
  output: number;
}

export type DefectSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface PostAcceptanceDefect {
  severity: DefectSeverity;
  description: string;
}

export interface BenchmarkObservation {
  schemaVersion: 2;
  taskId: string;
  caseFingerprint: string;
  taskClass: string;
  attemptedRoute: RoutingStrategy;
  firstPassAccepted: boolean;
  finalAccepted: boolean;
  totalCostUsd: number;
  latencyMs: number;
  repairCount: number;
  escalated: boolean;
  postAcceptanceDefective: boolean;
  postAcceptanceDefects: PostAcceptanceDefect[];
  frontierTokens: TokenUsage;
  economyTokens: TokenUsage;
}

export interface RoutingGatePolicy {
  schemaVersion: 2;
  baselineRoute: RoutingStrategy;
  candidateRoutes: RoutingStrategy[];
  minPairedSamplesPerRoute: number;
  minAcceptedTaskCostSavingsRate: number;
  maxFirstPassAcceptanceDropRate: number;
  maxFinalAcceptanceDropRate: number;
  maxEscalationRate: number;
  maxPostAcceptanceDefectIncidenceRate: number;
  maxHighSeverityPostAcceptanceDefects: number;
  maxCriticalSeverityPostAcceptanceDefects: number;
}

export interface RouteMetrics {
  samples: number;
  firstPassAcceptanceRate: number;
  finalAcceptanceRate: number;
  acceptedTaskCostUsd: number | null;
  escalationRate: number;
  postAcceptanceDefectIncidenceRate: number;
  postAcceptanceDefectCount: number;
  postAcceptanceDefectsBySeverity: Record<DefectSeverity, number>;
  totalCostUsd: number;
  totalLatencyMs: number;
  totalRepairs: number;
  frontierTokens: TokenUsage;
  economyTokens: TokenUsage;
}

export interface RouteDecision {
  taskClass: string;
  candidateRoute: RoutingStrategy;
  baselineRoute: RoutingStrategy;
  pairedSamples: number;
  decision: RoutingDecision;
  reasons: string[];
  candidate: RouteMetrics;
  baseline: RouteMetrics;
}

export interface RoutingReport {
  schemaVersion: 2;
  decisions: RouteDecision[];
}
