import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateRuntimeExecutionEfficiencyV4 } from '../src/runtime/execution-efficiency.js';

test('charges failed attempts, frontier use, and human intervention to the route', () => {
  const result = aggregateRuntimeExecutionEfficiencyV4([
    {
      lane: 'MECHANICAL_ECONOMY',
      finalAccepted: false,
      attempts: 2,
      repairs: 1,
      escalations: 0,
      workerInputTokens: 100,
      workerOutputTokens: 20,
      frontierInputTokens: 10,
      frontierOutputTokens: 5,
      providerCostMicroUnits: 30,
      humanInterventionSeconds: 2,
      humanCostMicroUnits: 40,
    },
    {
      lane: 'MECHANICAL_ECONOMY',
      finalAccepted: true,
      attempts: 1,
      repairs: 0,
      escalations: 0,
      workerInputTokens: 80,
      workerOutputTokens: 20,
      frontierInputTokens: 20,
      frontierOutputTokens: 10,
      providerCostMicroUnits: 50,
      humanInterventionSeconds: 0,
      humanCostMicroUnits: 0,
    },
  ]);
  assert.deepEqual(result, {
    scheduledRuns: 2,
    acceptedRuns: 1,
    firstPassAcceptedRuns: 1,
    failedRuns: 1,
    repairs: 1,
    escalations: 0,
    workerTokens: 220,
    frontierTokens: 45,
    providerCostMicroUnits: 80,
    humanInterventionSeconds: 2,
    totalOperatingCostMicroUnits: 120,
    costPerAcceptedResultMicroUnits: 120,
  });
});

test('rejects incomplete or negative accounting evidence', () => {
  assert.throws(
    () =>
      aggregateRuntimeExecutionEfficiencyV4([
        {
          lane: 'FRONTIER_EXECUTION',
          finalAccepted: true,
          attempts: 0,
          repairs: 0,
          escalations: 0,
          workerInputTokens: 0,
          workerOutputTokens: 0,
          frontierInputTokens: 0,
          frontierOutputTokens: 0,
          providerCostMicroUnits: 0,
          humanInterventionSeconds: 0,
          humanCostMicroUnits: 0,
        },
      ]),
    /INVALID_EFFICIENCY_EVIDENCE/,
  );
});
