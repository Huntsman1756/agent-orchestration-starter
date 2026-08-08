import type {
  BenchmarkObservation,
  RouteDecision,
  RouteMetrics,
  RoutingGatePolicy,
  RoutingReport,
  RoutingStrategy,
} from './types.js';

function metrics(observations: BenchmarkObservation[]): RouteMetrics {
  const samples = observations.length;
  const firstPassAccepted = observations.filter((item) => item.firstPassAccepted).length;
  const finalAccepted = observations.filter((item) => item.finalAccepted).length;
  const totalCostUsd = observations.reduce((sum, item) => sum + item.totalCostUsd, 0);
  const postAcceptanceDefects = observations.reduce((sum, item) => sum + item.postAcceptanceDefects, 0);
  const tokenTotal = (kind: 'frontierTokens' | 'economyTokens') => observations.reduce(
    (sum, item) => ({ input: sum.input + item[kind].input, output: sum.output + item[kind].output }),
    { input: 0, output: 0 },
  );
  return {
    samples,
    firstPassAcceptanceRate: samples === 0 ? 0 : firstPassAccepted / samples,
    finalAcceptanceRate: samples === 0 ? 0 : finalAccepted / samples,
    acceptedTaskCostUsd: finalAccepted === 0 ? null : totalCostUsd / finalAccepted,
    escalationRate: samples === 0 ? 0 : observations.filter((item) => item.escalated).length / samples,
    postAcceptanceDefectRate: finalAccepted === 0 ? 0 : postAcceptanceDefects / finalAccepted,
    totalCostUsd,
    totalLatencyMs: observations.reduce((sum, item) => sum + item.latencyMs, 0),
    totalRepairs: observations.reduce((sum, item) => sum + item.repairCount, 0),
    frontierTokens: tokenTotal('frontierTokens'),
    economyTokens: tokenTotal('economyTokens'),
  };
}

function routeObservations(
  observations: BenchmarkObservation[],
  taskClass: string,
  route: RoutingStrategy,
): BenchmarkObservation[] {
  return observations.filter((item) => item.taskClass === taskClass && item.attemptedRoute === route);
}

export function evaluateRouting(observations: BenchmarkObservation[], policy: RoutingGatePolicy): RoutingReport {
  const taskClasses = [...new Set(observations.map((item) => item.taskClass))].sort();
  const decisions: RouteDecision[] = [];
  for (const taskClass of taskClasses) {
    for (const candidateRoute of policy.candidateRoutes) {
      const candidate = metrics(routeObservations(observations, taskClass, candidateRoute));
      const baseline = metrics(routeObservations(observations, taskClass, policy.baselineRoute));
      const reasons: string[] = [];
      if (candidate.samples < policy.minSamplesPerRoute) reasons.push('candidate_sample_below_minimum');
      if (baseline.samples < policy.minSamplesPerRoute) reasons.push('baseline_sample_below_minimum');
      const insufficientEvidence = reasons.length > 0;
      if (!insufficientEvidence) {
        const savingsRate = candidate.acceptedTaskCostUsd === null || baseline.acceptedTaskCostUsd === null || baseline.acceptedTaskCostUsd === 0
          ? Number.NEGATIVE_INFINITY
          : 1 - (candidate.acceptedTaskCostUsd / baseline.acceptedTaskCostUsd);
        if (savingsRate < policy.minAcceptedTaskCostSavingsRate) {
          reasons.push('accepted_task_cost_savings_below_minimum');
        }
        if (
          baseline.firstPassAcceptanceRate - candidate.firstPassAcceptanceRate
          > policy.maxFirstPassAcceptanceDropRate
        ) {
          reasons.push('first_pass_acceptance_drop_above_maximum');
        }
        if (candidate.escalationRate > policy.maxEscalationRate) {
          reasons.push('escalation_rate_above_maximum');
        }
        if (candidate.postAcceptanceDefectRate > policy.maxPostAcceptanceDefectRate) {
          reasons.push('post_acceptance_defect_rate_above_maximum');
        }
      }
      decisions.push({
        taskClass,
        candidateRoute,
        baselineRoute: policy.baselineRoute,
        decision: insufficientEvidence ? 'insufficient_evidence' : reasons.length > 0 ? 'reject' : 'promote',
        reasons,
        candidate,
        baseline,
      });
    }
  }
  return { schemaVersion: 1, decisions };
}
