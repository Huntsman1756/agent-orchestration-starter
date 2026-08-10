import { z } from 'zod';

import { hashCanonicalV4 } from './canonical.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const unique = <T extends z.ZodTypeAny>(schema: T, max: number, min = 0) => z.array(schema).min(min).max(max).refine((items) => new Set(items).size === items.length, 'items must be unique');
const contractBody = z.object({
  schema_version: z.literal(4),
  contract_id: id,
  role: z.enum(['ORCHESTRATOR', 'ECONOMY_EXECUTOR', 'FRONTIER_EXECUTOR', 'REVIEWER']),
  structured_output: z.boolean(),
  tool_protocol: z.enum(['NONE', 'NATIVE']),
  filesystem: z.enum(['NONE', 'READ_ONLY', 'CONTRACT_WRITE']),
  network: z.enum(['DENIED', 'BROKER_GATEWAY']),
  context_mode: z.enum(['FRESH_PER_ATTEMPT', 'PERSISTENT']),
  max_steps: z.number().int().min(1).max(128),
  reasoning_efforts: unique(id, 16, 1),
  temperature_control: z.boolean(),
}).strict();
const contractSchema = contractBody.extend({ contract_hash: hash }).strict();
const adapterBody = z.object({
  schema_version: z.literal(4),
  adapter_id: id,
  structured_output: z.boolean(),
  tool_protocols: unique(z.enum(['NONE', 'NATIVE']), 2, 1),
  filesystems: unique(z.enum(['NONE', 'READ_ONLY', 'CONTRACT_WRITE']), 3, 1),
  networks: unique(z.enum(['DENIED', 'BROKER_GATEWAY']), 2, 1),
  context_modes: unique(z.enum(['FRESH_PER_ATTEMPT', 'PERSISTENT']), 2, 1),
  max_steps: z.number().int().min(1).max(128),
  reasoning_efforts: unique(id, 16, 1),
  temperature_control: z.boolean(),
}).strict();
const adapterSchema = adapterBody.extend({ capability_hash: hash }).strict();

export type ModelCapabilityContractV4 = z.infer<typeof contractSchema>;
export type ModelAdapterCapabilitiesV4 = z.infer<typeof adapterSchema>;
export interface CapabilityMatchV4 { readonly compatible: true; readonly contract_hash: string; readonly capability_hash: string; readonly match_hash: string; }

function exactHash(value: Record<string, unknown>, field: string, label: string): void {
  const body = { ...value };
  const supplied = body[field];
  delete body[field];
  if (supplied !== hashCanonicalV4(body)) throw new Error(`CAPABILITY_UNVERIFIED: ${label} hash is invalid`);
}

export function createModelCapabilityContractV4(input: z.input<typeof contractBody>): ModelCapabilityContractV4 {
  const body = contractBody.parse(structuredClone(input));
  return Object.freeze({ ...body, reasoning_efforts: Object.freeze([...body.reasoning_efforts]), contract_hash: hashCanonicalV4(body) }) as unknown as ModelCapabilityContractV4;
}

export function createModelAdapterCapabilitiesV4(input: z.input<typeof adapterBody>): ModelAdapterCapabilitiesV4 {
  const body = adapterBody.parse(structuredClone(input));
  return Object.freeze({ ...body, tool_protocols: Object.freeze([...body.tool_protocols]), filesystems: Object.freeze([...body.filesystems]), networks: Object.freeze([...body.networks]), context_modes: Object.freeze([...body.context_modes]), reasoning_efforts: Object.freeze([...body.reasoning_efforts]), capability_hash: hashCanonicalV4(body) }) as unknown as ModelAdapterCapabilitiesV4;
}

export function matchModelCapabilitiesV4(contractInput: unknown, adapterInput: unknown): CapabilityMatchV4 {
  const parsedContract = contractSchema.safeParse(structuredClone(contractInput));
  const parsedAdapter = adapterSchema.safeParse(structuredClone(adapterInput));
  if (!parsedContract.success || !parsedAdapter.success) throw new Error('CAPABILITY_UNVERIFIED: capability contract is invalid');
  const contract = parsedContract.data;
  const adapter = parsedAdapter.data;
  exactHash(contract as unknown as Record<string, unknown>, 'contract_hash', 'contract');
  exactHash(adapter as unknown as Record<string, unknown>, 'capability_hash', 'adapter capability');
  const compatible = (!contract.structured_output || adapter.structured_output)
    && adapter.tool_protocols.includes(contract.tool_protocol)
    && adapter.filesystems.includes(contract.filesystem)
    && adapter.networks.includes(contract.network)
    && adapter.context_modes.includes(contract.context_mode)
    && adapter.max_steps >= contract.max_steps
    && contract.reasoning_efforts.every((effort) => adapter.reasoning_efforts.includes(effort))
    && (!contract.temperature_control || adapter.temperature_control);
  if (!compatible) throw new Error('CAPABILITY_UNVERIFIED: adapter does not satisfy the selected role contract');
  return Object.freeze({ compatible: true, contract_hash: contract.contract_hash, capability_hash: adapter.capability_hash, match_hash: hashCanonicalV4({ contract_hash: contract.contract_hash, capability_hash: adapter.capability_hash }) });
}
