import { hashCanonicalV4 } from './canonical.js';
import { loadRuntimeProfileV4, loadRuntimeRepositoryPolicyV4 } from './load.js';
import type { RuntimeProfileV4, RuntimeRepositoryPolicyV4, RuntimeRoleV4, SourceSensitivityV4 } from './contracts.js';

export type RuntimeActivationTargetV4 = 'ANALYSIS_ONLY' | 'ISOLATED_EXECUTION' | 'AUTONOMOUS_PUBLICATION';
export type RuntimeReadinessStatusV4 = 'READY' | 'BLOCKED';
export type RuntimeReadinessCheckStatusV4 = 'PASS' | 'WARNING' | 'BLOCKED';
export type RuntimeRouteCoverageReasonV4 = 'SUPPORTED' | 'SOURCE_SENSITIVITY_UNSUPPORTED' | 'PERMISSION_MISMATCH' | 'TIER_MISMATCH';
export type RuntimeHostCheckCodeV4 =
  | 'NATIVE_HOST_COMPOSITION'
  | 'IMMUTABLE_RUNTIME_BUNDLE'
  | 'CREDENTIAL_ISOLATION'
  | 'PROVIDER_GATEWAY_COMPATIBILITY'
  | 'CAPABILITY_QUALIFICATION'
  | 'DOCKER_SANDBOX_CERTIFICATION'
  | 'GITHUB_PUBLICATION_LEASE'
  | 'V3_TELEMETRY_ADAPTER';

export interface RuntimeHostEvidenceV4 {
  readonly code: RuntimeHostCheckCodeV4;
  readonly status: 'VERIFIED' | 'UNAVAILABLE';
  readonly evidenceHash: string | null;
}

export interface RuntimeRouteCoverageV4 {
  readonly economy: { readonly available: boolean; readonly reason: RuntimeRouteCoverageReasonV4 };
  readonly frontier: { readonly available: boolean; readonly reason: RuntimeRouteCoverageReasonV4 };
  readonly automaticRoute: 'ECONOMY' | 'FRONTIER' | null;
}

export interface RuntimeReadinessCheckV4 {
  readonly code: 'DELEGATION_TOPOLOGY' | 'CORE_ROLE_COVERAGE' | 'ROUTE_COVERAGE' | 'PUBLICATION_BOUNDARY' | RuntimeHostCheckCodeV4;
  readonly status: RuntimeReadinessCheckStatusV4;
  readonly evidenceHash: string | null;
}

export interface RuntimeActivationReadinessReportV4 {
  readonly schemaVersion: 4;
  readonly target: RuntimeActivationTargetV4;
  readonly status: RuntimeReadinessStatusV4;
  readonly assessedAt: string;
  readonly policyHash: string;
  readonly profileHash: string;
  readonly routeCoverage: RuntimeRouteCoverageV4;
  readonly checks: readonly RuntimeReadinessCheckV4[];
  readonly reportHash: string;
}

export interface AssessRuntimeActivationInputV4 {
  readonly target: RuntimeActivationTargetV4;
  readonly policy: RuntimeRepositoryPolicyV4;
  readonly profile: RuntimeProfileV4;
  readonly hostEvidence: readonly RuntimeHostEvidenceV4[];
  readonly assessedAt: string;
}

const hashPattern = /^[a-f0-9]{64}$/;
const hostCheckCodes: readonly RuntimeHostCheckCodeV4[] = [
  'NATIVE_HOST_COMPOSITION',
  'IMMUTABLE_RUNTIME_BUNDLE',
  'CREDENTIAL_ISOLATION',
  'PROVIDER_GATEWAY_COMPATIBILITY',
  'CAPABILITY_QUALIFICATION',
  'DOCKER_SANDBOX_CERTIFICATION',
  'GITHUB_PUBLICATION_LEASE',
  'V3_TELEMETRY_ADAPTER',
];
const executionChecks = hostCheckCodes.filter((code) => !['GITHUB_PUBLICATION_LEASE', 'V3_TELEMETRY_ADAPTER'].includes(code));

function roleCoverage(profile: RuntimeProfileV4, roles: readonly RuntimeRoleV4[], sensitivity: SourceSensitivityV4, permission: 'read-only' | 'contract-write', tier?: 'frontier' | 'economy'): RuntimeRouteCoverageReasonV4 {
  if (roles.some((role) => profile.bindings[role]?.permissions !== permission)) return 'PERMISSION_MISMATCH';
  if (tier !== undefined && roles.some((role) => profile.bindings[role]?.tier !== tier)) return 'TIER_MISMATCH';
  if (roles.some((role) => !profile.bindings[role]?.allowedSourceSensitivity.includes(sensitivity))) return 'SOURCE_SENSITIVITY_UNSUPPORTED';
  return 'SUPPORTED';
}

export function analyzeRuntimeRouteCoverageV4(profileInput: RuntimeProfileV4, sensitivity: SourceSensitivityV4): RuntimeRouteCoverageV4 {
  const profile = loadRuntimeProfileV4(structuredClone(profileInput));
  const economyReason = roleCoverage(profile, ['executor', 'escalationExecutor'], sensitivity, 'contract-write', 'economy');
  const frontierReason = roleCoverage(profile, ['frontierExecutor'], sensitivity, 'contract-write', 'frontier');
  const economy = economyReason === 'SUPPORTED';
  const frontier = frontierReason === 'SUPPORTED';
  return Object.freeze({
    economy: Object.freeze({ available: economy, reason: economyReason }),
    frontier: Object.freeze({ available: frontier, reason: frontierReason }),
    automaticRoute: economy ? 'ECONOMY' : frontier ? 'FRONTIER' : null,
  });
}

