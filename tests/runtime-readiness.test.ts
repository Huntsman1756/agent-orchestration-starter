import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { assessRuntimeActivationV4, type RuntimeHostEvidenceV4 } from '../src/runtime/readiness.js';
import { deriveWorkContract, type DeriveWorkContractInputV4 } from '../src/runtime/routing.js';
import { freezeRepositoryPolicy } from '../src/runtime/repository-policy.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeTaskRequestV4 } from '../src/runtime/contracts.js';
import { validRepositoryPolicy, validRuntimeProfile, validTaskRequest } from './runtime-contracts.test.js';

const timestamp = '2026-08-10T12:00:00.000Z';
const hash = 'a'.repeat(64);

function privateInputs() {
  const policy = {
    ...validRepositoryPolicy(),
    routing: { frontierOnly: { ...validRepositoryPolicy().routing.frontierOnly, sourceSensitivity: [] } },
    sourcePolicy: { dataScope: 'SOURCE_CODE_ONLY', sourceSensitivity: 'PRIVATE' },
  } as RuntimeRepositoryPolicyV4;
  const base = validRuntimeProfile() as RuntimeProfileV4;
  const profile = {
    ...base,
    bindings: {
      ...base.bindings,
      frontierExecutor: { ...base.bindings.frontierExecutor, allowedSourceSensitivity: ['PRIVATE'] },
      orchestrator: { ...base.bindings.orchestrator, allowedSourceSensitivity: ['PRIVATE'] },
      reviewer: { ...base.bindings.reviewer, allowedSourceSensitivity: ['PRIVATE'] },
    },
  } as RuntimeProfileV4;
  return { policy, profile };
}

function contractInput(): DeriveWorkContractInputV4 {
  const { policy, profile } = privateInputs();
  return {
    request: validTaskRequest() as RuntimeTaskRequestV4,
    run_id: 'run_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
    registration: {
      repository_id: 'fixture-repo',
      canonical_root: 'C:/broker/repos/fixture-repo',
      policy_ref: 'policy',
      profile_ref: 'profile',
      worktree_parent: 'C:/broker/worktrees',
      state_path: 'C:/broker/state/fixture.json',
    },
    policy: freezeRepositoryPolicy(policy),
    profile,
    base_sha: 'b'.repeat(40),
    sandbox_profiles: { 'executor-networked': {}, 'frontier-networked': {}, 'validation-untrusted': {}, 'review-capsule': {} },
  };
}

function verifiedHostEvidence(): RuntimeHostEvidenceV4[] {
  return [
    'NATIVE_HOST_COMPOSITION',
    'IMMUTABLE_RUNTIME_BUNDLE',
    'CREDENTIAL_ISOLATION',
    'PROVIDER_GATEWAY_COMPATIBILITY',
    'CAPABILITY_QUALIFICATION',
    'DOCKER_SANDBOX_CERTIFICATION',
  ].map((code) => ({ code, status: 'VERIFIED', evidenceHash: hash })) as RuntimeHostEvidenceV4[];
}

test('AUTO elevates incompatible private economy work to a compatible frontier binding without reclassification', () => {
  const input = contractInput();
  const contract = deriveWorkContract(input);
  assert.equal(contract.effective_route, 'FRONTIER');
  assert.equal(contract.effective_source_sensitivity, 'PRIVATE');
  assert.match(contract.route_decision_reasons.join('\n'), /economy route is incompatible/);

  input.request.requested_route = 'ECONOMY';
  assert.throws(() => deriveWorkContract(input), /SOURCE_SENSITIVITY_UNSUPPORTED/);
});

test('profile loading rejects a read-only execution binding before routing', () => {
  const input = contractInput();
  input.profile = {
    ...input.profile,
    bindings: {
      ...input.profile.bindings,
      executor: { ...input.profile.bindings.executor, allowedSourceSensitivity: ['PRIVATE'], permissions: 'read-only' },
    },
  };
  assert.throws(() => deriveWorkContract(input), /contract-write permissions/);
});

