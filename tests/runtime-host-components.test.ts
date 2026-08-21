import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { hashCanonicalV4 } from '../src/runtime/canonical.js';
import {
  RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4,
  RUNTIME_HOST_COMPONENT_IDS_V4,
  loadRuntimeHostComponentSourceManifestV4,
  runtimeHostComponentInterfaceHashV4,
  runtimeHostComponentPortMembersV4,
} from '../src/runtime/host-components.js';
import { validateRuntimeGitHubCredentialLeaseV4 } from '../src/runtime/host-component-ports.js';

const hash = (value: number): string => value.toString(16).padStart(64, '0');

function sourceManifest(): Record<string, unknown> {
  const driverSha256 = hash(800);
  const certifications = new Map<string, string>();
  const components = RUNTIME_HOST_COMPONENT_IDS_V4.map((id, index) => {
    const dependencies = RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4[id].map((dependencyId) => ({
      id: dependencyId,
      certificationHash: certifications.get(dependencyId)!,
    }));
    const body = {
      schema_version: 4,
      component_id: id,
      implementation_revision: 'a'.repeat(40),
      module_sha256: hash(index + 1),
      interface_hash: runtimeHostComponentInterfaceHashV4(id),
      qualification_evidence_hash: hash(index + 101),
      dependencies,
    };
    const certificationHash = hashCanonicalV4(body);
    certifications.set(id, certificationHash);
    return {
      id,
      implementationRevision: body.implementation_revision,
      modulePath: `components/${id}.mjs`,
      moduleSha256: body.module_sha256,
      interfaceHash: body.interface_hash,
      qualificationEvidenceHash: body.qualification_evidence_hash,
      dependencies,
      certificationHash,
    };
  });
  const integrationEvidenceHash = hash(900);
  return {
    schemaVersion: 4,
    driverSha256,
    integrationEvidenceHash,
    components,
    compositionCertificationHash: hashCanonicalV4({
      schema_version: 4,
      driver_sha256: driverSha256,
      integration_evidence_hash: integrationEvidenceHash,
      components: components.map((component) => ({ id: component.id, certification_hash: component.certificationHash })),
    }),
  };
}

test('loads one immutable, separately qualified binding for every trusted host component', () => {
  const loaded = loadRuntimeHostComponentSourceManifestV4(sourceManifest());

  assert.deepEqual(
    loaded.components.map((component) => component.id),
    RUNTIME_HOST_COMPONENT_IDS_V4,
  );
  assert.equal(loaded.components[0]?.modulePath, 'components/credential_gateway.mjs');
  assert.equal(loaded.components[1]?.id, 'task_source');
  assert.equal(loaded.components[1]?.dependencies[0]?.id, 'credential_gateway');
  assert.deepEqual(
    runtimeHostComponentPortMembersV4('credential_gateway').map((member) => member.name),
    ['leaseProvider', 'leaseGitHub', 'revoke'],
  );
  assert.equal(loaded.compositionCertificationHash, sourceManifest().compositionCertificationHash);
  assert.equal(Object.isFrozen(loaded.components), true);
  assert.equal(Object.isFrozen(loaded.components[0]?.dependencies), true);
  assert.equal(Object.isFrozen(runtimeHostComponentPortMembersV4('task_source')[0]), true);
});

test('rejects incomplete, mutable, ambiguous or interface-drifting component declarations', () => {
  const cases = [
    { ...sourceManifest(), components: (sourceManifest().components as unknown[]).slice(1) },
    {
      ...sourceManifest(),
      components: (sourceManifest().components as Record<string, unknown>[]).map((item, index) =>
        index === 1 ? { ...item, id: 'credential_gateway' } : item,
      ),
    },
    {
      ...sourceManifest(),
      components: (sourceManifest().components as Record<string, unknown>[]).map((item, index) =>
        index === 0 ? { ...item, implementationRevision: 'main' } : item,
      ),
    },
    {
      ...sourceManifest(),
      components: (sourceManifest().components as Record<string, unknown>[]).map((item, index) =>
        index === 0 ? { ...item, interfaceHash: hash(999) } : item,
      ),
    },
    {
      ...sourceManifest(),
      components: (sourceManifest().components as Record<string, unknown>[]).map((item, index) =>
        index === 0 ? { ...item, modulePath: '../outside.mjs' } : item,
      ),
    },
    {
      ...sourceManifest(),
      components: (sourceManifest().components as Record<string, unknown>[]).map((item, index) =>
        index === 1 ? { ...item, dependencies: [] } : item,
      ),
    },
  ];

  for (const value of cases) {
    assert.throws(() => loadRuntimeHostComponentSourceManifestV4(value), /INVALID_CONTRACT/u);
  }
});

test('rejects a component update until every dependent certification and the aggregate composition are renewed', () => {
  const source = sourceManifest();
  const components = source.components as Record<string, unknown>[];
  const gateway = components.find((component) => component.id === 'credential_gateway')!;
  const changedBody = {
    schema_version: 4,
    component_id: gateway.id,
    implementation_revision: 'b'.repeat(40),
    module_sha256: hash(777),
    interface_hash: gateway.interfaceHash,
    qualification_evidence_hash: hash(778),
    dependencies: gateway.dependencies,
  };
  const changedGateway = {
    ...gateway,
    implementationRevision: changedBody.implementation_revision,
    moduleSha256: changedBody.module_sha256,
    qualificationEvidenceHash: changedBody.qualification_evidence_hash,
    certificationHash: hashCanonicalV4(changedBody),
  };
  const partiallyRecertified = {
    ...source,
    components: components.map((component) => (component.id === 'credential_gateway' ? changedGateway : component)),
  };

  assert.throws(
    () => loadRuntimeHostComponentSourceManifestV4(partiallyRecertified),
    /dependencies drifted|composition certification drifted/u,
  );
});

test('publishes a strict source-manifest schema for independently certified components', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/runtime-host-components-v4.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const source = sourceManifest();

  assert.equal(validate(source), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...source, unexpectedAuthority: true }), false);
});

test('GitHub adapters receive only a bounded internal gateway lease, never the real credential', () => {
  const lease = {
    lease_id: 'lease_github_00000001',
    repository_id: 'example-repository',
    remote: 'origin',
    environment: { GITHUB_GATEWAY_TOKEN: 'broker-gateway' as const },
    gateway_endpoint: 'http://github-gateway:8081' as const,
    internal_network: 'ao-int-github-example-0001',
    expires_at: '2026-08-10T12:10:00.000Z',
  };

  const validated = validateRuntimeGitHubCredentialLeaseV4(lease, '2026-08-10T12:00:00.000Z');
  assert.equal(Object.isFrozen(validated.environment), true);
  assert.throws(
    () =>
      validateRuntimeGitHubCredentialLeaseV4({ ...lease, environment: { GH_TOKEN: 'real-secret' } } as never, '2026-08-10T12:00:00.000Z'),
    /AUTHENTICATION_FAILED/u,
  );
  assert.throws(
    () => validateRuntimeGitHubCredentialLeaseV4({ ...lease, expires_at: '2026-08-10T11:59:00.000Z' }, '2026-08-10T12:00:00.000Z'),
    /AUTHENTICATION_FAILED/u,
  );
});
