import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJsonV4 } from '../src/runtime/canonical.js';
import {
  RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4,
  RUNTIME_HOST_COMPONENT_IDS_V4,
  runtimeHostComponentCertificationHashV4,
  runtimeHostCompositionCertificationHashV4,
  runtimeHostComponentInterfaceHashV4,
  runtimeHostComponentPortMembersV4,
  type RuntimeHostComponentIdV4,
  type RuntimeHostComponentSourceManifestV4,
} from '../src/runtime/host-components.js';

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function componentModule(id: RuntimeHostComponentIdV4): string {
  const entries = runtimeHostComponentPortMembersV4(id).map((member) => member.kind === 'string'
    ? `${JSON.stringify(member.name)}:${JSON.stringify(`fixture-${id}`)}`
    : `${JSON.stringify(member.name)}:async()=>undefined`);
  const dependencies = JSON.stringify(RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4[id]);
  return `export function createRuntimeHostComponentV4(context){if(JSON.stringify(Object.keys(context.dependencies))!==${JSON.stringify(dependencies)})throw new Error("unexpected dependencies");return {${entries.join(',')}}}\n`;
}

export interface RuntimeHostFixtureV4 {
  readonly root: string;
  readonly driverSource: string;
  readonly componentManifestPath: string;
  readonly componentManifest: RuntimeHostComponentSourceManifestV4;
}

export async function createRuntimeHostFixtureV4(input: {
  readonly componentModules?: Partial<Record<RuntimeHostComponentIdV4, string>>;
  readonly driverSource?: string;
} = {}): Promise<RuntimeHostFixtureV4> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-host-driver-source-')));
  const componentsRoot = join(root, 'components');
  await mkdir(componentsRoot, { recursive: true });
  const driver = input.driverSource ?? 'export function createRuntimeHostDriverV4(context){if(Object.keys(context.components).length!==8)throw new Error("missing components");return {daemon:async()=>{},doctor:async()=>["ready"],mcpStdio:async()=>{},status:async(id)=>({run_id:id})}}\n';
  const driverSource = join(root, 'driver.mjs');
  await writeFile(driverSource, driver);
  const certifications = new Map<RuntimeHostComponentIdV4, string>();
  const components = [] as Array<RuntimeHostComponentSourceManifestV4['components'][number]>;
  for (const [index, id] of RUNTIME_HOST_COMPONENT_IDS_V4.entries()) {
    const module = input.componentModules?.[id] ?? componentModule(id);
    const modulePath = `components/${id}.mjs`;
    await writeFile(join(root, ...modulePath.split('/')), module);
    const dependencies = RUNTIME_HOST_COMPONENT_DEPENDENCIES_V4[id].map((dependencyId) => Object.freeze({
      id: dependencyId,
      certificationHash: certifications.get(dependencyId)!,
    }));
    const body = {
      schema_version: 4,
      component_id: id,
      implementation_revision: (index + 1).toString(16).padStart(40, '0'),
      module_sha256: sha256(module),
      interface_hash: runtimeHostComponentInterfaceHashV4(id),
      qualification_evidence_hash: sha256(`qualification:${id}`),
      dependencies,
    };
    const certificationHash = runtimeHostComponentCertificationHashV4({
      id,
      implementationRevision: body.implementation_revision,
      moduleSha256: body.module_sha256,
      interfaceHash: body.interface_hash,
      qualificationEvidenceHash: body.qualification_evidence_hash,
      dependencies,
    });
    certifications.set(id, certificationHash);
    components.push(Object.freeze({
      id,
      implementationRevision: body.implementation_revision,
      modulePath,
      moduleSha256: body.module_sha256,
      interfaceHash: body.interface_hash,
      qualificationEvidenceHash: body.qualification_evidence_hash,
      dependencies: Object.freeze(dependencies),
      certificationHash,
    }));
  }
  const driverSha256 = sha256(driver);
  const integrationEvidenceHash = sha256('integration:eight-components');
  const componentManifest = Object.freeze({
    schemaVersion: 4 as const,
    driverSha256,
    integrationEvidenceHash,
    components: Object.freeze(components),
    compositionCertificationHash: runtimeHostCompositionCertificationHashV4(driverSha256, integrationEvidenceHash, components),
  });
  const componentManifestPath = join(root, 'host-components-v4.json');
  await writeFile(componentManifestPath, `${canonicalJsonV4(componentManifest)}\n`);
  return Object.freeze({ root, driverSource, componentManifestPath, componentManifest });
}
