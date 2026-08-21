import type { RuntimeExecutionLaneV4 } from './contracts.js';

export interface RuntimeExecutionObservationV4 {
  readonly lane: RuntimeExecutionLaneV4;
  readonly finalAccepted: boolean;
  readonly attempts: number;
  readonly repairs: number;
  readonly escalations: number;
  readonly workerInputTokens: number;
  readonly workerOutputTokens: number;
  readonly frontierInputTokens: number;
  readonly frontierOutputTokens: number;
  readonly providerCostMicroUnits: number;
  readonly humanInterventionSeconds: number;
  readonly humanCostMicroUnits: number;
}

export interface RuntimeExecutionEfficiencyV4 {
  readonly scheduledRuns: number;
  readonly acceptedRuns: number;
  readonly firstPassAcceptedRuns: number;
  readonly failedRuns: number;
  readonly repairs: number;
  readonly escalations: number;
  readonly workerTokens: number;
  readonly frontierTokens: number;
  readonly providerCostMicroUnits: number;
  readonly humanInterventionSeconds: number;
  readonly totalOperatingCostMicroUnits: number;
  readonly costPerAcceptedResultMicroUnits: number | null;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_EFFICIENCY_EVIDENCE: ${label}`);
  return value;
}

/** Aggregates every scheduled attempt; failed work is never removed from cost or frontier usage. */
export function aggregateRuntimeExecutionEfficiencyV4(values: readonly RuntimeExecutionObservationV4[]): RuntimeExecutionEfficiencyV4 {
  let acceptedRuns = 0;
  let firstPassAcceptedRuns = 0;
  let repairs = 0;
  let escalations = 0;
  let workerTokens = 0;
  let frontierTokens = 0;
  let providerCostMicroUnits = 0;
  let humanInterventionSeconds = 0;
  let humanCostMicroUnits = 0;
  for (const value of values) {
    const attempts = nonNegativeInteger(value.attempts, 'attempts');
    if (attempts < 1) throw new Error('INVALID_EFFICIENCY_EVIDENCE: attempts');
    repairs += nonNegativeInteger(value.repairs, 'repairs');
    escalations += nonNegativeInteger(value.escalations, 'escalations');
    workerTokens +=
      nonNegativeInteger(value.workerInputTokens, 'workerInputTokens') + nonNegativeInteger(value.workerOutputTokens, 'workerOutputTokens');
    frontierTokens +=
      nonNegativeInteger(value.frontierInputTokens, 'frontierInputTokens') +
      nonNegativeInteger(value.frontierOutputTokens, 'frontierOutputTokens');
    providerCostMicroUnits += nonNegativeInteger(value.providerCostMicroUnits, 'providerCostMicroUnits');
    humanInterventionSeconds += nonNegativeInteger(value.humanInterventionSeconds, 'humanInterventionSeconds');
    humanCostMicroUnits += nonNegativeInteger(value.humanCostMicroUnits, 'humanCostMicroUnits');
    if (value.finalAccepted) {
      acceptedRuns += 1;
      if (attempts === 1 && value.repairs === 0 && value.escalations === 0) firstPassAcceptedRuns += 1;
    }
  }
  const totalOperatingCostMicroUnits = providerCostMicroUnits + humanCostMicroUnits;
  return Object.freeze({
    scheduledRuns: values.length,
    acceptedRuns,
    firstPassAcceptedRuns,
    failedRuns: values.length - acceptedRuns,
    repairs,
    escalations,
    workerTokens,
    frontierTokens,
    providerCostMicroUnits,
    humanInterventionSeconds,
    totalOperatingCostMicroUnits,
    costPerAcceptedResultMicroUnits: acceptedRuns === 0 ? null : Math.round(totalOperatingCostMicroUnits / acceptedRuns),
  });
}
