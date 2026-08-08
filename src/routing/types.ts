export type RoutingStrategy = 'economy_only' | 'orchestrated' | 'frontier_execution';
export type RoutingDecision = 'promote' | 'reject' | 'insufficient_evidence';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface BenchmarkObservation {
  schemaVersion: 1;
  taskId: string;
  taskClass: string;
  attemptedRoute: RoutingStrategy;
  firstPassAccepted: boolean;
  finalAccepted: boolean;
  totalCostUsd: number;
  latencyMs: number;
  repairCount: number;
  escalated: boolean;
  postAcceptanceDefects: number;
  frontierTokens: TokenUsage;
  economyTokens: TokenUsage;
}

export interface RoutingGatePolicy {
  schemaVersion: 1;
  baselineRoute: RoutingStrategy;
  candidateRoutes: RoutingStrategy[];
  minPairedSamplesPerRoute: number;
  minAcceptedTaskCostSavingsRate: number;
  maxFirstPassAcceptanceDropRate: number;
  maxFinalAcceptanceDropRate: number;
  maxEscalationRate: number;
  maxPostAcceptanceDefectRate: number;
}

export interface RouteMetrics {
  samples: number;
  firstPassAcceptanceRate: number;
  finalAcceptanceRate: number;
  acceptedTaskCostUsd: number | null;
  escalationRate: number;
  postAcceptanceDefectRate: number;
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
  schemaVersion: 1;
  decisions: RouteDecision[];
}
