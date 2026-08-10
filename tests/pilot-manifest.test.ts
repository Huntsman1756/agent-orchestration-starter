import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

import type { PilotManifestV3 } from '../src/pilot/contracts.js';
import { canonicalize, hashCanonical } from '../src/pilot/canonical-json.js';
import {
  assignArms,
  freezeManifest,
  verifyManifest,
  type PilotManifestInputV3,
} from '../src/pilot/manifest.js';

const hash = (character: string) => character.repeat(64);
const timestamp = '2026-08-08T12:00:00.000Z';
const arms = ['A_STRONG_BASELINE', 'B_CHEAP_NO_EARLY_ESCALATION', 'C_ADAPTIVE_EARLY_ESCALATION'] as const;

function block(id: string, triplet: string, overrides: Record<string, unknown> = {}): PilotManifestV3['blocks'][number] {
  return {
    block_id: id,
    task_id: 'task-v3',
    matching_stratum: 'mechanical-low',
    pair_or_triplet_id: triplet,
    case_fingerprint: hash('a'),
    contract_hash: hash('b'),
    base_revision: hash('c'),
    clean_tree_hash: hash('9'),
    fixtures_hash: hash('d'),
    complexity_class: 'mechanical',
    risk_class: 'low',
    changed_line_band: '1-25',
    validation_surface: ['test', 'typecheck'],
    cheap_eligible: true,
    comparative_eligible: true,
    routing_selection_reason: 'preclassified',
    selected_executor_capability_initial: 'cheap',
    selected_executor_capability_final_expected: 'strong',
    exclusion_reason: null,
    ...overrides,
  } as PilotManifestV3['blocks'][number];
}

