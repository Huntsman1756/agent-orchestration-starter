import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  DOGFOOD_REQUIRED_METRICS_V1,
  DOGFOOD_STOP_CONDITIONS_V1,
  freezeDogfoodManifestV1,
  freezeDogfoodRunRecordV1,
  freezeDogfoodStopEventV1,
  verifyDogfoodRunSetV1,
  loadDogfoodManifestV1,
  loadDogfoodRunRecordV1,
  verifyDogfoodManifestV1,
  verifyDogfoodRunRecordV1,
  verifyDogfoodStopEventV1,
  type DogfoodManifestInputV1,
  type DogfoodManifestV1,
  type DogfoodRunRecordV1,
  type DogfoodRunRecordInputV1,
  type DogfoodStopEventInputV1,
} from '../src/pilot/dogfood-manifest.js';
import { hashCanonical } from '../src/pilot/canonical-json.js';
import type { BindingRegistryV3, PricingSnapshotV3, UsageRecordedV3 } from '../src/pilot/usage-cost.js';

const hash = (character: string) => character.repeat(64);
const sha = (character: string) => character.repeat(40);
const uniqueHash = (index: number) => `${index.toString(16).padStart(2, '0')}${'0'.repeat(62)}`;
const timestamp = '2026-08-10T12:00:00.000Z';
const timestampAt = (seconds: number) => new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();

