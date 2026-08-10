import { isAbsolute, join } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';

const HASH = /^[a-f0-9]{64}$/u;
const IMMUTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;
const PORTABLE_MODULE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.mjs$/u;

export const RUNTIME_HOST_COMPONENT_IDS_V4 = Object.freeze([
  'credential_gateway',
  'task_source',
  'issue_planner',
  'practice_pack_resolver',
  'sandbox_coordinator',
  'capability_issuer',
  'github_publisher',
  'post_merge_verifier',
] as const);

export type RuntimeHostComponentIdV4 = (typeof RUNTIME_HOST_COMPONENT_IDS_V4)[number];

export const RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4 = Object.freeze({
  credential_gateway: Object.freeze([]),
  task_source: Object.freeze(['credential_gateway']),
  issue_planner: Object.freeze(['task_source']),
  practice_pack_resolver: Object.freeze(['issue_planner']),
  sandbox_coordinator: Object.freeze(['credential_gateway']),
  capability_issuer: Object.freeze(['practice_pack_resolver', 'credential_gateway', 'sandbox_coordinator']),
  github_publisher: Object.freeze(['credential_gateway']),
  post_merge_verifier: Object.freeze(['credential_gateway', 'github_publisher', 'sandbox_coordinator']),
} satisfies Readonly<Record<RuntimeHostComponentIdV4, readonly RuntimeHostComponentIdV4[]>>);

type RuntimeHostPortMemberKindV4 = 'function' | 'string';
export interface RuntimeHostPortMemberV4 { readonly name: string; readonly kind: RuntimeHostPortMemberKindV4 }

function port(...members: ReadonlyArray<readonly [string, RuntimeHostPortMemberKindV4]>): readonly RuntimeHostPortMemberV4[] {
  return Object.freeze(members.map(([name, kind]) => Object.freeze({ name, kind })));
}

const RUNTIME_HOST_COMPONENT_PORTS_V4 = Object.freeze({
  task_source: port(
    ['listCandidates', 'function'], ['loadCandidate', 'function'], ['claim', 'function'], ['renew', 'function'],
    ['complete', 'function'], ['reopen', 'function'], ['fail', 'function'],
  ),
  issue_planner: port(['plan', 'function']),
  practice_pack_resolver: port(['resolve', 'function']),
  credential_gateway: port(['leaseProvider', 'function'], ['leaseGitHub', 'function'], ['revoke', 'function']),
  sandbox_coordinator: port(['id', 'string'], ['probe', 'function'], ['run', 'function'], ['terminate', 'function']),
  capability_issuer: port(['issue', 'function']),
  github_publisher: port(
    ['pushExact', 'function'], ['findPullRequest', 'function'], ['createPullRequest', 'function'],
    ['waitForRequiredChecks', 'function'], ['mergePullRequest', 'function'],
  ),
  post_merge_verifier: port(['verify', 'function']),
} satisfies Readonly<Record<RuntimeHostComponentIdV4, readonly RuntimeHostPortMemberV4[]>>);

const RUNTIME_HOST_COMPONENT_INTERFACE_CONTRACTS_V4 = Object.freeze({
  task_source: 'AutonomousTaskSourceV4@4',
  issue_planner: 'RuntimeIssuePlannerPortV4@4',
  practice_pack_resolver: 'RuntimePracticePackResolverPortV4@4',
  credential_gateway: 'RuntimeCredentialGatewayPortV4@4',
  sandbox_coordinator: 'ProcessSandboxBackendV4@4',
  capability_issuer: 'RuntimeCapabilityIssuerPortV4@4',
  github_publisher: 'PublicationAdapterV4@4',
  post_merge_verifier: 'AutonomousPostMergeVerifierV4@4',
} satisfies Readonly<Record<RuntimeHostComponentIdV4, string>>);

export interface RuntimeHostComponentSourceV4 {
  readonly id: RuntimeHostComponentIdV4;
  readonly implementationRevision: string;
  readonly modulePath: string;
  readonly moduleSha256: string;
  readonly interfaceHash: string;
  readonly qualificationEvidenceHash: string;
  readonly dependencies: readonly RuntimeHostComponentDependencyV4[];
  readonly certificationHash: string;
}

export interface RuntimeHostComponentDependencyV4 {
  readonly id: RuntimeHostComponentIdV4;
  readonly certificationHash: string;
}

export interface RuntimeHostComponentSourceManifestV4 {
  readonly schemaVersion: 4;
  readonly driverSha256: string;
  readonly integrationEvidenceHash: string;
  readonly components: readonly RuntimeHostComponentSourceV4[];
  readonly compositionCertificationHash: string;
}

export interface RuntimeHostComponentBindingV4 {
  readonly id: RuntimeHostComponentIdV4;
  readonly implementationRevision: string;
  readonly path: string;
  readonly sha256: string;
  readonly interfaceHash: string;
  readonly qualificationEvidenceHash: string;
  readonly dependencies: readonly RuntimeHostComponentDependencyV4[];
  readonly certificationHash: string;
}

