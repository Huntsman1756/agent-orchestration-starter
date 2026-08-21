import { hashCanonical } from './canonical-json.js';
import type { PilotManifestV3 } from './contracts.js';
import { loadPilotManifestV3 } from './load.js';

const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;
const armCapabilities = {
  A_STRONG_BASELINE: { initial: 'strong', final: 'strong' },
  B_CHEAP_NO_EARLY_ESCALATION: { initial: 'cheap', final: 'cheap' },
  C_ADAPTIVE_EARLY_ESCALATION: { initial: 'cheap', final: 'strong' },
} as const;
const equivalentFields = [
  'case_fingerprint',
  'contract_hash',
  'base_revision',
  'clean_tree_hash',
  'fixtures_hash',
  'validation_surface',
  'complexity_class',
  'risk_class',
  'changed_line_band',
] as const;

export type ArmAssignmentV3 = PilotManifestV3['arm_assignments'][number];
export type PilotManifestInputV3 = Omit<PilotManifestV3, 'manifest_hash' | 'arm_assignments'>;
export type FrozenPilotManifestV3 = PilotManifestV3;
export type FrozenAssignmentInputV3 = Pick<PilotManifestV3, 'blocks' | 'assignment_seed' | 'assignment_algorithm_version'>;

export interface ManifestVerification {
  ok: boolean;
  errors: string[];
  comparative_block_count: number;
}

function omitSelfHash<T extends Record<string, unknown>>(value: T, key: string): Omit<T, typeof key> {
  const { [key]: _omitted, ...remaining } = value;
  return remaining;
}

function comparativeErrors(blocks: readonly PilotManifestV3['blocks'][number][]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const triplets = new Map<string, PilotManifestV3['blocks']>();
  for (const block of blocks) {
    const classification = block as unknown as {
      block_id: string;
      comparative_eligible: boolean;
      cheap_eligible: boolean;
      risk_class: string;
      exclusion_reason: unknown;
    };
    if (ids.has(classification.block_id)) errors.push(`duplicate block_id: ${classification.block_id}`);
    ids.add(classification.block_id);
    if (!classification.comparative_eligible) continue;
    if (!classification.cheap_eligible) errors.push(`comparative_eligible block must be cheap_eligible: ${classification.block_id}`);
    if (classification.risk_class === 'restricted')
      errors.push(`comparative_eligible block cannot be restricted: ${classification.block_id}`);
    if (classification.exclusion_reason !== null)
      errors.push(`comparative_eligible block cannot have an exclusion reason: ${classification.block_id}`);
    const members = triplets.get(block.pair_or_triplet_id) ?? [];
    members.push(block);
    triplets.set(block.pair_or_triplet_id, members);
  }
  for (const [tripletId, members] of triplets) {
    if (members.length !== arms.length) {
      errors.push(`comparative triplet must have exactly three members: ${tripletId}`);
      continue;
    }
    if (new Set(members.map((member) => member.matching_stratum)).size !== 1) {
      errors.push(`comparative triplet must share a matching stratum: ${tripletId}`);
    }
    for (const field of equivalentFields) {
      const baseline = hashCanonical(members[0][field]);
      if (members.some((member) => hashCanonical(member[field]) !== baseline)) {
        errors.push(`comparative triplet differs in ${field}: ${tripletId}`);
      }
    }
  }
  return errors;
}

function comparativeTriplets(input: FrozenAssignmentInputV3): Map<string, PilotManifestV3['blocks']> {
  const triplets = new Map<string, PilotManifestV3['blocks']>();
  for (const block of input.blocks) {
    if (!block.comparative_eligible) continue;
    const members = triplets.get(block.pair_or_triplet_id) ?? [];
    members.push(block);
    triplets.set(block.pair_or_triplet_id, members);
  }
  return triplets;
}