function pricingSnapshot(): PricingSnapshotV3 {
  const content: Omit<PricingSnapshotV3, 'pricing_snapshot_hash'> = {
    pricing_snapshot_id: 'pricing-v1',
    currency: 'USD',
    unit_scale: 1_000_000,
    effective_at: timestamp,
    tariffs: [
      { binding_ref: 'binding-orchestrated', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 0, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
      { binding_ref: 'binding-frontier', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 0, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
      { binding_ref: 'binding-reviewer', input_token_micro_units_per_token: 1, output_token_micro_units_per_token: 0, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
    ],
  };
  return { ...content, pricing_snapshot_hash: hashCanonical(content) };
}

function providerRegistry(manifest: DogfoodManifestV1): BindingRegistryV3 {
  return [...manifest.provider_usage_policy.binding_registry];
}

function providerUsage(bindingRef: string, runId: string, role: UsageRecordedV3['role']): UsageRecordedV3 {
  return {
    usage_id: `${runId}-${role}-usage`, attempt_number: 1, role, binding_ref: bindingRef,
    provider_usage_id: null, input_tokens_observed: 100, output_tokens_observed: 0,
    cached_input_tokens_observed: null, reasoning_tokens_observed: null,
    input_tokens_estimated: null, output_tokens_estimated: null, cached_input_tokens_estimated: null,
    reasoning_tokens_estimated: null, token_estimator_id: null, token_estimator_version: null,
    pricing_snapshot_id: 'pricing-v1', cost_observed: 100, cost_estimated: null, currency: 'USD',
    cost_provenance: 'TARIFF_REPRODUCED',
    ...(role === 'executor'
      ? { attempt_id: `${runId}-attempt-1`, review_id: null, orchestrator_operation_id: null }
      : role === 'reviewer'
        ? { attempt_id: null, review_id: `${runId}-review-1`, orchestrator_operation_id: null }
        : { attempt_id: null, review_id: null, orchestrator_operation_id: `${runId}-operation-1` }),
  };
}

function providerCostEvidence(manifest: DogfoodManifestV1, strategy: 'orchestrated' | 'frontier_execution', runId: string) {
  const snapshot = pricingSnapshot();
  const bindingRegistry = providerRegistry(manifest);
  const routeBinding = manifest.route_bindings.find(binding => binding.strategy === strategy)!;
  const usage = [providerUsage(routeBinding.binding_ref, runId, 'executor'), providerUsage(manifest.reviewer.binding_ref, runId, 'reviewer')];
  const usageEventBindings = usage.map((entry, index) => ({
    usage_id: entry.usage_id,
    run_id: runId,
    event_id: `evt-${runId}-${entry.role}`,
    event_hash: hash(index === 0 ? '3' : '4'),
  }));
  return {
    evidence_schema_version: 3 as const,
    pricing_snapshot: snapshot,
    binding_registry: [...bindingRegistry],
    usage,
    usage_event_bindings: usageEventBindings,
    usage_ledger_hash: hashCanonical({
      usage: [...usage].sort((left, right) => left.usage_id.localeCompare(right.usage_id)),
      usage_event_bindings: [...usageEventBindings].sort((left, right) => left.usage_id.localeCompare(right.usage_id)),
    }),
    binding_registry_hash: hashCanonical([...bindingRegistry].sort((left, right) => left.binding_ref.localeCompare(right.binding_ref))),
  };
}

function input(overrides: Partial<DogfoodManifestInputV1> = {}): DogfoodManifestInputV1 {
  const providerBindings = [
    { binding_ref: 'binding-orchestrated', capability_class: 'cheap' as const, profile_hash: hash('d') },
    { binding_ref: 'binding-frontier', capability_class: 'strong' as const, profile_hash: hash('4') },
    { binding_ref: 'binding-reviewer', capability_class: 'strong' as const, profile_hash: hash('8') },
  ];
  return {
    experiment_id: 'dogfood-v1-example',
    created_at: timestamp,
    repository: { repository_id: 'reference-repository', base_branch: 'main' },
    baseline: {
      runtime_commit_sha: sha('a'),
      policy_hash: hash('b'),
      host_driver_hash: hash('1'),
      host_certification_hash: hash('2'),
      installation_manifest_hash: hash('3'),
      validation_surface_hash: hash('4'),
    },
    cost_policy: {
      reporting_currency: 'USD',
      human_cost_micro_units_per_second: 25,
      conversion_policy_hash: pricingSnapshot().pricing_snapshot_hash,
      observed_cost_in_reporting_currency: true,
      usage_binding_refs: ['binding-orchestrated', 'binding-frontier', 'binding-reviewer'],
    },
    provider_usage_policy: {
      binding_registry: providerBindings,
      binding_registry_hash: hashCanonical([...providerBindings].sort((left, right) => left.binding_ref.localeCompare(right.binding_ref))),
      roles: {
        orchestrator: { allowed_binding_refs: ['binding-frontier'] },
        executor: { orchestrated: 'binding-orchestrated', frontier_execution: 'binding-frontier' },
        reviewer: { allowed_binding_refs: ['binding-reviewer'] },
      },
      required_usage_roles: ['executor', 'reviewer'],
    },
    analysis_policy_hash: hash('6'),
    corpus_policy: {
      provenance: 'historical_commits',
      selection_rule_hash: hash('7'),
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
      contract_hash: hash('8'),
      fixtures_hash: hash('9'),
      case_fingerprint: uniqueHash(index),
      validation_surface_hash: hash('4'),
      source_sensitivity: 'PUBLIC',
      risk_class: 'low',
      oracle: { kind: 'HISTORICAL_COMMIT', reference_commit_sha: sha('b'), outcome_hash: hash('a') },
    })),
    route_bindings: [
      {
        strategy: 'orchestrated',
        binding_ref: 'binding-orchestrated',
        binding_hash: hash('b'),
        qualification_hash: hash('c'),
        profile_hash: hash('d'),
        worker_capability_hash: hash('e'),
        guidance_bundle_hash: hash('f'),
        harness_parser_hash: hash('1'),
      },
      {
        strategy: 'frontier_execution',
        binding_ref: 'binding-frontier',
        binding_hash: hash('2'),
        qualification_hash: hash('3'),
        profile_hash: hash('4'),
        worker_capability_hash: hash('5'),
        guidance_bundle_hash: hash('6'),
        harness_parser_hash: hash('7'),
      },
    ],
    reviewer: {
      binding_ref: 'binding-reviewer',
      binding_hash: hash('d'),
      qualification_hash: hash('e'),
      profile_hash: hash('8'),
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
      execution_mode: 'STRICT_SERIAL',
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

function recordInput(manifest: DogfoodManifestV1, overrides: Partial<DogfoodRunRecordInputV1> = {}, scheduleOrdinal = manifest.schedule[0]!.ordinal): DogfoodRunRecordInputV1 {
  const scheduled = manifest.schedule.find(entry => entry.ordinal === scheduleOrdinal)!;
  const currentCase = manifest.cases.find(value => value.case_id === scheduled.case_id)!;
  const routeBinding = manifest.route_bindings.find(value => value.strategy === scheduled.strategy)!;
  const runId = overrides.run_id ?? 'run-dogfood-0001';
  const startedAt = timestampAt((scheduleOrdinal - 1) * 3);
  const completedAt = timestampAt((scheduleOrdinal - 1) * 3 + 2);
  return {
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    run_id: runId,
    schedule_ordinal: scheduled.ordinal,
    case_id: currentCase.case_id,
    task_id: currentCase.task_id,
    pair_id: currentCase.pair_id,
    strategy: scheduled.strategy,
    binding_ref: routeBinding.binding_ref,
    binding_hash: routeBinding.binding_hash,
    qualification_hash: routeBinding.qualification_hash,
    cost_policy_hash: hashCanonical(manifest.cost_policy),
    provider_cost_evidence: providerCostEvidence(manifest, scheduled.strategy, runId),
    base_sha: currentCase.base_sha,
    contract_hash: currentCase.contract_hash,
    fixtures_hash: currentCase.fixtures_hash,
    case_fingerprint: currentCase.case_fingerprint,
    policy_hash: manifest.baseline.policy_hash,
    profile_hash: routeBinding.profile_hash,
    worker_capability_hash: routeBinding.worker_capability_hash,
    guidance_bundle_hash: routeBinding.guidance_bundle_hash,
    harness_parser_hash: routeBinding.harness_parser_hash,
    host_driver_hash: manifest.baseline.host_driver_hash,
    host_certification_hash: manifest.baseline.host_certification_hash,
    installation_manifest_hash: manifest.baseline.installation_manifest_hash,
    validation_surface_hash: currentCase.validation_surface_hash,
    started_at: startedAt,
    completed_at: completedAt,
    outcome: 'ACCEPTED',
    first_pass_accepted: true,
    final_accepted: true,
    reviewer_rejected: false,
    repairs: 0,
    escalations: 0,
    attempts: 1,
    duration_ms: 2_000,
    currency: 'USD',
    observed_cost_micro_units: 200,
    human_interventions: 0,
    human_intervention_seconds: 0,
    human_intervention_cost_micro_units: 0,
    total_cost_to_accepted_result_micro_units: 200,
    frontier_usage_calls: scheduled.strategy === 'frontier_execution' ? 1 : 0,
    changed_files: 1,
    changed_lines: 4,
    validation_failures: 0,
    false_acceptance: false,
    post_acceptance_window_closed: true,
    post_acceptance_defects: [],
    evidence_reconstructible: true,
    evidence_hashes: [hash('2'), hash('3'), hash('4')],
    cross_run_contamination: false,
    publication_state: 'MANUAL_PENDING',
    recorded_at: timestampAt((scheduleOrdinal - 1) * 3 + 86_402),
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
  assert.throws(() => freezeDogfoodManifestV1(input({ cases: input().cases.slice(0, 19) })), /20|case count/u);
});

test('run records prove exact manifest pairing and hash-bound evidence', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const record = freezeDogfoodRunRecordV1(recordInput(manifest));
  assert.equal(loadDogfoodRunRecordV1(record).record_hash, record.record_hash);
  const recordVerification = verifyDogfoodRunRecordV1(manifest, record);
  assert.equal(recordVerification.ok, true, recordVerification.errors.join('; '));

  const changedBase = freezeDogfoodRunRecordV1(recordInput(manifest, { base_sha: sha('c') }));
  const result = verifyDogfoodRunRecordV1(manifest, changedBase);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /base_sha/u);

  const changedRouteCapability = freezeDogfoodRunRecordV1(recordInput(manifest, { worker_capability_hash: hash('0') }));
  const capabilityResult = verifyDogfoodRunRecordV1(manifest, changedRouteCapability);
  assert.equal(capabilityResult.ok, false);
  assert.match(capabilityResult.errors.join('; '), /worker_capability_hash/u);
});

test('run records require a real closed post-acceptance window and consistent timing', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const tooEarly = freezeDogfoodRunRecordV1(recordInput(manifest, { recorded_at: '2026-08-10T12:00:02.000Z' }));
  const earlyResult = verifyDogfoodRunRecordV1(manifest, tooEarly);
  assert.equal(earlyResult.ok, false);
  assert.match(earlyResult.errors.join('; '), /post-acceptance window/u);

  const inconsistent = freezeDogfoodRunRecordV1(recordInput(manifest, {
    completed_at: '2026-08-10T12:00:01.000Z',
    duration_ms: 2_000,
  }));
  const inconsistentResult = verifyDogfoodRunRecordV1(manifest, inconsistent);
  assert.equal(inconsistentResult.ok, false);
  assert.match(inconsistentResult.errors.join('; '), /duration_ms/u);

  const reversed = freezeDogfoodRunRecordV1(recordInput(manifest, {
    started_at: '2026-08-10T12:00:03.000Z',
  }));
  const reversedResult = verifyDogfoodRunRecordV1(manifest, reversed);
  assert.equal(reversedResult.ok, false);
  assert.match(reversedResult.errors.join('; '), /started_at.*completed_at/u);
});

test('run records recalculate human cost and total cost from the frozen cost policy', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const valid = freezeDogfoodRunRecordV1(recordInput(manifest, {
    human_interventions: 1,
    human_intervention_seconds: 10,
    human_intervention_cost_micro_units: 250,
    total_cost_to_accepted_result_micro_units: 450,
  }));
  const validResult = verifyDogfoodRunRecordV1(manifest, valid);
  assert.equal(validResult.ok, true, validResult.errors.join('; '));

  const tampered = freezeDogfoodRunRecordV1(recordInput(manifest, {
    human_intervention_seconds: 10,
    human_intervention_cost_micro_units: 1,
    total_cost_to_accepted_result_micro_units: 101,
  }));
  const result = verifyDogfoodRunRecordV1(manifest, tampered);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /human_intervention_cost|total_cost_to_accepted_result/u);

  const wrongCurrency = freezeDogfoodRunRecordV1(recordInput(manifest, { currency: 'EUR' }));
  const currencyResult = verifyDogfoodRunRecordV1(manifest, wrongCurrency);
  assert.equal(currencyResult.ok, false);
  assert.match(currencyResult.errors.join('; '), /currency/u);

  const validEvidence = providerCostEvidence(manifest, 'orchestrated', 'run-dogfood-0001');
  const tamperedUsage = { ...validEvidence.usage[0]!, cost_observed: 101 };
  const tamperedEvidence = {
    ...validEvidence,
    usage: [tamperedUsage],
    usage_ledger_hash: hashCanonical([tamperedUsage]),
  };
  const tamperedProviderCost = freezeDogfoodRunRecordV1(recordInput(manifest, {
    provider_cost_evidence: tamperedEvidence,
  }));
  const providerResult = verifyDogfoodRunRecordV1(manifest, tamperedProviderCost);
  assert.equal(providerResult.ok, false);
  assert.match(providerResult.errors.join('; '), /provider observed pricing|reproduced provider cost/u);
});

