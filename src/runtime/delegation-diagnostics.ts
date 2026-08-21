import { hashCanonicalV4 } from './canonical.js';
import { loadRuntimeProfileV4, loadRuntimeRepositoryPolicyV4 } from './load.js';
import { analyzeRuntimeRouteCoverageV4 } from './readiness.js';
import type {
  RuntimeBindingV4,
  RuntimeProfileV4,
  RuntimeRepositoryPolicyV4,
  RuntimeTaskTraitV4,
  SourceSensitivityV4,
} from './contracts.js';

export type RuntimeDelegationDiagnosticStatusV4 = 'READY' | 'DEGRADED' | 'BLOCKED';
export type RuntimeDelegationDiagnosticSeverityV4 = 'INFO' | 'WARNING' | 'BLOCKED';

export interface RuntimeDelegationFindingV4 {
  readonly code:
    | 'ECONOMY_MECHANICAL_READY'
    | 'ECONOMY_MECHANICAL_UNAVAILABLE'
    | 'ECONOMY_REASONING_READY'
    | 'ECONOMY_REASONING_UNAVAILABLE'
    | 'PRIVATE_SOURCE_ROUTE_COLLAPSE'
    | 'FRONTIER_EXECUTOR_REUSES_ECONOMY_MODEL'
    | 'FRONTIER_FALLBACK_UNAVAILABLE';
  readonly severity: RuntimeDelegationDiagnosticSeverityV4;
  readonly message: string;
}

export interface RuntimeDelegationRoleV4 {
  readonly role: keyof RuntimeProfileV4['bindings'];
  readonly tier: 'frontier' | 'economy';
  readonly provider: string;
  readonly model: string;
  readonly harness: string;
  readonly sourceSensitivitySupported: boolean;
  readonly supportedTaskTraits: readonly RuntimeTaskTraitV4[];
}

export interface RuntimeDelegationDiagnosticV4 {
  readonly schemaVersion: 4;
  readonly status: RuntimeDelegationDiagnosticStatusV4;
  readonly repositoryId: string;
  readonly sourceSensitivity: SourceSensitivityV4;
  readonly policyHash: string;
  readonly profileHash: string;
  readonly automaticRoute: 'ECONOMY' | 'FRONTIER' | null;
  readonly roles: readonly RuntimeDelegationRoleV4[];
  readonly findings: readonly RuntimeDelegationFindingV4[];
  readonly reportHash: string;
}

const mechanicalTraits = ['mechanical', 'localized'] as const;
const reasoningTraits = ['semantic-debugging', 'cross-file-reasoning'] as const;
const frontierTraits = [
  'mechanical',
  'localized',
  'semantic-debugging',
  'cross-file-reasoning',
  'long-horizon',
  'architecture',
  'security-sensitive',
  'migration',
] as const;

function supports(binding: RuntimeBindingV4 | undefined, sensitivity: SourceSensitivityV4, traits: readonly RuntimeTaskTraitV4[]): boolean {
  if (
    binding === undefined ||
    binding.permissions !== 'contract-write' ||
    !binding.allowedSourceSensitivity.includes(sensitivity) ||
    binding.execution === undefined
  )
    return false;
  const supported = new Set(binding.execution.supportedTaskTraits);
  return traits.every((trait) => supported.has(trait));
}

function roleSummary(
  role: keyof RuntimeProfileV4['bindings'],
  binding: RuntimeBindingV4,
  sensitivity: SourceSensitivityV4,
): RuntimeDelegationRoleV4 {
  return Object.freeze({
    role,
    tier: binding.tier,
    provider: binding.provider,
    model: binding.model,
    harness: binding.harness,
    sourceSensitivitySupported: binding.allowedSourceSensitivity.includes(sensitivity),
    supportedTaskTraits: Object.freeze([...(binding.execution?.supportedTaskTraits ?? [])]),
  });
}