export function assignArms(input: FrozenAssignmentInputV3): ArmAssignmentV3[] {
  const errors = comparativeErrors(input.blocks);
  if (errors.length > 0) throw new Error(`Cannot assign comparative arms: ${errors.join('; ')}`);
  const assignments: ArmAssignmentV3[] = [];
  for (const [tripletId, members] of [...comparativeTriplets(input).entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const matchingStratum = members[0].matching_stratum;
    const rankedArms = [...arms].sort((left, right) =>
      hashCanonical({
        assignment_algorithm_version: input.assignment_algorithm_version,
        assignment_seed: input.assignment_seed,
        matching_stratum: matchingStratum,
        pair_or_triplet_id: tripletId,
        pilot_arm: left,
      }).localeCompare(
        hashCanonical({
          assignment_algorithm_version: input.assignment_algorithm_version,
          assignment_seed: input.assignment_seed,
          matching_stratum: matchingStratum,
          pair_or_triplet_id: tripletId,
          pilot_arm: right,
        }),
      ),
    );
    for (const [index, member] of [...members].sort((left, right) => left.block_id.localeCompare(right.block_id)).entries()) {
      assignments.push({ block_id: member.block_id, pilot_arm: rankedArms[index] });
    }
  }
  return assignments.sort((left, right) => left.block_id.localeCompare(right.block_id));
}

function manifestErrors(manifest: PilotManifestV3): string[] {
  const errors = comparativeErrors(manifest.blocks);
  const comparativeBlocks = manifest.blocks.filter((block) => block.comparative_eligible);
  const comparativeIds = new Set(comparativeBlocks.map((block) => block.block_id));
  const assignments = new Map<string, ArmAssignmentV3>();
  for (const assignment of manifest.arm_assignments) {
    if (assignments.has(assignment.block_id)) errors.push(`duplicate arm assignment: ${assignment.block_id}`);
    assignments.set(assignment.block_id, assignment);
    if (!comparativeIds.has(assignment.block_id)) errors.push(`direct block must remain unassigned: ${assignment.block_id}`);
  }
  for (const id of comparativeIds) if (!assignments.has(id)) errors.push(`comparative block lacks arm assignment: ${id}`);
  const blocksById = new Map(comparativeBlocks.map((block) => [block.block_id, block]));
  for (const [blockId, assignment] of assignments) {
    const block = blocksById.get(blockId);
    if (!block) continue;
    const expected = armCapabilities[assignment.pilot_arm];
    if (
      block.selected_executor_capability_initial !== expected.initial ||
      block.selected_executor_capability_final_expected !== expected.final
    ) {
      const required =
        expected.initial === expected.final
          ? `${expected.initial} initial and final capability`
          : `${expected.initial} initial and ${expected.final} final capability`;
      errors.push(`${assignment.pilot_arm} route requires ${required}: ${blockId}`);
    }
  }
  for (const [tripletId, members] of comparativeTriplets(manifest)) {
    if (members.length === arms.length) {
      const assignedArms = members.map((member) => assignments.get(member.block_id)?.pilot_arm);
      if (new Set(assignedArms).size !== arms.length) errors.push(`comparative triplet must contain exact A/B/C membership: ${tripletId}`);
    }
  }

  const registry = new Map(manifest.binding_registry.map((binding) => [binding.binding_ref, binding]));
  if (registry.size !== manifest.binding_registry.length) errors.push('binding registry references must be unique');
  const reviewer = registry.get(manifest.routing_reviewer_binding_ref);
  if (!reviewer) errors.push('routing reviewer binding must be registered');
  else if (reviewer.capability_class !== manifest.routing_reviewer_capability)
    errors.push('routing reviewer capability must match its binding');
  const tariffBindings = new Set<string>();
  if (!Number.isSafeInteger(manifest.pricing_snapshot.unit_scale) || manifest.pricing_snapshot.unit_scale <= 0)
    errors.push('pricing snapshot unit scale must be a positive safe integer');
  for (const tariff of manifest.pricing_snapshot.tariffs) {
    if (!registry.has(tariff.binding_ref)) errors.push(`pricing tariff must reference a registered binding: ${tariff.binding_ref}`);
    if (tariffBindings.has(tariff.binding_ref)) errors.push(`pricing tariff binding appears more than once: ${tariff.binding_ref}`);
    tariffBindings.add(tariff.binding_ref);
    for (const value of [
      tariff.input_token_micro_units_per_token,
      tariff.output_token_micro_units_per_token,
      tariff.cached_input_token_micro_units_per_token,
      tariff.reasoning_token_micro_units_per_token,
    ]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        errors.push(`pricing tariff contains unsafe integer: ${tariff.binding_ref}`);
    }
  }
  for (const binding of registry.keys())
    if (!tariffBindings.has(binding)) errors.push(`pricing snapshot lacks tariff for registered binding: ${binding}`);
  if (manifest.stage_thresholds.min_stratum_triplets_for_promotion > manifest.stage_thresholds.stage_3_max_blocks_per_arm) {
    errors.push('minimum stratum triplets cannot exceed stage three maximum');
  }
  if (manifest.pricing_snapshot.pricing_snapshot_hash !== hashCanonical(omitSelfHash(manifest.pricing_snapshot, 'pricing_snapshot_hash'))) {
    errors.push('pricing snapshot hash does not match canonical snapshot content');
  }
  if (manifest.manifest_hash !== hashCanonical(omitSelfHash(manifest, 'manifest_hash'))) {
    errors.push('manifest hash does not match canonical manifest content');
  }
  return errors;
}

export function verifyManifest(manifest: PilotManifestV3): ManifestVerification {
  const errors: string[] = [];
  try {
    loadPilotManifestV3(manifest);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length === 0) errors.push(...manifestErrors(manifest));
  return {
    ok: errors.length === 0,
    errors,
    comparative_block_count: manifest.blocks.filter((block) => block.comparative_eligible).length,
  };
}

export function freezeManifest(input: PilotManifestInputV3): FrozenPilotManifestV3 {
  const classificationErrors = comparativeErrors(input.blocks);
  if (classificationErrors.length > 0) throw new Error(`Cannot freeze manifest: ${classificationErrors.join('; ')}`);
  const pricing_snapshot = {
    ...input.pricing_snapshot,
    pricing_snapshot_hash: hashCanonical(omitSelfHash(input.pricing_snapshot, 'pricing_snapshot_hash')),
  };
  const arm_assignments = assignArms(input);
  const draft = { ...input, pricing_snapshot, arm_assignments, manifest_hash: '' };
  const manifest = { ...draft, manifest_hash: hashCanonical(omitSelfHash(draft, 'manifest_hash')) };
  const parsed = loadPilotManifestV3(manifest);
  const verification = verifyManifest(parsed);
  if (!verification.ok) throw new Error(`Cannot freeze manifest: ${verification.errors.join('; ')}`);
  return parsed;
}