test('run-set verification requires exactly one valid record per scheduled ordinal and route', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const records = manifest.schedule.map((entry, index) => freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: `run-dogfood-${String(index + 1).padStart(4, '0')}`,
  }, entry.ordinal)));
  const complete = verifyDogfoodRunSetV1(manifest, records);
  assert.equal(complete.ok, true, complete.errors.join('; '));

  const missing = verifyDogfoodRunSetV1(manifest, records.slice(0, -1));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('; '), /exactly|missing/u);

  const duplicate = verifyDogfoodRunSetV1(manifest, [...records.slice(0, -1), records[0]]);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join('; '), /duplicate|missing/u);

  const extra = verifyDogfoodRunSetV1(manifest, [...records, records[0]]);
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join('; '), /exactly|duplicate/u);

  const overlapping = freezeDogfoodRunRecordV1(recordInput(manifest, {
    started_at: timestampAt(1),
    completed_at: timestampAt(3),
    recorded_at: timestampAt(86_403),
  }, 2));
  const serialResult = verifyDogfoodRunSetV1(manifest, [records[0]!, overlapping, ...records.slice(2)]);
  assert.equal(serialResult.ok, false);
  assert.match(serialResult.errors.join('; '), /strict serial/u);
});

test('run-set verification derives the first observable hard stop instead of accepting a forged COMPLETE result', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const records = manifest.schedule.map((entry, index) => freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: `run-derived-${String(index + 1).padStart(4, '0')}`,
    ...(entry.ordinal === 7 ? { cross_run_contamination: true } : {}),
  }, entry.ordinal)));
  const missingStop = verifyDogfoodRunSetV1(manifest, records);
  assert.equal(missingStop.ok, false);
  assert.equal(missingStop.status, 'STOPPED_OPERATIONAL_FAILURE');
  assert.match(missingStop.errors.join('; '), /derived hard stop.*requires.*stop event/u);

  const triggeringRun = records[6]!;
  const stopEvent = freezeDogfoodStopEventV1({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    stop_condition: 'CROSS_RUN_CONTAMINATION',
    last_completed_schedule_ordinal: 7,
    triggering_run_id: triggeringRun.run_id,
    observed_at: timestampAt(21),
    evidence_hashes: [triggeringRun.record_hash, hash('c')],
  });
  const validStoppedPrefix = verifyDogfoodRunSetV1(manifest, records.slice(0, 7), stopEvent);
  assert.equal(validStoppedPrefix.ok, true, validStoppedPrefix.errors.join('; '));

  const earlierUnreconstructable = freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: 'run-derived-unreconstructable',
    evidence_reconstructible: false,
  }, 3));
  const laterContaminated = freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: 'run-derived-contaminated',
    cross_run_contamination: true,
  }, 4));
  const wrongFirstStop = freezeDogfoodStopEventV1({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    stop_condition: 'CROSS_RUN_CONTAMINATION',
    last_completed_schedule_ordinal: 4,
    triggering_run_id: laterContaminated.run_id,
    observed_at: timestampAt(12),
    evidence_hashes: [laterContaminated.record_hash, hash('c')],
  });
  const wrongFirstStopResult = verifyDogfoodRunSetV1(manifest, [records[0]!, records[1]!, earlierUnreconstructable, laterContaminated], wrongFirstStop);
  assert.equal(wrongFirstStopResult.ok, false);
  assert.match(wrongFirstStopResult.errors.join('; '), /first observable derived hard-stop|first observable derived hard-stop condition/u);
});

