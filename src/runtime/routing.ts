import { hashCanonicalV4 } from './canonical.js';
import { resolveBinding } from './bindings.js';
import { loadRuntimeWorkContractV4 } from './load.js';
import type { RuntimeProfileV4, RuntimeTaskRequestV4, RuntimeWorkContractV4, EffectiveRouteV4, RequestedRouteV4 } from './contracts.js';
import type { FrozenRepositoryPolicyV4 } from './repository-policy.js';
import type { RegisteredRepositoryV4 } from './repository-registry.js';
import { analyzeRuntimeRouteCoverageV4, type RuntimeRouteCoverageV4 } from './readiness.js';
import { resolveAdaptiveExecutionPolicyV4 } from './adaptive-execution.js';
import type { RuntimeBindingHealthSnapshotV4 } from './binding-health.js';

const requestedRank = { AUTO: 0, ECONOMY: 1, FRONTIER: 2 } as const;

export function effectiveRoute(requested: RequestedRouteV4, policyRequiresFrontier: boolean): EffectiveRouteV4 {
  if (requestedRank[requested] === 2 || policyRequiresFrontier) return 'FRONTIER';
  return 'ECONOMY';
}

export interface DeriveWorkContractInputV4 {
  request: RuntimeTaskRequestV4;
  run_id: string;
  registration: RegisteredRepositoryV4;
  policy: FrozenRepositoryPolicyV4;
  profile: RuntimeProfileV4;
  base_sha: string;
  sandbox_profiles: Readonly<Record<string, unknown>>;
  binding_health?: readonly RuntimeBindingHealthSnapshotV4[];
}

function policyRouteReasons(input: DeriveWorkContractInputV4): string[] {
  const { request } = input;
  const frontier = input.policy.policy.routing.frontierOnly;
  const reasons: string[] = [];
  if (request.requested_route === 'FRONTIER') reasons.push('request requires frontier route');
  if (frontier.riskClasses.includes(request.requested_risk_class)) reasons.push(`risk class requires frontier: ${request.requested_risk_class}`);
  if (frontier.taskClasses.includes(request.task_class)) reasons.push(`task class requires frontier: ${request.task_class}`);
  if (frontier.sourceSensitivity.includes(input.policy.policy.sourcePolicy.sourceSensitivity)) {
    reasons.push(`source sensitivity requires frontier: ${input.policy.policy.sourcePolicy.sourceSensitivity}`);
  }
  for (const protectedPath of frontier.paths) {
    if (request.implementation_targets.some((change) => change.path === protectedPath || change.path.startsWith(`${protectedPath}/`))) {
      reasons.push(`path requires frontier: ${protectedPath}`);
    }
  }
  return reasons;
}

function sandboxProfileHashes(input: DeriveWorkContractInputV4): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const profileName of input.policy.policy.sandbox.requiredProfiles) {
    const profile = input.sandbox_profiles[profileName];
    if (profile === undefined) throw new Error(`PROCESS_SANDBOX_UNAVAILABLE: missing ${profileName}`);
    hashes[profileName] = hashCanonicalV4(profile);
  }
  return hashes;
}

function assertRouteCoverage(route: EffectiveRouteV4, coverage: RuntimeRouteCoverageV4): void {
  const selected = route === 'ECONOMY' ? coverage.economy : coverage.frontier;
  if (selected.available) return;
  if (selected.reason === 'SOURCE_SENSITIVITY_UNSUPPORTED') throw new Error(`SOURCE_SENSITIVITY_UNSUPPORTED: ${route.toLowerCase()} route cannot process repository source sensitivity`);
  throw new Error(`INVALID_CONTRACT: ${route.toLowerCase()} execution route has incompatible role permissions`);
}

export function deriveWorkContract(input: DeriveWorkContractInputV4): RuntimeWorkContractV4 {
  if (input.request.repository_id !== input.registration.repository_id || input.request.repository_id !== input.policy.policy.repositoryId) {
    throw new Error(`REPOSITORY_NOT_ALLOWED: ${input.request.repository_id}`);
  }
  const routeReasons = policyRouteReasons(input);
  let route = effectiveRoute(input.request.requested_route, routeReasons.length > 0);
  const coverage = analyzeRuntimeRouteCoverageV4(input.profile, input.policy.policy.sourcePolicy.sourceSensitivity);
  if (input.request.requested_route === 'AUTO' && routeReasons.length === 0) {
    if (coverage.automaticRoute === 'FRONTIER') {
      route = 'FRONTIER';
      routeReasons.push('economy route is incompatible with the effective runtime contract; compatible frontier route selected');
    }
  }
  assertRouteCoverage(route, coverage);
  const executionPolicy = resolveAdaptiveExecutionPolicyV4({
    request: input.request,
    profile: input.profile,
    sourceSensitivity: input.policy.policy.sourcePolicy.sourceSensitivity,
    forceFrontier: route === 'FRONTIER',
    bindingHealth: input.binding_health,
  });
  route = executionPolicy.lane === 'FRONTIER_EXECUTION' ? 'FRONTIER' : 'ECONOMY';
  if (executionPolicy.reasons.some((reason) => reason.includes('lack the required'))) routeReasons.push(...executionPolicy.reasons.filter((reason) => reason.includes('lack the required')));
  if (routeReasons.length === 0) routeReasons.push(`eligible for ${executionPolicy.lane.toLowerCase()}`);
  resolveBinding({
    profile: input.profile,
    route,
    stage: executionPolicy.executorRole === 'reasoningExecutor' ? 'REASONING' : 'PRIMARY',
    sourceSensitivity: input.policy.policy.sourcePolicy.sourceSensitivity,
  });

  const routeDecisionHash = hashCanonicalV4({ effective_route: route, reasons: routeReasons });
  const profileHash = hashCanonicalV4(input.profile);
  const draft = {
    ...input.request,
    run_id: input.run_id,
    repository_root_hash: hashCanonicalV4(input.registration.canonical_root),
    base_sha: input.base_sha,
    effective_risk_class: input.request.requested_risk_class,
    effective_route: route,
    route_decision_reasons: routeReasons,
    route_decision_hash: routeDecisionHash,
    execution_policy: executionPolicy,
    effective_data_scope: input.policy.policy.sourcePolicy.dataScope,
    effective_source_sensitivity: input.policy.policy.sourcePolicy.sourceSensitivity,
    sandbox_profile_hashes: sandboxProfileHashes(input),
    policy_hash: input.policy.hash,
    profile_hash: profileHash,
  };
  const contract = { ...draft, contract_hash: hashCanonicalV4(draft) };
  return loadRuntimeWorkContractV4(contract);
}
