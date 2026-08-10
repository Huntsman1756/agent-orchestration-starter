import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  DOGFOOD_REQUIRED_METRICS_V1,
  DOGFOOD_STOP_CONDITIONS_V1,
  freezeDogfoodManifestV1,
  freezeDogfoodRunRecordV1,
  loadDogfoodManifestV1,
  loadDogfoodRunRecordV1,
  verifyDogfoodManifestV1,
  verifyDogfoodRunRecordV1,
  type DogfoodManifestInputV1,
  type DogfoodManifestV1,
  type DogfoodRunRecordInputV1,
} from '../src/pilot/dogfood-manifest.js';

const hash = (character: string) => character.repeat(64);
const sha = (character: string) => character.repeat(40);
const uniqueHash = (index: number) => `${index.toString(16).padStart(2, '0')}${'0'.repeat(62)}`;
const timestamp = '2026-08-10T12:00:00.000Z';

function input(overrides: Partial<DogfoodManifestInputV1> = {}): DogfoodManifestInputV1 {
  return {
    experiment_id: 'dogfood-v1-example',
    created_at: timestamp,
    repository: { repository_id: 'reference-repository', base_branch: 'main' },
    baseline: {
      runtime_commit_sha: sha('a'),
      policy_hash: hash('b'),
      profile_hash: hash('c'),
      worker_capability_hash: hash('d'),
      guidance_bundle_hash: hash('e'),
      harness_parser_hash: hash('f'),
      host_driver_hash: hash('1'),
      host_certification_hash: hash('2'),
      installation_manifest_hash: hash('3'),
      validation_surface_hash: hash('4'),
    },
    corpus_policy: {
      provenance: 'historical_commits',
      selection_rule_hash: hash('5'),
      solution_diff_available_to_workers: false,
      oracle_available_to_workers: false,
      oracle_storage: 'EVALUATOR_ONLY',
      worker_projection: 'CONTRACT_AND_FIXTURES_ONLY',
    },
    cases: Array.from({ length: 20 }, (_, index) => ({
      case_id: `case-${String(index + 1).padStart(2, '0')}`,
      task_id: `task-${String(index + 1).padStart(2, '0')}`,
      task_class: index % 2 === 0 ? 'localized' : 'cross-file-bounded',
      pair_id: `pair-${String(index + 1).padStart(2, '0')}`,
      base_sha: sha('a'),
      contract_hash: hash('6'),
      fixtures_hash: hash('7'),
      case_fingerprint: uniqueHash(index),
      validation_surface_hash: hash('4'),
      source_sensitivity: 'PUBLIC',
      risk_class: 'low',
      oracle: { kind: 'HISTORICAL_COMMIT', reference_commit_sha: sha('b'), outcome_hash: hash('8') },
    })),
    route_bindings: [
      { strategy: 'orchestrated', binding_ref: 'binding-orchestrated', binding_hash: hash('9'), qualification_hash: hash('a') },
      { strategy: 'frontier_execution', binding_ref: 'binding-frontier', binding_hash: hash('b'), qualification_hash: hash('c') },
    ],
    reviewer: {
      binding_ref: 'binding-reviewer',
      binding_hash: hash('d'),
      qualification_hash: hash('e'),
      review_policy_hash: hash('f'),
      evidence_packet_schema_hash: hash('1'),
      fresh_session_per_run: true,
      same_packet_shape: true,
      sees_executor_narrative: false,
      sees_other_route_result: false,
      scope: 'EVIDENCE_ONLY',
    },
    run_policy: {
      same_base_sha: true,
      same_fixtures: true,
      same_validation_surface: true,
      fresh_worktree_per_run: true,
      cross_run_workspace_reuse: false,
      post_acceptance_window_seconds: 86_400,
    },
    scheduling: {
      assignment_seed: 'dogfood-seed-2026-08-10',
      algorithm_version: 'hash-interleave-v1',
      max_consecutive_same_strategy: 2,
    },
    authority: {
      routing_decision: 'REPORT_ONLY',
      publication_mode: 'MANUAL_ONLY',
      runtime_may_reach: 'READY_FOR_PUBLICATION',
      auto_route_promotion: false,
      auto_push: false,
      auto_merge: false,
      auto_deploy: false,
      mutation_after_start: 'NEW_EXPERIMENT_REQUIRED',
    },
    required_metrics: [...DOGFOOD_REQUIRED_METRICS_V1],
    stop_conditions: [...DOGFOOD_STOP_CONDITIONS_V1],
    ...overrides,
  };
}