test('provider usage evidence is bound to the frozen topology, required roles and run events', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const record = freezeDogfoodRunRecordV1(recordInput(manifest));

  const changedRegistry = record.provider_cost_evidence.binding_registry.map(binding => binding.binding_ref === 'binding-orchestrated'
    ? { ...binding, profile_hash: hash('9') }
    : binding);
  const changedRegistryEvidence = {
    ...record.provider_cost_evidence,
    binding_registry: changedRegistry,
    binding_registry_hash: hashCanonical([...changedRegistry].sort((left, right) => left.binding_ref.localeCompare(right.binding_ref))),
  };
  const changedRegistryRecord = freezeDogfoodRunRecordV1(recordInput(manifest, { provider_cost_evidence: changedRegistryEvidence }));
  const changedRegistryResult = verifyDogfoodRunRecordV1(manifest, changedRegistryRecord);
  assert.equal(changedRegistryResult.ok, false);
  assert.match(changedRegistryResult.errors.join('; '), /frozen provider usage topology/u);

  const executorUsage = record.provider_cost_evidence.usage[0]!;
  const executorEvent = record.provider_cost_evidence.usage_event_bindings[0]!;
  const missingReviewerEvidence = {
    ...record.provider_cost_evidence,
    usage: [executorUsage],
    usage_event_bindings: [executorEvent],
    usage_ledger_hash: hashCanonical({ usage: [executorUsage], usage_event_bindings: [executorEvent] }),
  };
  const missingReviewerRecord = freezeDogfoodRunRecordV1(recordInput(manifest, {
    provider_cost_evidence: missingReviewerEvidence,
    observed_cost_micro_units: 100,
    total_cost_to_accepted_result_micro_units: 100,
  }));
  const missingReviewerResult = verifyDogfoodRunRecordV1(manifest, missingReviewerRecord);
  assert.equal(missingReviewerResult.ok, false);
  assert.match(missingReviewerResult.errors.join('; '), /missing required role: reviewer/u);

  const wrongRunEventBindings = record.provider_cost_evidence.usage_event_bindings.map((eventRef, index) => index === 0
    ? { ...eventRef, run_id: 'another-run' }
    : eventRef);
  const wrongRunEvidence = {
    ...record.provider_cost_evidence,
    usage_event_bindings: wrongRunEventBindings,
    usage_ledger_hash: hashCanonical({
      usage: [...record.provider_cost_evidence.usage].sort((left, right) => left.usage_id.localeCompare(right.usage_id)),
      usage_event_bindings: [...wrongRunEventBindings].sort((left, right) => left.usage_id.localeCompare(right.usage_id)),
    }),
  };
  const wrongRunRecord = freezeDogfoodRunRecordV1(recordInput(manifest, { provider_cost_evidence: wrongRunEvidence }));
  const wrongRunResult = verifyDogfoodRunRecordV1(manifest, wrongRunRecord);
  assert.equal(wrongRunResult.ok, false);
  assert.match(wrongRunResult.errors.join('; '), /different run/u);

  assert.throws(() => freezeDogfoodRunRecordV1(recordInput(manifest, {
    provider_cost_evidence: {
      ...record.provider_cost_evidence,
      usage: [],
      usage_event_bindings: [],
      usage_ledger_hash: hashCanonical({ usage: [], usage_event_bindings: [] }),
    },
    observed_cost_micro_units: 0,
    total_cost_to_accepted_result_micro_units: 0,
  })), /too_small/u);
});

