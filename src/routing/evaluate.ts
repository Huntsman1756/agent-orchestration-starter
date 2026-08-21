import type { BenchmarkObservation, RouteDecision, RouteMetrics, RoutingGatePolicy, RoutingReport, RoutingStrategy } from './types.js';

function metrics(observations: BenchmarkObservation[]): RouteMetrics {
  const samples = observations.length;
  const firstPassAccepted = observations.filter((item) => item.firstPassAccepted).length;
  const finalAccepted = observations.filter((item) => item.finalAccepted).length;
  const totalCostUsd = observations.reduce((sum, item) => sum + item.totalCostUsd, 0);
  const defectIncidents = observations.filter((item) => item.postAcceptanceDefective).length;
  const defects = observations.flatMap((item) => item.postAcceptanceDefects);
  const postAcceptanceDefectsBySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const defect of defects) postAcceptanceDefectsBySeverity[defect.severity] += 1;
  const tokenTotal = (kind: 'frontierTokens' | 'economyTokens') =>
    observations.reduce((sum, item) => ({ input: sum.input + item[kind].input, output: sum.output + item[kind].output }), {
      input: 0,
      output: 0,
    });
  return {
    samples,
    firstPassAcceptanceRate: samples === 0 ? 0 : firstPassAccepted / samples,
    finalAcceptanceRate: samples === 0 ? 0 : finalAccepted / samples,
    acceptedTaskCostUsd: finalAccepted === 0 ? null : totalCostUsd / finalAccepted,
    escalationRate: samples === 0 ? 0 : observations.filter((item) => item.escalated).length / samples,
    postAcceptanceDefectIncidenceRate: finalAccepted === 0 ? 0 : defectIncidents / finalAccepted,
    postAcceptanceDefectCount: defects.length,
    postAcceptanceDefectsBySeverity,
    totalCostUsd,
    totalLatencyMs: observations.reduce((sum, item) => sum + item.latencyMs, 0),
    totalRepairs: observations.reduce((sum, item) => sum + item.repairCount, 0),
    frontierTokens: tokenTotal('frontierTokens'),
    economyTokens: tokenTotal('economyTokens'),
  };
}

function routeObservations(observations: BenchmarkObservation[], taskClass: string, route: RoutingStrategy): BenchmarkObservation[] {
  return observations.filter((item) => item.taskClass === taskClass && item.attemptedRoute === route);
}

function comparableCaseKey(observation: BenchmarkObservation): string {
  return `${observation.taskId}\u0000${observation.caseFingerprint}`;
}

export function evaluateRouting(observations: BenchmarkObservation[], policy: RoutingGatePolicy): RoutingReport {
  const taskClasses = [...new Set(observations.map((item) => item.taskClass))].sort();
  const decisions: RouteDecision[] = [];
  for (const taskClass of taskClasses) {
    for (const candidateRoute of policy.candidateRoutes) {
      const candidateObservations = routeObservations(observations, taskClass, candidateRoute);
      const baselineObservations = routeObservations(observations, taskClass, policy.baselineRoute);
      const baselineCaseKeys = new Set(baselineObservations.map(comparableCaseKey));
      const pairedCaseKeys = new Set(
        candidateObservations.filter((item) => baselineCaseKeys.has(comparableCaseKey(item))).map(comparableCaseKey),
      );
      const candidate = metrics(candidateObservations.filter((item) => pairedCaseKeys.has(comparableCaseKey(item))));
      const baseline = metrics(baselineObservations.filter((item) => pairedCaseKeys.has(comparableCaseKey(item))));
      const pairedSamples = pairedCaseKeys.size;
      const reasons: string[] = [];
      if (pairedSamples < policy.minPairedSamplesPerRoute) reasons.push('paired_sample_below_minimum');
      const insufficientEvidence = reasons.length > 0;
      if (!insufficientEvidence) {
        const savingsRate =
          candidate.acceptedTaskCostUsd === null || baseline.acceptedTaskCostUsd === null || baseline.acceptedTaskCostUsd === 0
            ? Number.NEGATIVE_INFINITY
            : 1 - candidate.acceptedTaskCostUsd / baseline.acceptedTaskCostUsd;
        if (savingsRate < policy.minAcceptedTaskCostSavingsRate) {
          reasons.push('accepted_task_cost_savings_below_minimum');
        }
        if (baseline.firstPassAcceptanceRate - candidate.firstPassAcceptanceRate > policy.maxFirstPassAcceptanceDropRate) {
          reasons.push('first_pass_acceptance_drop_above_maximum');
        }
        if (baseline.finalAcceptanceRate - candidate.finalAcceptanceRate > policy.maxFinalAcceptanceDropRate) {
          reasons.push('final_acceptance_drop_above_maximum');
        }
        if (candidate.escalationRate > policy.maxEscalationRate) {
          reasons.push('escalation_rate_above_maximum');
        }
        if (candidate.postAcceptanceDefectIncidenceRate > policy.maxPostAcceptanceDefectIncidenceRate) {
          reasons.push('post_acceptance_defect_incidence_above_maximum');
        }
        if (candidate.postAcceptanceDefectsBySeverity.high > policy.maxHighSeverityPostAcceptanceDefects) {
          reasons.push('high_post_acceptance_defects_above_maximum');
        }
        if (candidate.postAcceptanceDefectsBySeverity.critical > policy.maxCriticalSeverityPostAcceptanceDefects) {
          reasons.push('critical_post_acceptance_defects_above_maximum');
        }
      }
      decisions.push({
        taskClass,
        candidateRoute,
        baselineRoute: policy.baselineRoute,
        pairedSamples,
        decision: insufficientEvidence ? 'insufficient_evidence' : reasons.length > 0 ? 'reject' : 'promote',
        reasons,
        candidate,
        baseline,
      });
    }
  }
  return { schemaVersion: 2, decisions };
}
