import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnoseRuntimeDelegationV4, renderRuntimeDelegationDiagnosticV4 } from '../src/runtime/delegation-diagnostics.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy, validRuntimeProfile } from './runtime-contracts.test.js';

test('reports the exact economy and frontier delegation topology', () => {
  const profile = validRuntimeProfile() as RuntimeProfileV4;
  profile.bindings.reasoningExecutor = { ...profile.bindings.executor };
  profile.bindings.frontierExecutor = { ...profile.bindings.frontierExecutor, provider: 'frontier-provider', model: 'frontier-model' };
  const report = diagnoseRuntimeDelegationV4(validRepositoryPolicy() as RuntimeRepositoryPolicyV4, profile);

  assert.equal(report.status, 'READY');
  assert.equal(report.automaticRoute, 'ECONOMY');
  assert.equal(report.roles.find((role) => role.role === 'executor')?.tier, 'economy');
  assert.equal(report.roles.find((role) => role.role === 'reviewer')?.tier, 'frontier');
  assert.equal(report.findings.find((finding) => finding.code === 'ECONOMY_MECHANICAL_READY')?.severity, 'INFO');
  assert.equal(report.findings.find((finding) => finding.code === 'ECONOMY_REASONING_READY')?.severity, 'INFO');
  assert.match(renderRuntimeDelegationDiagnosticV4(report).join('\n'), /executor: economy fixture-provider\/fixture-model/);
});

test('does not mistake a larger budget on the same model for a stronger fallback', () => {
  const profile = validRuntimeProfile() as RuntimeProfileV4;
  const report = diagnoseRuntimeDelegationV4(validRepositoryPolicy() as RuntimeRepositoryPolicyV4, profile);

  assert.equal(report.status, 'DEGRADED');
  assert.equal(report.findings.find((finding) => finding.code === 'FRONTIER_EXECUTOR_REUSES_ECONOMY_MODEL')?.severity, 'WARNING');
});

test('makes private-source route collapse visible without weakening policy', () => {
  const policy = { ...validRepositoryPolicy(), sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PRIVATE' } } as RuntimeRepositoryPolicyV4;
  const base = validRuntimeProfile() as RuntimeProfileV4;
  const profile = {
    ...base,
    bindings: {
      ...base.bindings,
      orchestrator: { ...base.bindings.orchestrator, allowedSourceSensitivity: ['PRIVATE'] },
      reviewer: { ...base.bindings.reviewer, allowedSourceSensitivity: ['PRIVATE'] },
      frontierExecutor: { ...base.bindings.frontierExecutor, allowedSourceSensitivity: ['PRIVATE'] },
    },
  } as RuntimeProfileV4;
  const report = diagnoseRuntimeDelegationV4(policy, profile);

  assert.equal(report.status, 'DEGRADED');
  assert.equal(report.automaticRoute, 'FRONTIER');
  assert.equal(report.findings.find((finding) => finding.code === 'PRIVATE_SOURCE_ROUTE_COLLAPSE')?.severity, 'WARNING');
});

test('blocks a profile with no qualified frontier fallback for protected coding work', () => {
  const profile = validRuntimeProfile() as RuntimeProfileV4;
  profile.bindings.frontierExecutor.execution = {
    ...profile.bindings.frontierExecutor.execution!,
    supportedTaskTraits: ['mechanical', 'localized'],
  };
  const report = diagnoseRuntimeDelegationV4(validRepositoryPolicy() as RuntimeRepositoryPolicyV4, profile);

  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.findings.find((finding) => finding.code === 'FRONTIER_FALLBACK_UNAVAILABLE')?.severity, 'BLOCKED');
});