test('run-set verification distinguishes a complete experiment from an operationally stopped prefix', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const records = manifest.schedule.slice(0, 3).map((entry, index) => freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: `run-stop-${String(index + 1).padStart(4, '0')}`,
  }, entry.ordinal)));
  const stopEvent = freezeDogfoodStopEventV1({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    stop_condition: 'AUTHORITY_ESCAPE',
    last_completed_schedule_ordinal: 3,
    triggering_run_id: records[2]!.run_id,
    observed_at: timestampAt(9),
    evidence_hashes: [records[2]!.record_hash, hash('c')],
  });
  assert.equal(verifyDogfoodStopEventV1(manifest, stopEvent, records[2]).ok, true);
  const stopped = verifyDogfoodRunSetV1(manifest, records, stopEvent);
  assert.equal(stopped.ok, true, stopped.errors.join('; '));
  assert.equal(stopped.status, 'STOPPED_OPERATIONAL_FAILURE');
  assert.equal(verifyDogfoodRunSetV1(manifest, records).ok, false);
  const afterStop = verifyDogfoodRunSetV1(manifest, [...records, freezeDogfoodRunRecordV1(recordInput(manifest, { run_id: 'run-after-stop' }, 4))], stopEvent);
  assert.equal(afterStop.ok, false);
  assert.match(afterStop.errors.join('; '), /after.*stop|exactly/u);
});

