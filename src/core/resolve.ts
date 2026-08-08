import type { ModelProfile, Policy, ResolvedPolicy, ResolvedRole, RoleName } from './types.js';

const roleNames: RoleName[] = ['orchestrator', 'executor', 'reviewer'];

export function resolveRoles(policy: Policy, profile: ModelProfile): ResolvedPolicy {
  const roles = {} as Record<RoleName, ResolvedRole>;

  for (const roleName of roleNames) {
    const requirement = policy.roles[roleName];
    const assignment = profile.assignments[roleName];
    if (assignment.tier !== requirement.tier) {
      throw new Error(`${roleName} requires tier ${requirement.tier}, received ${assignment.tier}`);
    }
    const missing = requirement.capabilities.filter(
      (capability) => !assignment.capabilities.includes(capability),
    );
    if (missing.length > 0) {
      throw new Error(`${roleName} is missing required capabilities: ${missing.join(', ')}`);
    }
    roles[roleName] = {
      ...assignment,
      modelRef: `${assignment.provider}/${assignment.model}`,
      permissions: { ...requirement.permissions },
    };
  }

  if (roles.reviewer.modelRef === roles.executor.modelRef) {
    throw new Error('reviewer must be independent from the executor provider and model');
  }
  if (roles.executor.modelRef === roles.orchestrator.modelRef) {
    throw new Error('executor must use an explicit economy model and cannot inherit the orchestrator model');
  }

  return {
    policyVersion: policy.version,
    profileVersion: profile.version,
    profileId: profile.id,
    roles,
    validation: { commands: [...policy.validation.commands] },
  };
}
