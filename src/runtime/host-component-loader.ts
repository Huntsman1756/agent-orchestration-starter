import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { RuntimeHostInstallationManifestV4, RuntimeRepositoryActivationV4 } from './host-installation.js';
import { RUNTIME_HOST_COMPONENT_IDS_V4, type RuntimeHostComponentBindingV4, type RuntimeHostComponentIdV4 } from './host-components.js';
import { validateRuntimeHostComponentPortV4, type RuntimeHostComponentPortV4, type RuntimeHostComponentSetV4 } from './host-component-ports.js';

export interface RuntimeHostComponentFactoryContextV4 {
  readonly component: RuntimeHostComponentBindingV4;
  readonly repository: {
    readonly id: string;
    readonly root: string;
    readonly stateDirectory: string;
    readonly target: RuntimeRepositoryActivationV4['target'];
  };
  readonly dependencies: Readonly<Partial<RuntimeHostComponentSetV4>>;
}

function unavailable(message: string): never { throw new Error(`CAPABILITY_UNVERIFIED: ${message}`); }

export async function loadRuntimeHostComponentsV4(input: {
  readonly activation: RuntimeRepositoryActivationV4;
  readonly installation: RuntimeHostInstallationManifestV4;
}): Promise<RuntimeHostComponentSetV4> {
  const composition = input.installation.hostComposition;
  if (composition === null) unavailable('the installation has no certified host component composition');
  const loadedComponents: Partial<Record<RuntimeHostComponentIdV4, RuntimeHostComponentPortV4>> = {};
  for (const binding of composition.components) {
    const bytes = await readFile(binding.path).catch(() => unavailable(`host component ${binding.id} is unavailable`));
    if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256) unavailable(`host component ${binding.id} drifted`);
    const module = await import(`${pathToFileURL(binding.path).href}?certification=${binding.certificationHash}`) as Record<string, unknown>;
    if (Object.keys(module).join(',') !== 'createRuntimeHostComponentV4' || typeof module.createRuntimeHostComponentV4 !== 'function') unavailable(`host component ${binding.id} does not export exactly createRuntimeHostComponentV4`);
    const dependencies: Partial<RuntimeHostComponentSetV4> = {};
    for (const dependency of binding.dependencies) {
      const port = loadedComponents[dependency.id];
      if (port === undefined) unavailable(`host component ${binding.id} dependency ${dependency.id} is unavailable`);
      Object.assign(dependencies, { [dependency.id]: port });
    }
    const context: RuntimeHostComponentFactoryContextV4 = Object.freeze({
      component: binding,
      repository: Object.freeze({
        id: input.activation.repositoryId,
        root: input.activation.repositoryRoot,
        stateDirectory: input.activation.stateDirectory,
        target: input.activation.target,
      }),
      dependencies: Object.freeze(dependencies),
    });
    const factory = module.createRuntimeHostComponentV4 as (context: RuntimeHostComponentFactoryContextV4) => Promise<unknown> | unknown;
    loadedComponents[binding.id] = validateRuntimeHostComponentPortV4(binding.id, await factory(context));
  }
  if (RUNTIME_HOST_COMPONENT_IDS_V4.some((id) => loadedComponents[id] === undefined)) unavailable('the host component composition is incomplete');
  return Object.freeze(loadedComponents) as unknown as RuntimeHostComponentSetV4;
}