function recordInput(manifest: DogfoodManifestV1, overrides: Partial<DogfoodRunRecordInputV1> = {}): DogfoodRunRecordInputV1 {
  const scheduled = manifest.schedule[0]!;
  const currentCase = manifest.cases.find(value => value.case_id === scheduled.case_id)!;
  const routeBinding = manifest.route_bindings.find(value => value.strategy === scheduled.strategy)!;
  return {
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    run_id: 'run-dogfood-0001',
    schedule_ordinal: scheduled.ordinal,
    case_id: currentCase.case_id,
    task_id: currentCase.task_id,
    pair_id: currentCase.pair_id,
    strategy: scheduled.strategy,
    binding_ref: routeBinding.binding_ref,
    binding_hash: routeBinding.binding_hash,
    qualification_hash: routeBinding.qualification_hash,
    base_sha: currentCase.base_sha,
    contract_hash: currentCase.contract_hash,
    fixtures_hash: currentCase.fixtures_hash,
    case_fingerprint: currentCase.case_fingerprint,
    policy_hash: manifest.baseline.policy_hash,
    profile_hash: manifest.baseline.profile_hash,
    worker_capability_hash: manifest.baseline.worker_capability_hash,
    guidance_bundle_hash: manifest.baseline.guidance_bundle_hash,
    harness_parser_hash: manifest.baseline.harness_parser_hash,
    host_driver_hash: manifest.baseline.host_driver_hash,
    host_certification_hash: manifest.baseline.host_certification_hash,
    installation_manifest_hash: manifest.baseline.installation_manifest_hash,
    validation_surface_hash: currentCase.validation_surface_hash,
    started_at: timestamp,
    completed_at: '2026-08-10T12:00:02.000Z',
    outcome: 'ACCEPTED',
    first_pass_accepted: true,
    final_accepted: true,
    reviewer_rejected: false,
    repairs: 0,
    escalations: 0,
    attempts: 1,
    duration_ms: 2_000,
    currency: 'USD',
    observed_cost_micro_units: 100,
    human_interventions: 0,
    human_intervention_seconds: 0,
    human_intervention_cost_micro_units: 0,
    total_cost_to_accepted_result_micro_units: 100,
    changed_files: 1,
    changed_lines: 4,
    validation_failures: 0,
    false_acceptance: false,
    post_acceptance_window_closed: true,
    post_acceptance_defects: [],
    evidence_reconstructible: true,
    evidence_hashes: [hash('2')],
    cross_run_contamination: false,
    publication_state: 'MANUAL_PENDING',
    recorded_at: timestamp,
    ...overrides,
  };
}

test('freezes a deterministic, hash-bound interleaved dogfood manifest', () => {
  const first = freezeDogfoodManifestV1(input());
  const second = freezeDogfoodManifestV1(input());
  assert.deepEqual(first, second);
  assert.equal(first.schedule.length, 40);
  assert.notEqual(first.schedule_hash, hash('0'));
  assert.equal(verifyDogfoodManifestV1(first).ok, true);
  assert.equal(first.manifest_hash.length, 64);
  assert.ok(first.schedule.some(entry => entry.strategy === 'orchestrated'));
  assert.ok(first.schedule.some(entry => entry.strategy === 'frontier_execution'));
});

test('manifest verification rejects changed authority, reviewer isolation, and corpus leakage policy', () => {
  const frozen = freezeDogfoodManifestV1(input());
  const mutations: Array<[string, Record<string, unknown>, string]> = [
    ['routing promotion', { authority: { ...frozen.authority, auto_route_promotion: true } }, 'auto_route_promotion'],
    ['automatic publication', { authority: { ...frozen.authority, auto_merge: true } }, 'auto_merge'],
    ['reviewer narrative', { reviewer: { ...frozen.reviewer, sees_executor_narrative: true } }, 'sees_executor_narrative'],
    ['corpus solution diff', { corpus_policy: { ...frozen.corpus_policy, solution_diff_available_to_workers: true } }, 'solution_diff_available_to_workers'],
  ];
  for (const [name, mutation, expected] of mutations) {
    const result = verifyDogfoodManifestV1({ ...frozen, ...mutation, manifest_hash: hash('0') } as DogfoodManifestV1);
    assert.equal(result.ok, false, name);
    assert.match(result.errors.join('; '), new RegExp(expected, 'u'), name);
  }
});

test('manifest verification rejects a non-paired schedule or case-count drift', () => {
  const frozen = freezeDogfoodManifestV1(input());
  const schedule = frozen.schedule.map((entry, index) => index === 1 ? { ...entry, strategy: entry.strategy === 'orchestrated' ? 'frontier_execution' : 'orchestrated' } : entry);
  const invalidSchedule = { ...frozen, schedule, manifest_hash: hash('0') } as DogfoodManifestV1;
  assert.equal(verifyDogfoodManifestV1(invalidSchedule).ok, false);
  assert.throws(() => freezeDogfoodManifestV1(input({ cases: input().cases.slice(0, 19) })), /20.*30|case count/u);
});

test('run records prove exact manifest pairing and hash-bound evidence', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const record = freezeDogfoodRunRecordV1(recordInput(manifest));
  assert.equal(loadDogfoodRunRecordV1(record).record_hash, record.record_hash);
  assert.equal(verifyDogfoodRunRecordV1(manifest, record).ok, true);

  const changedBase = freezeDogfoodRunRecordV1(recordInput(manifest, { base_sha: sha('c') }));
  const result = verifyDogfoodRunRecordV1(manifest, changedBase);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /base_sha/u);
});

test('dogfood schemas compile independently and reject provider/model fields', async () => {
  const manifestSchema = JSON.parse(await readFile(new URL('../contracts/dogfood-manifest-v1.schema.json', import.meta.url), 'utf8')) as object;
  const recordSchema = JSON.parse(await readFile(new URL('../contracts/dogfood-run-record-v1.schema.json', import.meta.url), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(manifestSchema);
  const validateRecord = ajv.compile(recordSchema);
  const manifest = freezeDogfoodManifestV1(input());
  const record = freezeDogfoodRunRecordV1(recordInput(manifest));
  assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
  assert.equal(validateRecord(record), true, JSON.stringify(validateRecord.errors));
  assert.equal(validateManifest({ ...manifest, model: 'must-not-be-in-the-manifest' }), false);
});