test('stop events require causal evidence for derived conditions and support system stops before the first run', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const records = manifest.schedule.slice(0, 3).map((entry, index) => freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: `run-causal-${String(index + 1).padStart(4, '0')}`,
  }, entry.ordinal)));
  const derivedStop = (stop_condition: DogfoodStopEventInputV1['stop_condition'], triggeringRun = records[2]!) => freezeDogfoodStopEventV1({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    stop_condition,
    last_completed_schedule_ordinal: 3,
    triggering_run_id: triggeringRun.run_id,
    observed_at: timestampAt(9),
    evidence_hashes: [triggeringRun.record_hash, hash('c')],
  });

  const critical = verifyDogfoodRunSetV1(manifest, records, derivedStop('CRITICAL_FALSE_ACCEPTANCE'));
  assert.equal(critical.ok, false);
  assert.match(critical.errors.join('; '), /false_acceptance|critical post-acceptance/u);

  const contaminated = verifyDogfoodRunSetV1(manifest, records, derivedStop('CROSS_RUN_CONTAMINATION'));
  assert.equal(contaminated.ok, false);
  assert.match(contaminated.errors.join('; '), /cross_run_contamination/u);

  const unreconstructable = verifyDogfoodRunSetV1(manifest, records, derivedStop('UNRECONSTRUCTABLE_EVIDENCE'));
  assert.equal(unreconstructable.ok, false);
  assert.match(unreconstructable.errors.join('; '), /evidence_reconstructible/u);

  const criticalRun = freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: 'run-causal-critical',
    first_pass_accepted: false,
    attempts: 2,
    repairs: 1,
    false_acceptance: true,
    post_acceptance_defects: [{ defect_hash: hash('d'), severity: 'critical' }],
  }, 3));
  const validCritical = verifyDogfoodRunSetV1(manifest, [records[0]!, records[1]!, criticalRun], derivedStop('CRITICAL_FALSE_ACCEPTANCE', criticalRun));
  assert.equal(validCritical.ok, true, validCritical.errors.join('; '));

  const systemStop = freezeDogfoodStopEventV1({
    experiment_id: manifest.experiment_id,
    manifest_hash: manifest.manifest_hash,
    stop_condition: 'DURABLE_STATE_INCONSISTENCY',
    last_completed_schedule_ordinal: 0,
    triggering_run_id: null,
    observed_at: timestampAt(0),
    evidence_hashes: [hash('e')],
  });
  assert.equal(verifyDogfoodStopEventV1(manifest, systemStop).ok, true);
  const stoppedBeforeFirstRun = verifyDogfoodRunSetV1(manifest, [], systemStop);
  assert.equal(stoppedBeforeFirstRun.ok, true, stoppedBeforeFirstRun.errors.join('; '));
  assert.equal(stoppedBeforeFirstRun.status, 'STOPPED_OPERATIONAL_FAILURE');
});