function check(code: RuntimeReadinessCheckV4['code'], status: RuntimeReadinessCheckStatusV4, evidenceHash: string | null = null): RuntimeReadinessCheckV4 {
  return Object.freeze({ code, status, evidenceHash });
}

function loadEvidence(values: readonly RuntimeHostEvidenceV4[]): ReadonlyMap<RuntimeHostCheckCodeV4, RuntimeHostEvidenceV4> {
  const evidence = new Map<RuntimeHostCheckCodeV4, RuntimeHostEvidenceV4>();
  for (const supplied of values) {
    if (!hostCheckCodes.includes(supplied.code) || evidence.has(supplied.code)) throw new Error('INVALID_CONTRACT: host readiness evidence is unknown or duplicated');
    const valid = supplied.status === 'VERIFIED' ? hashPattern.test(supplied.evidenceHash ?? '') : supplied.status === 'UNAVAILABLE' && supplied.evidenceHash === null;
    if (!valid) throw new Error('INVALID_CONTRACT: host readiness evidence status and hash disagree');
    evidence.set(supplied.code, Object.freeze({ ...supplied }));
  }
  return evidence;
}

export function assessRuntimeActivationV4(input: AssessRuntimeActivationInputV4): RuntimeActivationReadinessReportV4 {
  if (!['ANALYSIS_ONLY', 'ISOLATED_EXECUTION', 'AUTONOMOUS_PUBLICATION'].includes(input.target)) throw new Error('INVALID_CONTRACT: activation target is invalid');
  const policy = loadRuntimeRepositoryPolicyV4(structuredClone(input.policy));
  const profile = loadRuntimeProfileV4(structuredClone(input.profile));
  const assessed = new Date(input.assessedAt);
  if (!Number.isFinite(assessed.getTime()) || assessed.toISOString() !== input.assessedAt) throw new Error('INVALID_CONTRACT: readiness assessment timestamp is invalid');
  const evidence = loadEvidence(input.hostEvidence);
  const routeCoverage = analyzeRuntimeRouteCoverageV4(profile, policy.sourcePolicy.sourceSensitivity);
  const executionTarget = input.target !== 'ANALYSIS_ONLY';
  const checks: RuntimeReadinessCheckV4[] = [];

  const topologyValid = profile.bindings.orchestrator.tier === 'frontier'
    && profile.bindings.reviewer.tier === 'frontier'
    && profile.bindings.executor.tier === 'economy'
    && profile.bindings.escalationExecutor.tier === 'economy'
    && profile.bindings.frontierExecutor.tier === 'frontier'
    && (profile.bindings.reasoningExecutor === undefined || profile.bindings.reasoningExecutor.tier === 'economy');
  checks.push(check('DELEGATION_TOPOLOGY', topologyValid ? 'PASS' : executionTarget ? 'BLOCKED' : 'WARNING'));
  const coreReason = roleCoverage(profile, ['orchestrator', 'reviewer'], policy.sourcePolicy.sourceSensitivity, 'read-only', 'frontier');
  checks.push(check('CORE_ROLE_COVERAGE', coreReason === 'SUPPORTED' ? 'PASS' : executionTarget ? 'BLOCKED' : 'WARNING'));
  checks.push(check('ROUTE_COVERAGE', routeCoverage.automaticRoute !== null ? 'PASS' : executionTarget ? 'BLOCKED' : 'WARNING'));

  const publicationMatches = input.target === 'AUTONOMOUS_PUBLICATION' ? policy.publication.enabled : !policy.publication.enabled;
  checks.push(check('PUBLICATION_BOUNDARY', publicationMatches ? 'PASS' : executionTarget ? 'BLOCKED' : 'WARNING'));

  for (const code of executionChecks) {
    const item = evidence.get(code);
    checks.push(check(code, item?.status === 'VERIFIED' ? 'PASS' : executionTarget ? 'BLOCKED' : 'WARNING', item?.evidenceHash ?? null));
  }
  const publicationEvidence = evidence.get('GITHUB_PUBLICATION_LEASE');
  const publicationRequired = input.target === 'AUTONOMOUS_PUBLICATION';
  checks.push(check('GITHUB_PUBLICATION_LEASE', publicationEvidence?.status === 'VERIFIED' ? 'PASS' : publicationRequired ? 'BLOCKED' : 'WARNING', publicationEvidence?.evidenceHash ?? null));
  const telemetryEvidence = evidence.get('V3_TELEMETRY_ADAPTER');
  checks.push(check('V3_TELEMETRY_ADAPTER', telemetryEvidence?.status === 'VERIFIED' ? 'PASS' : 'WARNING', telemetryEvidence?.evidenceHash ?? null));

  const draft = {
    schemaVersion: 4 as const,
    target: input.target,
    status: (checks.some((item) => item.status === 'BLOCKED') ? 'BLOCKED' : 'READY') as RuntimeReadinessStatusV4,
    assessedAt: input.assessedAt,
    policyHash: hashCanonicalV4(policy),
    profileHash: hashCanonicalV4(profile),
    routeCoverage,
    checks: Object.freeze(checks),
  };
  return Object.freeze({ ...draft, reportHash: hashCanonicalV4(draft) });
}