export function diagnoseRuntimeDelegationV4(
  policyInput: RuntimeRepositoryPolicyV4,
  profileInput: RuntimeProfileV4,
): RuntimeDelegationDiagnosticV4 {
  const policy = loadRuntimeRepositoryPolicyV4(structuredClone(policyInput));
  const profile = loadRuntimeProfileV4(structuredClone(profileInput));
  const sensitivity = policy.sourcePolicy.sourceSensitivity;
  const coverage = analyzeRuntimeRouteCoverageV4(profile, sensitivity);
  const findings: RuntimeDelegationFindingV4[] = [];
  const mechanicalReady = supports(profile.bindings.executor, sensitivity, mechanicalTraits);
  const reasoningReady = supports(profile.bindings.reasoningExecutor, sensitivity, reasoningTraits);
  const frontierReady = supports(profile.bindings.frontierExecutor, sensitivity, frontierTraits);

  findings.push(
    Object.freeze(
      mechanicalReady
        ? {
            code: 'ECONOMY_MECHANICAL_READY',
            severity: 'INFO',
            message: 'Localized mechanical work can be delegated to the economy executor.',
          }
        : {
            code: 'ECONOMY_MECHANICAL_UNAVAILABLE',
            severity: 'WARNING',
            message: 'Mechanical work will not use the economy executor for this source sensitivity and qualification envelope.',
          },
    ),
  );
  findings.push(
    Object.freeze(
      reasoningReady
        ? {
            code: 'ECONOMY_REASONING_READY',
            severity: 'INFO',
            message: 'Qualified semantic debugging and cross-file work can use the reasoning economy executor.',
          }
        : {
            code: 'ECONOMY_REASONING_UNAVAILABLE',
            severity: 'WARNING',
            message: 'Semantic debugging and cross-file work will elevate to the frontier executor.',
          },
    ),
  );
  if (sensitivity === 'PRIVATE' && !coverage.economy.available) {
    findings.push(
      Object.freeze({
        code: 'PRIVATE_SOURCE_ROUTE_COLLAPSE',
        severity: 'WARNING',
        message: 'The economy route does not support PRIVATE source; AUTO collapses to frontier execution.',
      }),
    );
  }
  const economyIdentities = [profile.bindings.executor, profile.bindings.reasoningExecutor, profile.bindings.escalationExecutor]
    .filter((binding): binding is RuntimeBindingV4 => binding !== undefined)
    .map((binding) => `${binding.provider}\u0000${binding.model}`);
  if (economyIdentities.includes(`${profile.bindings.frontierExecutor.provider}\u0000${profile.bindings.frontierExecutor.model}`)) {
    findings.push(
      Object.freeze({
        code: 'FRONTIER_EXECUTOR_REUSES_ECONOMY_MODEL',
        severity: 'WARNING',
        message:
          'Frontier execution reuses an economy model identity; supervision may improve retries, but this is not a stronger-model fallback.',
      }),
    );
  }
  if (!frontierReady) {
    findings.push(
      Object.freeze({
        code: 'FRONTIER_FALLBACK_UNAVAILABLE',
        severity: 'BLOCKED',
        message: 'No frontier write binding is qualified for every protected task trait at this source sensitivity.',
      }),
    );
  }

  const roles = Object.freeze(
    (Object.entries(profile.bindings) as [keyof RuntimeProfileV4['bindings'], RuntimeBindingV4][]).map(([role, binding]) =>
      roleSummary(role, binding, sensitivity),
    ),
  );
  const status: RuntimeDelegationDiagnosticStatusV4 = findings.some((finding) => finding.severity === 'BLOCKED')
    ? 'BLOCKED'
    : findings.some((finding) => finding.severity === 'WARNING')
      ? 'DEGRADED'
      : 'READY';
  const body = {
    schemaVersion: 4 as const,
    status,
    repositoryId: policy.repositoryId,
    sourceSensitivity: sensitivity,
    policyHash: hashCanonicalV4(policy),
    profileHash: hashCanonicalV4(profile),
    automaticRoute: coverage.automaticRoute,
    roles,
    findings: Object.freeze(findings),
  };
  return Object.freeze({ ...body, reportHash: hashCanonicalV4(body) });
}

export function renderRuntimeDelegationDiagnosticV4(report: RuntimeDelegationDiagnosticV4): readonly string[] {
  const lines = [
    `delegation: ${report.status}`,
    `repository: ${report.repositoryId}`,
    `source sensitivity: ${report.sourceSensitivity}`,
    `automatic route: ${report.automaticRoute ?? 'NONE'}`,
    'roles:',
    ...report.roles.map(
      (role) =>
        `  ${role.role}: ${role.tier} ${role.provider}/${role.model} via ${role.harness} (source=${role.sourceSensitivitySupported ? 'supported' : 'unsupported'}, traits=${role.supportedTaskTraits.join(',') || 'none'})`,
    ),
    'findings:',
    ...report.findings.map((finding) => `  ${finding.severity} ${finding.code}: ${finding.message}`),
    `report hash: ${report.reportHash}`,
  ];
  return Object.freeze(lines);
}