export interface RuntimeHostCompositionBindingV4 {
  readonly integrationEvidenceHash: string;
  readonly components: readonly RuntimeHostComponentBindingV4[];
  readonly compositionCertificationHash: string;
}

function invalid(message: string): never { throw new Error(`INVALID_CONTRACT: ${message}`); }

function exactKeys(value: Record<string, unknown>, expected: readonly string[], message: string): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid(message);
}

export function runtimeHostComponentInterfaceHashV4(id: RuntimeHostComponentIdV4): string {
  return hashCanonicalV4({
    schema_version: 4,
    component_id: id,
    interface_contract: RUNTIME_HOST_COMPONENT_INTERFACE_CONTRACTS_V4[id],
    port_members: RUNTIME_HOST_COMPONENT_PORTS_V4[id],
  });
}

export function runtimeHostComponentPortMembersV4(id: RuntimeHostComponentIdV4): readonly RuntimeHostPortMemberV4[] {
  return RUNTIME_HOST_COMPONENT_PORTS_V4[id];
}

export function runtimeHostComponentCertificationHashV4(component: Omit<RuntimeHostComponentSourceV4, 'modulePath' | 'certificationHash'>): string {
  return hashCanonicalV4({
    schema_version: 4,
    component_id: component.id,
    implementation_revision: component.implementationRevision,
    module_sha256: component.moduleSha256,
    interface_hash: component.interfaceHash,
    qualification_evidence_hash: component.qualificationEvidenceHash,
    dependencies: component.dependencies.map((dependency) => ({ id: dependency.id, certificationHash: dependency.certificationHash })),
  });
}

export function runtimeHostCompositionCertificationHashV4(
  driverSha256: string,
  integrationEvidenceHash: string,
  components: readonly RuntimeHostComponentSourceV4[],
): string {
  return hashCanonicalV4({
    schema_version: 4,
    driver_sha256: driverSha256,
    integration_evidence_hash: integrationEvidenceHash,
    components: components.map((component) => ({ id: component.id, certification_hash: component.certificationHash })),
  });
}

export function loadRuntimeHostComponentSourceManifestV4(value: unknown): RuntimeHostComponentSourceManifestV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('host component source manifest is not an object');
  const item = value as Record<string, unknown>;
  exactKeys(item, ['schemaVersion', 'driverSha256', 'integrationEvidenceHash', 'components', 'compositionCertificationHash'], 'host component source manifest has unknown or missing fields');
  if (item.schemaVersion !== 4 || !HASH.test(String(item.driverSha256)) || !HASH.test(String(item.integrationEvidenceHash)) || !HASH.test(String(item.compositionCertificationHash))) invalid('host component source manifest identity is invalid');
  if (!Array.isArray(item.components) || item.components.length !== RUNTIME_HOST_COMPONENT_IDS_V4.length) invalid('host component source manifest is incomplete');

  const modulePaths = new Set<string>();
  const certifications = new Map<RuntimeHostComponentIdV4, string>();
  const components = item.components.map((raw, index): RuntimeHostComponentSourceV4 => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('host component declaration is invalid');
    const component = raw as Record<string, unknown>;
    exactKeys(component, ['id', 'implementationRevision', 'modulePath', 'moduleSha256', 'interfaceHash', 'qualificationEvidenceHash', 'dependencies', 'certificationHash'], 'host component declaration has unknown or missing fields');
    const expectedId = RUNTIME_HOST_COMPONENT_IDS_V4[index];
    if (component.id !== expectedId) invalid('host component declarations are missing, duplicated or out of order');
    const id = expectedId;
    if (typeof component.implementationRevision !== 'string' || !IMMUTABLE_REVISION.test(component.implementationRevision)) invalid(`host component ${id} revision is mutable or invalid`);
    if (typeof component.modulePath !== 'string' || !PORTABLE_MODULE_PATH.test(component.modulePath) || component.modulePath.split('/').some((part) => part === '.' || part === '..')) invalid(`host component ${id} module path is invalid`);
    const foldedPath = component.modulePath.toLocaleLowerCase('en-US');
    if (modulePaths.has(foldedPath)) invalid('host component module paths are ambiguous');
    modulePaths.add(foldedPath);
    if (!HASH.test(String(component.moduleSha256)) || !HASH.test(String(component.qualificationEvidenceHash)) || !HASH.test(String(component.certificationHash))) invalid(`host component ${id} hashes are invalid`);
    if (component.interfaceHash !== runtimeHostComponentInterfaceHashV4(id)) invalid(`host component ${id} interface drifted`);
    if (!Array.isArray(component.dependencies)) invalid(`host component ${id} dependencies are invalid`);
    const expectedDependencies = RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4[id];
    if (component.dependencies.length !== expectedDependencies.length) invalid(`host component ${id} dependencies drifted`);
    const dependencies = component.dependencies.map((rawDependency, dependencyIndex): RuntimeHostComponentDependencyV4 => {
      if (rawDependency === null || typeof rawDependency !== 'object' || Array.isArray(rawDependency)) invalid(`host component ${id} dependencies are invalid`);
      const dependency = rawDependency as Record<string, unknown>;
      exactKeys(dependency, ['id', 'certificationHash'], `host component ${id} dependency has unknown or missing fields`);
      const expectedDependencyId = expectedDependencies[dependencyIndex];
      if (dependency.id !== expectedDependencyId || dependency.certificationHash !== certifications.get(expectedDependencyId)) invalid(`host component ${id} dependencies drifted`);
      return Object.freeze({ id: expectedDependencyId, certificationHash: String(dependency.certificationHash) });
    });
    const loaded = Object.freeze({
      id,
      implementationRevision: component.implementationRevision,
      modulePath: component.modulePath,
      moduleSha256: String(component.moduleSha256),
      interfaceHash: String(component.interfaceHash),
      qualificationEvidenceHash: String(component.qualificationEvidenceHash),
      dependencies: Object.freeze(dependencies),
      certificationHash: String(component.certificationHash),
    });
    if (runtimeHostComponentCertificationHashV4(loaded) !== loaded.certificationHash) invalid(`host component ${id} certification drifted`);
    certifications.set(id, loaded.certificationHash);
    return loaded;
  });

  const frozenComponents = Object.freeze(components);
  if (runtimeHostCompositionCertificationHashV4(String(item.driverSha256), String(item.integrationEvidenceHash), frozenComponents) !== item.compositionCertificationHash) invalid('host composition certification drifted');

  return Object.freeze({
    schemaVersion: 4,
    driverSha256: String(item.driverSha256),
    integrationEvidenceHash: String(item.integrationEvidenceHash),
    components: frozenComponents,
    compositionCertificationHash: String(item.compositionCertificationHash),
  });
}