function input(overrides: Partial<PilotManifestInputV3> = {}): PilotManifestInputV3 {
  return {
    pilot_id: 'pilot-v3-001',
    pilot_schema_version: 3,
    created_at: timestamp,
    blocks: [
      block('block-a', 'triplet-1'),
      block('block-b', 'triplet-1', { selected_executor_capability_final_expected: 'cheap' }),
      block('block-c', 'triplet-1', { selected_executor_capability_initial: 'strong' }),
    ],
    assignment_seed: 'seed-v3',
    assignment_algorithm_version: 'stratified-v1',
    binding_policy_version: 'binding-policy-v1',
    binding_registry: [
      { binding_ref: 'binding-cheap-v1', capability_class: 'cheap', profile_hash: hash('e') },
      { binding_ref: 'binding-strong-v1', capability_class: 'strong', profile_hash: hash('f') },
    ],
    routing_reviewer_binding_ref: 'binding-strong-v1',
    routing_reviewer_capability: 'strong',
    review_mode: 'incremental_diff',
    routing_policy_version: 'routing-policy-v1',
    review_policy_version: 'review-policy-v1',
    state_machine_version: 'state-machine-v1',
    reducer_version: 'reducer-v1',
    isolation_policy_version: 'isolation-policy-v1',
    canonical_tree_algorithm_version: 'canonical-tree-v1',
    volatile_paths_policy_hash: hash('8'),
    stage_thresholds: {
      stage_1_blocks_per_arm: 10,
      stage_2_blocks_per_arm: 20,
      stage_3_max_blocks_per_arm: 30,
      material_improvement_rate: 0.15,
      economic_rejection_rate: 0.1,
      max_parent_rework_block_rate: 0.1,
      max_parent_rework_production_line_share: 0.1,
      max_escaped_material_defects: 0,
      max_escaped_high_defects: 0,
      max_escaped_critical_defects: 0,
      min_observed_cost_completeness: 0.9,
      min_observed_strong_token_completeness: 0.9,
      min_stratum_triplets_for_promotion: 10,
      confidence_level: 0.95,
      interval_algorithm_version: 'paired-bootstrap-v1',
      resampling_iterations: 1000,
    },
    post_acceptance_window: {
      duration_seconds: 604800,
      allowed_clock_skew_seconds: 60,
      closure_rule: 'elapsed_duration',
      late_evidence_policy: 'warn_next_evaluation',
      window_policy_version: 'window-policy-v1',
    },
    pricing_snapshot: {
      pricing_snapshot_id: 'pricing-v1',
      pricing_snapshot_hash: hash('0'),
      currency: 'EUR',
      unit_scale: 1000000,
      effective_at: timestamp,
      tariffs: [
        { binding_ref: 'binding-cheap-v1', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 2, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
        { binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 3, output_token_micro_units_per_token: 4, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: true },
      ],
    },
    ...overrides,
  } as PilotManifestInputV3;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withValidManifestHash(manifest: PilotManifestV3): PilotManifestV3 {
  const { manifest_hash: _manifestHash, ...withoutManifestHash } = manifest;
  return { ...withoutManifestHash, manifest_hash: hashCanonical(withoutManifestHash) } as PilotManifestV3;
}

function assertManifestRejection(manifest: PilotManifestV3, expectedReason: string, name: string): void {
  const result = verifyManifest(withValidManifestHash(manifest));
  assert.equal(result.ok, false, name);
  assert.ok(result.errors.some(error => error.includes(expectedReason)), `${name} must report ${expectedReason}: ${result.errors.join('; ')}`);
}

test('canonical JSON is byte-stable across key order and hashCanonical is reproducible', () => {
  const left = { z: [3, { b: true, a: null }], a: 'alpha' };
  const right = { a: 'alpha', z: [3, { a: null, b: true }] };

  assert.equal(canonicalize(left), '{"a":"alpha","z":[3,{"a":null,"b":true}]}');
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(hashCanonical(left), hashCanonical(right));
});

test('freezing excludes manifest and pricing self-hashes while retaining canonical hashes', () => {
  const frozen = freezeManifest(input());
  const changedSelfHashes = freezeManifest(input({
    pricing_snapshot: { ...input().pricing_snapshot, pricing_snapshot_hash: hash('9') },
  }));

  assert.equal(frozen.manifest_hash, changedSelfHashes.manifest_hash);
  assert.equal(frozen.pricing_snapshot.pricing_snapshot_hash, changedSelfHashes.pricing_snapshot.pricing_snapshot_hash);
  const { manifest_hash: _manifestHash, ...withoutManifestHash } = frozen;
  assert.equal(frozen.manifest_hash, hashCanonical(withoutManifestHash));
});

test('freezing classifies before deterministic seeded assignment and assigns each comparative triplet exactly once per arm', () => {
  const frozen = freezeManifest(input());
  const again = freezeManifest(input());
  const assignments = assignArms(frozen);

  assert.deepEqual(frozen.blocks.map(({ comparative_eligible, cheap_eligible }) => ({ comparative_eligible, cheap_eligible })), [
    { comparative_eligible: true, cheap_eligible: true },
    { comparative_eligible: true, cheap_eligible: true },
    { comparative_eligible: true, cheap_eligible: true },
  ]);
  assert.deepEqual(frozen.arm_assignments, again.arm_assignments);
  assert.deepEqual(assignments, frozen.arm_assignments);
  assert.deepEqual(assignments.map(assignment => assignment.pilot_arm).sort(), [...arms].sort());
  assert.equal(new Set(assignments.map(assignment => assignment.block_id)).size, 3);
});

test('verification rejects incomplete, unbalanced, duplicate, and non-equivalent comparative triplets', () => {
  const frozen = freezeManifest(input());
  const invalids = [
    ['incomplete', { ...frozen, blocks: frozen.blocks.slice(0, 2), arm_assignments: frozen.arm_assignments.slice(0, 2) }, 'comparative triplet must have exactly three members'],
    ['duplicate assignment', { ...frozen, arm_assignments: [...frozen.arm_assignments, frozen.arm_assignments[0]] }, 'duplicate arm assignment'],
    ['unbalanced arms', { ...frozen, arm_assignments: frozen.arm_assignments.map(assignment => ({ ...assignment, pilot_arm: 'A_STRONG_BASELINE' as const })) }, 'comparative triplet must contain exact A/B/C membership'],
    ['different matching stratum', { ...frozen, blocks: frozen.blocks.map((candidate, index) => index === 1 ? { ...candidate, matching_stratum: 'localized-low' } : candidate) }, 'comparative triplet must share a matching stratum'],
  ] as const;

  for (const [name, manifest, expectedReason] of invalids) assertManifestRejection(manifest as PilotManifestV3, expectedReason, name);
});

test('verification rejects each frozen equivalence mutation independently', () => {
  const frozen = freezeManifest(input());
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['contract hash', { contract_hash: hash('1') }],
    ['case fingerprint', { case_fingerprint: hash('2') }],
    ['base revision', { base_revision: hash('3') }],
    ['clean tree hash', { clean_tree_hash: hash('7') }],
    ['fixtures hash', { fixtures_hash: hash('4') }],
    ['validation surface', { validation_surface: ['lint'] }],
    ['complexity', { complexity_class: 'localized' }],
    ['risk', { risk_class: 'high' }],
    ['changed line band', { changed_line_band: '26-50' }],
    ['matching stratum', { matching_stratum: 'localized-low' }],
  ];

  for (const [name, mutation] of mutations) {
    const blocks = frozen.blocks.map((candidate, index) => index === 1 ? { ...candidate, ...mutation } : candidate) as PilotManifestV3['blocks'];
    const expectedReason = name === 'matching stratum'
      ? 'comparative triplet must share a matching stratum'
      : `comparative triplet differs in ${name === 'changed line band' ? 'changed_line_band' : name.replaceAll(' ', '_')}`;
    assertManifestRejection({ ...frozen, blocks }, expectedReason, name);
  }
});

test('classification rejects ineligible comparison and keeps direct-to-strong work descriptive and unassigned', () => {
  const invalidMatrices: Array<[Record<string, unknown>, string]> = [
    [{ cheap_eligible: false, comparative_eligible: true, risk_class: 'low', exclusion_reason: null }, 'comparative_eligible block must be cheap_eligible'],
    [{ cheap_eligible: true, comparative_eligible: true, risk_class: 'restricted', exclusion_reason: null }, 'comparative_eligible block cannot be restricted'],
    [{ cheap_eligible: true, comparative_eligible: true, risk_class: 'low', exclusion_reason: 'policy-exclusion' }, 'comparative_eligible block cannot have an exclusion reason'],
  ];
  for (const [invalid, expectedReason] of invalidMatrices) {
    assert.throws(() => freezeManifest(input({ blocks: [block('block-a', 'triplet-1', invalid), block('block-b', 'triplet-1'), block('block-c', 'triplet-1')] })), error => message(error).includes(expectedReason));
  }

  const direct = block('direct-strong', 'direct-only', {
    cheap_eligible: false,
    comparative_eligible: false,
    selected_executor_capability_initial: 'strong',
    selected_executor_capability_final_expected: 'strong',
    exclusion_reason: 'direct-to-strong',
  });
  const frozen = freezeManifest(input({ blocks: [...input().blocks, direct] }));
  assert.equal(frozen.arm_assignments.some(assignment => assignment.block_id === direct.block_id), false);
  assert.equal(verifyManifest(frozen).comparative_block_count, 3);
  assertManifestRejection({ ...frozen, arm_assignments: [...frozen.arm_assignments, { block_id: direct.block_id, pilot_arm: 'A_STRONG_BASELINE' }] }, 'direct block must remain unassigned', 'direct-to-strong assignment');
});

test('comparative blocks remain invalid when an A/B/C assignment is missing', () => {
  const frozen = freezeManifest(input());
  const missing = frozen.arm_assignments.slice(1);
  assertManifestRejection({ ...frozen, arm_assignments: missing }, 'comparative block lacks arm assignment', 'missing comparative assignment');
});

test('verification rejects initial and final executor capabilities that contradict each assigned arm', () => {
  const frozen = freezeManifest(input());
  const blockByArm = Object.fromEntries(frozen.arm_assignments.map(assignment => [
    assignment.pilot_arm,
    frozen.blocks.find(candidate => candidate.block_id === assignment.block_id)!,
  ])) as Record<typeof arms[number], PilotManifestV3['blocks'][number]>;
  const invalids: Array<[string, PilotManifestV3['blocks'][number], Record<string, unknown>, string]> = [
    ['A initial', blockByArm.A_STRONG_BASELINE, { selected_executor_capability_initial: 'cheap' }, 'A_STRONG_BASELINE route requires strong initial and final capability'],
    ['A final', blockByArm.A_STRONG_BASELINE, { selected_executor_capability_final_expected: 'cheap' }, 'A_STRONG_BASELINE route requires strong initial and final capability'],
    ['B initial', blockByArm.B_CHEAP_NO_EARLY_ESCALATION, { selected_executor_capability_initial: 'strong' }, 'B_CHEAP_NO_EARLY_ESCALATION route requires cheap initial and final capability'],
    ['B final', blockByArm.B_CHEAP_NO_EARLY_ESCALATION, { selected_executor_capability_final_expected: 'strong' }, 'B_CHEAP_NO_EARLY_ESCALATION route requires cheap initial and final capability'],
    ['C initial', blockByArm.C_ADAPTIVE_EARLY_ESCALATION, { selected_executor_capability_initial: 'strong' }, 'C_ADAPTIVE_EARLY_ESCALATION route requires cheap initial and strong final capability'],
    ['C final', blockByArm.C_ADAPTIVE_EARLY_ESCALATION, { selected_executor_capability_final_expected: 'cheap' }, 'C_ADAPTIVE_EARLY_ESCALATION route requires cheap initial and strong final capability'],
  ];

  for (const [name, target, mutation, expectedReason] of invalids) {
    const blocks = frozen.blocks.map(candidate => candidate.block_id === target.block_id ? { ...candidate, ...mutation } : candidate);
    assertManifestRejection({ ...frozen, blocks } as PilotManifestV3, expectedReason, name);
  }
});

test('verification binds registry, common reviewer and policy, isolation policy, pricing snapshot and typed thresholds', () => {
  const frozen = freezeManifest(input());
  const invalids: Array<[string, Partial<PilotManifestV3>, string]> = [
    ['duplicate binding registry', { binding_registry: [...frozen.binding_registry, { ...frozen.binding_registry[0] }] }, 'binding registry references must be unique'],
    ['malformed profile hash', { binding_registry: [{ ...frozen.binding_registry[0], profile_hash: 'not-a-hash' }] }, 'profile_hash'],
    ['unknown reviewer binding', { routing_reviewer_binding_ref: 'unknown-binding' }, 'routing reviewer binding must be registered'],
    ['reviewer capability mismatch', { routing_reviewer_capability: 'cheap' }, 'routing reviewer capability must match its binding'],
    ['non-incremental review policy', { review_mode: 'full-history' as 'incremental_diff' }, 'review_mode'],
    ['missing isolation policy', { isolation_policy_version: '' }, 'isolation_policy_version'],
    ['missing canonical tree algorithm', { canonical_tree_algorithm_version: '' }, 'canonical_tree_algorithm_version'],
    ['malformed volatile paths policy hash', { volatile_paths_policy_hash: 'not-a-hash' }, 'volatile_paths_policy_hash'],
    ['pricing snapshot self hash', { pricing_snapshot: { ...frozen.pricing_snapshot, pricing_snapshot_hash: hash('9') } }, 'pricing snapshot hash does not match canonical snapshot content'],
    ['invalid stage one threshold', { stage_thresholds: { ...frozen.stage_thresholds, stage_1_blocks_per_arm: 9 } as unknown as PilotManifestV3['stage_thresholds'] }, 'stage_1_blocks_per_arm'],
    ['invalid stage two threshold', { stage_thresholds: { ...frozen.stage_thresholds, stage_2_blocks_per_arm: 19 } as unknown as PilotManifestV3['stage_thresholds'] }, 'stage_2_blocks_per_arm'],
    ['invalid stage three threshold', { stage_thresholds: { ...frozen.stage_thresholds, stage_3_max_blocks_per_arm: 29 } as unknown as PilotManifestV3['stage_thresholds'] }, 'stage_3_max_blocks_per_arm'],
  ];
  for (const [name, mutation, expectedReason] of invalids) assertManifestRejection({ ...frozen, ...mutation } as PilotManifestV3, expectedReason, name);
});

test('the V3 pilot manifest example is a frozen and verified manifest', async () => {
  const example = parse(await readFile(new URL('../examples/pilot-manifest-v3.yaml', import.meta.url), 'utf8'));
  const result = verifyManifest(example);
  assert.equal(result.ok, true, result.errors.join('; '));
});