test('analysis-only exposes route collapse and host gaps as warnings without authorizing execution', () => {
  const { policy, profile } = privateInputs();
  policy.publication = { ...policy.publication, enabled: false };
  const report = assessRuntimeActivationV4({ target: 'ANALYSIS_ONLY', policy, profile, hostEvidence: [], assessedAt: timestamp });
  assert.equal(report.status, 'READY');
  assert.equal(report.routeCoverage.economy.available, false);
  assert.equal(report.routeCoverage.frontier.available, true);
  assert.equal(report.routeCoverage.automaticRoute, 'FRONTIER');
  assert.equal(report.checks.find((item) => item.code === 'NATIVE_HOST_COMPOSITION')?.status, 'WARNING');
});

test('isolated execution requires complete hashed host evidence and disabled publication', () => {
  const { policy, profile } = privateInputs();
  policy.publication = { ...policy.publication, enabled: false };
  const ready = assessRuntimeActivationV4({
    target: 'ISOLATED_EXECUTION',
    policy,
    profile,
    hostEvidence: verifiedHostEvidence(),
    assessedAt: timestamp,
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.checks.find((item) => item.code === 'V3_TELEMETRY_ADAPTER')?.status, 'WARNING');

  const blocked = assessRuntimeActivationV4({
    target: 'ISOLATED_EXECUTION',
    policy,
    profile,
    hostEvidence: verifiedHostEvidence().slice(1),
    assessedAt: timestamp,
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.checks.find((item) => item.code === 'NATIVE_HOST_COMPOSITION')?.status, 'BLOCKED');
});

test('autonomous publication independently requires enabled policy and GitHub lease evidence', () => {
  const { policy, profile } = privateInputs();
  const blocked = assessRuntimeActivationV4({
    target: 'AUTONOMOUS_PUBLICATION',
    policy,
    profile,
    hostEvidence: verifiedHostEvidence(),
    assessedAt: timestamp,
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.checks.find((item) => item.code === 'GITHUB_PUBLICATION_LEASE')?.status, 'BLOCKED');

  const ready = assessRuntimeActivationV4({
    target: 'AUTONOMOUS_PUBLICATION',
    policy,
    profile,
    hostEvidence: [...verifiedHostEvidence(), { code: 'GITHUB_PUBLICATION_LEASE', status: 'VERIFIED', evidenceHash: hash }],
    assessedAt: timestamp,
  });
  assert.equal(ready.status, 'READY');
});

test('rejects forged or duplicate host evidence and publishes a strict report schema', async () => {
  const { policy, profile } = privateInputs();
  assert.throws(
    () =>
      assessRuntimeActivationV4({
        target: 'ANALYSIS_ONLY',
        policy,
        profile,
        hostEvidence: [{ code: 'CREDENTIAL_ISOLATION', status: 'VERIFIED', evidenceHash: null }],
        assessedAt: timestamp,
      }),
    /INVALID_CONTRACT/,
  );
  assert.throws(
    () => assessRuntimeActivationV4({ target: 'UNKNOWN' as 'ANALYSIS_ONLY', policy, profile, hostEvidence: [], assessedAt: timestamp }),
    /INVALID_CONTRACT/,
  );
  assert.throws(
    () =>
      assessRuntimeActivationV4({
        target: 'ANALYSIS_ONLY',
        policy,
        profile,
        hostEvidence: [
          { code: 'CREDENTIAL_ISOLATION', status: 'UNAVAILABLE', evidenceHash: null },
          { code: 'CREDENTIAL_ISOLATION', status: 'UNAVAILABLE', evidenceHash: null },
        ],
        assessedAt: timestamp,
      }),
    /INVALID_CONTRACT/,
  );

  const schema = JSON.parse(await readFile(new URL('../contracts/runtime-activation-readiness-v4.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  const report = assessRuntimeActivationV4({ target: 'ANALYSIS_ONLY', policy, profile, hostEvidence: [], assessedAt: timestamp });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...report, repositoryName: 'special-case' }), false);
});