test('run records reject contradictory acceptance and defect semantics', () => {
  const manifest = freezeDogfoodManifestV1(input());
  const rejectedAccepted = freezeDogfoodRunRecordV1(recordInput(manifest, { outcome: 'REJECTED', final_accepted: true }));
  const rejectedAcceptedResult = verifyDogfoodRunRecordV1(manifest, rejectedAccepted);
  assert.equal(rejectedAcceptedResult.ok, false);
  assert.match(rejectedAcceptedResult.errors.join('; '), /outcome ACCEPTED/u);

  const falseWithoutAcceptance = freezeDogfoodRunRecordV1(recordInput(manifest, { final_accepted: false, outcome: 'REJECTED', false_acceptance: true }));
  const falseWithoutAcceptanceResult = verifyDogfoodRunRecordV1(manifest, falseWithoutAcceptance);
  assert.equal(falseWithoutAcceptanceResult.ok, false);
  assert.match(falseWithoutAcceptanceResult.errors.join('; '), /false_acceptance requires/u);

  const criticalDefect = freezeDogfoodRunRecordV1(recordInput(manifest, {
    post_acceptance_defects: [{ defect_hash: hash('d'), severity: 'critical' }],
  }));
  const criticalDefectResult = verifyDogfoodRunRecordV1(manifest, criticalDefect);
  assert.equal(criticalDefectResult.ok, false);
  assert.match(criticalDefectResult.errors.join('; '), /critical false acceptance/u);

  const forgedFirstPass = freezeDogfoodRunRecordV1(recordInput(manifest, {
    first_pass_accepted: true,
    attempts: 3,
    repairs: 1,
    escalations: 1,
  }));
  const forgedFirstPassResult = verifyDogfoodRunRecordV1(manifest, forgedFirstPass);
  assert.equal(forgedFirstPassResult.ok, false);
  assert.match(forgedFirstPassResult.errors.join('; '), /first_pass_accepted/u);

  const uncountedHumanTime = freezeDogfoodRunRecordV1(recordInput(manifest, {
    human_interventions: 0,
    human_intervention_seconds: 1,
    human_intervention_cost_micro_units: 25,
    total_cost_to_accepted_result_micro_units: 125,
  }));
  const uncountedHumanTimeResult = verifyDogfoodRunRecordV1(manifest, uncountedHumanTime);
  assert.equal(uncountedHumanTimeResult.ok, false);
  assert.match(uncountedHumanTimeResult.errors.join('; '), /human intervention time/u);

  const recoveredAfterReview = freezeDogfoodRunRecordV1(recordInput(manifest, {
    run_id: 'run-review-recovered',
    first_pass_accepted: false,
    reviewer_rejected: true,
    attempts: 2,
    repairs: 1,
  }));
  const recoveredAfterReviewResult = verifyDogfoodRunRecordV1(manifest, recoveredAfterReview);
  assert.equal(recoveredAfterReviewResult.ok, true, recoveredAfterReviewResult.errors.join('; '));

  const acceptedWithoutRecovery = freezeDogfoodRunRecordV1(recordInput(manifest, {
    reviewer_rejected: true,
  }));
  const acceptedWithoutRecoveryResult = verifyDogfoodRunRecordV1(manifest, acceptedWithoutRecovery);
  assert.equal(acceptedWithoutRecoveryResult.ok, false);
  assert.match(acceptedWithoutRecoveryResult.errors.join('; '), /reviewer rejection/u);
});

