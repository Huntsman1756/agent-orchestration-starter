import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { verifyRuntimeRepositoryActivationV4, type RuntimeHostInstallationManifestV4, type RuntimeRepositoryActivationV4 } from './host-installation.js';

export interface RuntimeHostDriverContextV4 {
  readonly activation: RuntimeRepositoryActivationV4;
  readonly installation: RuntimeHostInstallationManifestV4;
}

export interface RuntimeHostDriverOperationsV4 {
  readonly daemon: () => Promise<void>;
  readonly mcpStdio: () => Promise<void>;
  readonly doctor: () => Promise<readonly string[]>;
  readonly status: (runId: string) => Promise<unknown>;
}

function unavailable(message: string): never { throw new Error(`CAPABILITY_UNVERIFIED: ${message}`); }

export async function loadRuntimeHostDriverV4(activationPath: string): Promise<RuntimeHostDriverOperationsV4> {
  const context = await verifyRuntimeRepositoryActivationV4(activationPath);
  const binding = context.installation.hostDriver;
  if (binding === null) unavailable('the installation has no trusted host driver');
  const bytes = await readFile(binding.path).catch(() => unavailable('the trusted host driver is unavailable'));
  if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256) unavailable('the trusted host driver drifted');
  const loaded = await import(`${pathToFileURL(binding.path).href}?sha256=${binding.sha256}`) as Record<string, unknown>;
  const factory = loaded.createRuntimeHostDriverV4;
  if (typeof factory !== 'function') unavailable('the trusted host driver does not export createRuntimeHostDriverV4');
  const operations = await (factory as (value: RuntimeHostDriverContextV4) => Promise<unknown> | unknown)(context);
  if (operations === null || typeof operations !== 'object' || Array.isArray(operations)) unavailable('the trusted host driver returned an invalid operation set');
  const candidate = operations as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'daemon,doctor,mcpStdio,status' || Object.values(candidate).some((value) => typeof value !== 'function')) unavailable('the trusted host driver operation set is incomplete');
  return Object.freeze(candidate) as unknown as RuntimeHostDriverOperationsV4;
}