export function bindRuntimeHostCompositionV4(
  source: RuntimeHostComponentSourceManifestV4,
  installationRoot: string,
  driverSha256: string,
): RuntimeHostCompositionBindingV4 {
  const loaded = loadRuntimeHostComponentSourceManifestV4(structuredClone(source));
  if (!isAbsolute(installationRoot) || loaded.driverSha256 !== driverSha256) invalid('host composition does not bind the selected root driver');
  const components = loaded.components.map((component): RuntimeHostComponentBindingV4 => Object.freeze({
    id: component.id,
    implementationRevision: component.implementationRevision,
    path: join(installationRoot, 'host-components', `${component.id}.mjs`),
    sha256: component.moduleSha256,
    interfaceHash: component.interfaceHash,
    qualificationEvidenceHash: component.qualificationEvidenceHash,
    dependencies: component.dependencies,
    certificationHash: component.certificationHash,
  }));
  return Object.freeze({
    integrationEvidenceHash: loaded.integrationEvidenceHash,
    components: Object.freeze(components),
    compositionCertificationHash: loaded.compositionCertificationHash,
  });
}

export function loadRuntimeHostCompositionBindingV4(
  value: unknown,
  installationRoot: string,
  driverSha256: string,
): RuntimeHostCompositionBindingV4 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('host composition binding is invalid');
  const item = value as Record<string, unknown>;
  exactKeys(item, ['integrationEvidenceHash', 'components', 'compositionCertificationHash'], 'host composition binding has unknown or missing fields');
  if (!Array.isArray(item.components)) invalid('host composition binding is incomplete');
  const sourceComponents = item.components.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('host component binding is invalid');
    const component = raw as Record<string, unknown>;
    exactKeys(component, ['id', 'implementationRevision', 'path', 'sha256', 'interfaceHash', 'qualificationEvidenceHash', 'dependencies', 'certificationHash'], 'host component binding has unknown or missing fields');
    const id = RUNTIME_HOST_COMPONENT_IDS_V4[index];
    if (component.id !== id || component.path !== join(installationRoot, 'host-components', `${id}.mjs`)) invalid('host component binding path or identity drifted');
    return {
      id,
      implementationRevision: component.implementationRevision,
      modulePath: `host-components/${id}.mjs`,
      moduleSha256: component.sha256,
      interfaceHash: component.interfaceHash,
      qualificationEvidenceHash: component.qualificationEvidenceHash,
      dependencies: component.dependencies,
      certificationHash: component.certificationHash,
    };
  });
  const source = loadRuntimeHostComponentSourceManifestV4({
    schemaVersion: 4,
    driverSha256,
    integrationEvidenceHash: item.integrationEvidenceHash,
    components: sourceComponents,
    compositionCertificationHash: item.compositionCertificationHash,
  });
  return bindRuntimeHostCompositionV4(source, installationRoot, driverSha256);
}