test('analysis policy is a canonical artifact bound into the manifest identity', async () => {
  const policy = JSON.parse(await readFile(new URL('../contracts/dogfood-analysis-policy-v1.json', import.meta.url), 'utf8')) as object;
  const policyHash = hashCanonical(policy);
  const manifest = freezeDogfoodManifestV1(input({ analysis_policy_hash: policyHash }));
  assert.equal(verifyDogfoodManifestV1(manifest).ok, true);
  assert.equal(manifest.analysis_policy_hash, policyHash);
  assert.notEqual(hashCanonical({ ...policy, policy_version: 2 }), policyHash);
});

test('dogfood schemas compile independently and reject provider/model fields', async () => {
  const manifestSchema = JSON.parse(await readFile(new URL('../contracts/dogfood-manifest-v1.schema.json', import.meta.url), 'utf8')) as object;
  const recordSchema = JSON.parse(await readFile(new URL('../contracts/dogfood-run-record-v1.schema.json', import.meta.url), 'utf8')) as object;
  const stopSchema = JSON.parse(await readFile(new URL('../contracts/dogfood-stop-event-v1.schema.json', import.meta.url), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateManifest = ajv.compile(manifestSchema);
  const validateRecord = ajv.compile(recordSchema);
  const validateStop = ajv.compile(stopSchema);
  const manifest = freezeDogfoodManifestV1(input());
  const record = freezeDogfoodRunRecordV1(recordInput(manifest));
  const stop = freezeDogfoodStopEventV1({ experiment_id: manifest.experiment_id, manifest_hash: manifest.manifest_hash, stop_condition: 'AUTHORITY_ESCAPE', last_completed_schedule_ordinal: 1, triggering_run_id: record.run_id, observed_at: timestampAt(3), evidence_hashes: [record.record_hash, hash('e')] });
  const systemStop = freezeDogfoodStopEventV1({ experiment_id: manifest.experiment_id, manifest_hash: manifest.manifest_hash, stop_condition: 'DURABLE_STATE_INCONSISTENCY', last_completed_schedule_ordinal: 0, triggering_run_id: null, observed_at: timestampAt(0), evidence_hashes: [hash('e')] });
  assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
  assert.equal(validateRecord(record), true, JSON.stringify(validateRecord.errors));
  assert.equal(validateStop(stop), true, JSON.stringify(validateStop.errors));
  assert.equal(validateStop(systemStop), true, JSON.stringify(validateStop.errors));
  assert.equal(validateStop({ ...systemStop, triggering_run_id: record.run_id }), false);
  assert.equal(validateStop({ ...systemStop, stop_condition: 'CRITICAL_FALSE_ACCEPTANCE' }), false);
  const invalidUsageRecord = {
    ...record,
    provider_cost_evidence: {
      ...record.provider_cost_evidence,
      usage: [{ ...record.provider_cost_evidence.usage[0]!, attempt_id: null, review_id: null, orchestrator_operation_id: null }],
    },
  };
  assert.equal(validateRecord(invalidUsageRecord), false);
  assert.equal(validateManifest({ ...manifest, model: 'must-not-be-in-the-manifest' }), false);
  assert.equal(validateManifest({ ...manifest, baseline: { ...manifest.baseline, worker_capability_hash: hash('0') } }), false);
});
