import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalize, hashCanonical } from '../src/pilot/canonical-json.js';
import {
  aggregateUsage,
  priceUsage,
  type BindingRegistryV3,
  type PricingSnapshotV3,
  type UsageRecordedV3,
} from '../src/pilot/usage-cost.js';

const hash = (character: string) => character.repeat(64);

function snapshot(
  overrides: Partial<Omit<PricingSnapshotV3, 'tariffs'>> & { tariffs?: PricingSnapshotV3['tariffs'] } = {},
): PricingSnapshotV3 {
  const draft: PricingSnapshotV3 = {
    pricing_snapshot_id: 'pricing-v1', pricing_snapshot_hash: hash('0'), currency: 'EUR', unit_scale: 1_000_000,
    effective_at: '2026-08-08T12:00:00.000Z',
    tariffs: [{
      binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
      output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: 5,
      reasoning_token_micro_units_per_token: 7, authoritative_charge_supported: true,
    }],
    ...overrides,
  };
  const { pricing_snapshot_hash: _selfHash, ...content } = draft;
  return { ...draft, pricing_snapshot_hash: hashCanonical(content) };
}

function usage(overrides: Partial<UsageRecordedV3> = {}): UsageRecordedV3 {
  return {
    usage_id: 'usage-1', attempt_number: 1, role: 'executor', binding_ref: 'binding-strong-v1',
    provider_usage_id: null, input_tokens_observed: null, output_tokens_observed: null,
    cached_input_tokens_observed: null, reasoning_tokens_observed: null,
    input_tokens_estimated: null, output_tokens_estimated: null, cached_input_tokens_estimated: null,
    reasoning_tokens_estimated: null, token_estimator_id: null, token_estimator_version: null,
    pricing_snapshot_id: 'pricing-v1', cost_observed: null, cost_estimated: null, currency: 'EUR',
    cost_provenance: 'TARIFF_REPRODUCED', attempt_id: 'attempt-1', review_id: null,
    orchestrator_operation_id: null, ...overrides,
  };
}

const registry: BindingRegistryV3 = [
  { binding_ref: 'binding-cheap-v1', capability_class: 'cheap', profile_hash: hash('c') },
  { binding_ref: 'binding-strong-v1', capability_class: 'strong', profile_hash: hash('d') },
];

test('priceUsage calculates all four observed dimensions in exact integer micro-units', () => {
  const result = priceUsage(usage({
    input_tokens_observed: 11, output_tokens_observed: 13,
    cached_input_tokens_observed: 17, reasoning_tokens_observed: 19,
  }), snapshot());

  assert.equal(result.cost_observed, 279);
  assert.equal(result.observed_pricing_complete, true);
  assert.equal(result.observed_cost_provenance, 'TARIFF_REPRODUCED');
  assert.deepEqual(result.pricing_errors, []);
});

test('observed zero is authoritative, null is unavailable, and null tariff rates are not required', () => {
  const zero = priceUsage(usage({
    input_tokens_observed: 0, output_tokens_observed: 0,
    cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  }), snapshot());
  const unavailable = priceUsage(usage({
    input_tokens_observed: 0, output_tokens_observed: null,
    cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  }), snapshot());
  const optionalSnapshot = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
    output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] });
  const optional = priceUsage(usage({ input_tokens_observed: 4, output_tokens_observed: 5 }), optionalSnapshot);

  assert.equal(zero.cost_observed, 0);
  assert.equal(zero.observed_pricing_complete, true);
  assert.equal(unavailable.cost_observed, null);
  assert.equal(unavailable.pricing_errors.includes('OBSERVED_DIMENSION_MISSING:output'), true);
  assert.equal(optional.cost_observed, 23);
  assert.equal(optional.observed_pricing_complete, true);
});

test('unsafe integers and micro-unit overflow are rejected instead of rounded', () => {
  assert.throws(() => priceUsage(usage({
    input_tokens_observed: Number.MAX_SAFE_INTEGER, output_tokens_observed: 0,
    cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  }), snapshot()), error => error instanceof RangeError && error.message.includes('SAFE_INTEGER_OVERFLOW'));
  assert.throws(() => priceUsage(usage({
    input_tokens_observed: Number.MAX_SAFE_INTEGER + 1, output_tokens_observed: 0,
    cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  }), snapshot()), error => error instanceof RangeError && error.message.includes('UNSAFE_INTEGER'));
});

test('snapshot ID, currency, tariff binding, and immutable content mismatches fail closed', () => {
  const frozen = snapshot();
  const contentMismatch = { ...frozen, effective_at: '2026-08-09T12:00:00.000Z' };
  const cases: Array<[UsageRecordedV3, PricingSnapshotV3, string]> = [
    [usage({ pricing_snapshot_id: 'pricing-other' }), frozen, 'PRICING_SNAPSHOT_ID_MISMATCH'],
    [usage({ currency: 'USD' }), frozen, 'PRICING_CURRENCY_MISMATCH'],
    [usage({ binding_ref: 'binding-unknown' }), frozen, 'PRICING_TARIFF_NOT_FOUND'],
    [usage(), contentMismatch, 'PRICING_SNAPSHOT_HASH_MISMATCH'],
  ];
  for (const [event, pricing, reason] of cases) {
    const result = priceUsage(event, pricing);
    assert.equal(result.cost_observed, null, reason);
    assert.equal(result.cost_estimated, null, reason);
    assert.equal(result.pricing_errors.includes(reason), true, `${reason}: ${result.pricing_errors.join(', ')}`);
  }
});

test('authoritative billing requires provider ID, currency, amount, provenance, and tariff permission', () => {
  const allowed = priceUsage(usage({
    provider_usage_id: 'provider-usage-1', cost_observed: 701, cost_provenance: 'AUTHORITATIVE_BILL',
  }), snapshot());
  assert.equal(allowed.cost_observed, 701);
  assert.equal(allowed.observed_cost_provenance, 'AUTHORITATIVE_BILL');

  const missingEvidence: Array<[string, UsageRecordedV3, string]> = [
    ['provider ID', usage({ cost_observed: 701, cost_provenance: 'AUTHORITATIVE_BILL' }), 'AUTHORITATIVE_PROVIDER_USAGE_ID_MISSING'],
    ['amount', usage({ provider_usage_id: 'provider-usage-1', cost_provenance: 'AUTHORITATIVE_BILL' }), 'AUTHORITATIVE_AMOUNT_MISSING'],
    ['currency', { ...usage({ provider_usage_id: 'provider-usage-1', cost_observed: 701, cost_provenance: 'AUTHORITATIVE_BILL' }), currency: null } as unknown as UsageRecordedV3, 'PRICING_CURRENCY_MISMATCH'],
    ['provenance', { ...usage({ provider_usage_id: 'provider-usage-1', cost_observed: 701 }), cost_provenance: null } as unknown as UsageRecordedV3, 'AUTHORITATIVE_PROVENANCE_MISSING'],
  ];
  for (const [name, event, reason] of missingEvidence) {
    const result = priceUsage(event, snapshot());
    assert.equal(result.cost_observed, null, name);
    assert.equal(result.pricing_errors.includes(reason), true, `${name}: ${result.pricing_errors.join(', ')}`);
  }

  const deniedSnapshot = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
    output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] });
  const deniedAndMatching = priceUsage(usage({
    provider_usage_id: 'provider-usage-1', cost_observed: 23, cost_provenance: 'AUTHORITATIVE_BILL',
    input_tokens_observed: 4, output_tokens_observed: 5,
  }), deniedSnapshot);
  const deniedAndMismatched = priceUsage(usage({
    provider_usage_id: 'provider-usage-1', cost_observed: 999, cost_provenance: 'AUTHORITATIVE_BILL',
    input_tokens_observed: 4, output_tokens_observed: 5,
  }), deniedSnapshot);
  const deniedAndIncomplete = priceUsage(usage({
    provider_usage_id: 'provider-usage-1', cost_observed: 999, cost_provenance: 'AUTHORITATIVE_BILL',
  }), deniedSnapshot);

  assert.equal(deniedAndMatching.cost_observed, 23);
  assert.equal(deniedAndMatching.observed_cost_provenance, 'TARIFF_REPRODUCED');
  assert.equal(deniedAndMatching.pricing_errors.includes('AUTHORITATIVE_CHARGE_NOT_SUPPORTED'), true);
  assert.equal(deniedAndMismatched.cost_observed, null);
  assert.equal(deniedAndMismatched.observed_cost_provenance, null);
  assert.equal(deniedAndMismatched.cost_provenance, 'AUTHORITATIVE_BILL');
  assert.equal(deniedAndMismatched.pricing_errors.includes('AUTHORITATIVE_REPRODUCED_COST_MISMATCH'), true);
  assert.equal(deniedAndIncomplete.cost_observed, null);
});

test('dimensional fallback rejects a recorded observed amount mismatch even when provenance is missing', () => {
  const malformed = {
    ...usage({
      cost_observed: 999,
      input_tokens_observed: 4,
      output_tokens_observed: 5,
    }),
    cost_provenance: null,
  } as unknown as UsageRecordedV3;

  const result = priceUsage(malformed, snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
    output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] }));

  assert.equal(result.cost_observed, null);
  assert.equal(result.observed_pricing_complete, false);
  assert.equal(result.observed_cost_provenance, null);
  assert.equal(result.cost_provenance, null);
  assert.equal(result.pricing_errors.includes('AUTHORITATIVE_PROVENANCE_MISSING'), true);
  assert.equal(result.pricing_errors.includes('RECORDED_OBSERVED_COST_MISMATCH'), true);
});

test('estimated pricing uses only named estimated dimensions without cross-filling observed values', () => {
  const estimatedOnly = priceUsage(usage({
    input_tokens_estimated: 11, output_tokens_estimated: 13,
    cached_input_tokens_estimated: 17, reasoning_tokens_estimated: 19,
    token_estimator_id: 'estimator-v1', token_estimator_version: '1.0.0',
  }), snapshot());
  const observedOnly = priceUsage(usage({
    input_tokens_observed: 11, output_tokens_observed: 13,
    cached_input_tokens_observed: 17, reasoning_tokens_observed: 19,
  }), snapshot());
  const missingEstimatedOutput = priceUsage(usage({
    input_tokens_observed: 11, output_tokens_observed: 13,
    cached_input_tokens_observed: 17, reasoning_tokens_observed: 19,
    input_tokens_estimated: 11, output_tokens_estimated: null,
    cached_input_tokens_estimated: 17, reasoning_tokens_estimated: 19,
    token_estimator_id: 'estimator-v1', token_estimator_version: '1.0.0',
  }), snapshot());

  assert.equal(estimatedOnly.cost_observed, null);
  assert.equal(estimatedOnly.cost_estimated, 279);
  assert.equal(estimatedOnly.estimated_cost_provenance, 'ESTIMATED_TARIFF');
  assert.equal(observedOnly.cost_observed, 279);
  assert.equal(observedOnly.cost_estimated, null);
  assert.equal(missingEstimatedOutput.cost_observed, 279);
  assert.equal(missingEstimatedOutput.cost_estimated, null);
  assert.equal(missingEstimatedOutput.pricing_errors.includes('ESTIMATED_DIMENSION_MISSING:output'), true);
});

test('estimated pricing requires estimator ID and version independently and rejects a recorded mismatch', () => {
  const estimated = {
    input_tokens_estimated: 1, output_tokens_estimated: 1,
    cached_input_tokens_estimated: 1, reasoning_tokens_estimated: 1,
  } as const;
  const missingId = priceUsage(usage({
    ...estimated, token_estimator_id: null, token_estimator_version: '1.0.0',
  }), snapshot());
  const missingVersion = priceUsage(usage({
    ...estimated, token_estimator_id: 'estimator-v1', token_estimator_version: null,
  }), snapshot());
  const mismatched = priceUsage(usage({
    ...estimated, token_estimator_id: 'estimator-v1', token_estimator_version: '1.0.0',
    cost_estimated: 999, cost_provenance: 'ESTIMATED_TARIFF',
  }), snapshot());

  for (const result of [missingId, missingVersion]) {
    assert.equal(result.cost_estimated, null);
    assert.equal(result.pricing_errors.includes('ESTIMATOR_IDENTITY_MISSING'), true);
  }
  assert.equal(mismatched.cost_estimated, null);
  assert.equal(mismatched.pricing_errors.includes('RECORDED_ESTIMATED_COST_MISMATCH'), true);
});

test('duplicate tariffs and registries fail closed instead of selecting an arbitrary binding', () => {
  const tariff = snapshot().tariffs[0];
  const duplicateTariffSnapshot = snapshot({ tariffs: [tariff, { ...tariff }] });
  const tariffResult = priceUsage(usage({ input_tokens_observed: 1, output_tokens_observed: 1 }), duplicateTariffSnapshot);
  assert.equal(tariffResult.cost_observed, null);
  assert.equal(tariffResult.pricing_errors.includes('PRICING_TARIFF_BINDING_DUPLICATE:binding-strong-v1'), true);

  assert.throws(
    () => aggregateUsage([], [...registry, { ...registry[0] }], snapshot()),
    error => error instanceof Error && error.message.includes('DUPLICATE_BINDING_REF:binding-cheap-v1'),
  );
});

test('unsafe snapshot unit scale and tariff rates are rejected before arithmetic', () => {
  assert.throws(
    () => priceUsage(usage(), snapshot({ unit_scale: Number.MAX_SAFE_INTEGER + 1 })),
    error => error instanceof RangeError && error.message.includes('UNSAFE_INTEGER:pricing_snapshot.unit_scale'),
  );
  assert.throws(
    () => priceUsage(usage(), snapshot({ tariffs: [{
      ...snapshot().tariffs[0], input_token_micro_units_per_token: Number.MAX_SAFE_INTEGER + 1,
    }] })),
    error => error instanceof RangeError && error.message.includes('UNSAFE_INTEGER:tariff.binding-strong-v1.input'),
  );
});

test('aggregateUsage reprices unique records, counts identical replay once, and rejects conflicting reuse', () => {
  const pricing = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
    output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] });
  const once = usage({
    usage_id: 'usage-replay', input_tokens_observed: 2, output_tokens_observed: 3,
    cost_observed: 999,
  });
  const aggregate = aggregateUsage([once, { ...once }], registry, pricing);

  assert.equal(aggregate.operations, 1);
  assert.equal(aggregate.duplicate_replays, 1);
  assert.deepEqual(aggregate.usage_ids, ['usage-replay']);
  assert.equal(aggregate.cost_observed.value, null);
  assert.equal(aggregate.priced_usage[0].pricing_errors.includes('RECORDED_OBSERVED_COST_MISMATCH'), true);
  assert.throws(() => aggregateUsage([once, { ...once, cost_observed: 11 }], registry, pricing),
    error => error instanceof Error && error.message.includes('CONFLICTING_USAGE_ID:usage-replay'));
});

test('aggregateUsage splits strong dimensions and observed/estimated economic completeness independently', () => {
  const pricing = snapshot({ tariffs: [
    { binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2, output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
    { binding_ref: 'binding-cheap-v1', input_token_micro_units_per_token: 2, output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
  ] });
  const events = [
    usage({ usage_id: 'strong-a', input_tokens_observed: 10, output_tokens_observed: 20, cached_input_tokens_observed: 0, reasoning_tokens_observed: null, input_tokens_estimated: 11, output_tokens_estimated: 21, cached_input_tokens_estimated: 1, reasoning_tokens_estimated: 2, token_estimator_id: 'estimator-v1', token_estimator_version: '1.0.0' }),
    usage({ usage_id: 'strong-b', input_tokens_observed: 5, output_tokens_observed: null, cached_input_tokens_observed: 3, reasoning_tokens_observed: 4 }),
    usage({ usage_id: 'cheap-a', binding_ref: 'binding-cheap-v1', input_tokens_observed: 1, output_tokens_observed: 1, cached_input_tokens_observed: 1000, reasoning_tokens_observed: 1000, input_tokens_estimated: 1, output_tokens_estimated: 1, cached_input_tokens_estimated: 1000, reasoning_tokens_estimated: 1000, token_estimator_id: 'estimator-v1', token_estimator_version: '1.0.0' }),
    usage({ usage_id: 'unknown-a', binding_ref: 'binding-unknown', input_tokens_observed: 500, output_tokens_observed: 500, cached_input_tokens_observed: 500, reasoning_tokens_observed: 500 }),
  ];
  const aggregate = aggregateUsage(events, registry, pricing);

  assert.deepEqual(aggregate.cost_observed, { value: null, complete: 2, total: 4, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.cost_estimated, { value: null, complete: 2, total: 4, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.strong_tokens_observed.input, { value: 15, complete: 2, total: 2, completeness_ratio: 1 });
  assert.deepEqual(aggregate.strong_tokens_observed.output, { value: null, complete: 1, total: 2, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.strong_tokens_observed.cached_input, { value: 3, complete: 2, total: 2, completeness_ratio: 1 });
  assert.deepEqual(aggregate.strong_tokens_observed.reasoning, { value: null, complete: 1, total: 2, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.strong_tokens_observed.total, { value: null, complete: 0, total: 2, completeness_ratio: 0 });
  assert.deepEqual(aggregate.strong_tokens_estimated.input, { value: null, complete: 1, total: 2, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.strong_tokens_estimated.total, { value: null, complete: 1, total: 2, completeness_ratio: 0.5 });
  assert.deepEqual(aggregate.unknown_binding_usage_ids, ['unknown-a']);
  assert.equal(aggregate.incomplete_usage.some(item => item.usage_id === 'strong-b' && item.reason_codes.includes('COST_OBSERVED_INCOMPLETE')), true);
  assert.equal(aggregate.incomplete_usage.some(item => item.usage_id === 'unknown-a' && item.reason_codes.includes('UNKNOWN_BINDING')), true);
});

test('aggregateUsage is byte-stable across reordering and never mutates input arrays or nested outputs', () => {
  const pricing = snapshot({ tariffs: [
    { binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2, output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
    { binding_ref: 'binding-cheap-v1', input_token_micro_units_per_token: 2, output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null, reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false },
  ] });
  const left = usage({ usage_id: 'usage-b', binding_ref: 'binding-cheap-v1', input_tokens_observed: 1, output_tokens_observed: 2 });
  const right = usage({ usage_id: 'usage-a', input_tokens_observed: 2, output_tokens_observed: 1 });
  const events = [left, right] as const;
  const eventsBefore = canonicalize(events);
  const registryBefore = canonicalize(registry);
  const snapshotBefore = canonicalize(pricing);

  const forward = aggregateUsage(events, registry, pricing);
  const reverse = aggregateUsage([right, left], registry, pricing);

  assert.equal(canonicalize(forward), canonicalize(reverse));
  assert.equal(canonicalize(events), eventsBefore);
  assert.equal(canonicalize(registry), registryBefore);
  assert.equal(canonicalize(pricing), snapshotBefore);
  assert.notEqual(forward.priced_usage, events);
  assert.notEqual(forward.strong_tokens_observed, forward.strong_tokens_estimated);
  assert.notEqual(forward.strong_tokens_observed.input, forward.strong_tokens_observed.output);
});

test('priceUsage and aggregateUsage deeply freeze every returned object and nested collection without freezing inputs', () => {
  const pricing = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 2,
    output_token_micro_units_per_token: 3, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] });
  const raw = usage({ input_tokens_observed: 1, output_tokens_observed: null });
  const events = [raw];
  const priced = priceUsage(raw, pricing);
  const aggregate = aggregateUsage(events, registry, pricing);

  assert.equal(Object.isFrozen(priced), true);
  assert.equal(Object.isFrozen(priced.pricing_errors), true);
  assert.equal(Object.isFrozen(aggregate), true);
  assert.equal(Object.isFrozen(aggregate.usage_ids), true);
  assert.equal(Object.isFrozen(aggregate.priced_usage), true);
  assert.equal(Object.isFrozen(aggregate.priced_usage[0]), true);
  assert.equal(Object.isFrozen(aggregate.incomplete_usage), true);
  assert.equal(Object.isFrozen(aggregate.incomplete_usage[0]), true);
  assert.equal(Object.isFrozen(aggregate.incomplete_usage[0].reason_codes), true);
  assert.equal(Object.isFrozen(aggregate.cost_observed), true);
  assert.equal(Object.isFrozen(aggregate.strong_tokens_observed), true);
  assert.equal(Object.isFrozen(aggregate.strong_tokens_observed.input), true);
  assert.throws(() => { priced.cost_observed = 9; }, TypeError);
  assert.throws(() => { (priced.pricing_errors as string[]).push('MUTATED'); }, TypeError);
  assert.throws(() => { (aggregate.usage_ids as string[]).push('mutated'); }, TypeError);
  assert.throws(() => { (aggregate.incomplete_usage[0].reason_codes as string[]).push('MUTATED'); }, TypeError);
  assert.throws(() => { aggregate.cost_observed.value = 9; }, TypeError);
  assert.throws(() => { aggregate.strong_tokens_observed.input.value = 9; }, TypeError);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(events), false);
  assert.equal(Object.isFrozen(registry), false);
  assert.equal(Object.isFrozen(pricing), false);
});

test('aggregateUsage orders punctuation and case by deterministic code units', () => {
  const identifiers = ['aa', 'a_', 'aA', 'a:', 'a.', 'a-'];
  const aggregate = aggregateUsage(identifiers.map(usage_id => usage({ usage_id })), registry, snapshot());
  assert.deepEqual(aggregate.usage_ids, ['a-', 'a.', 'a:', 'aA', 'a_', 'aa']);
});

test('aggregateUsage rejects monetary and strong-token sums beyond safe integer range', () => {
  const pricing = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 0,
    output_token_micro_units_per_token: 0, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: true,
  }] });
  const first = usage({ usage_id: 'usage-a', provider_usage_id: 'provider-a', cost_observed: Number.MAX_SAFE_INTEGER, cost_provenance: 'AUTHORITATIVE_BILL', input_tokens_observed: Number.MAX_SAFE_INTEGER, output_tokens_observed: 0, cached_input_tokens_observed: 0, reasoning_tokens_observed: 0 });
  const second = usage({ usage_id: 'usage-b', provider_usage_id: 'provider-b', cost_observed: 1, cost_provenance: 'AUTHORITATIVE_BILL', input_tokens_observed: 1, output_tokens_observed: 0, cached_input_tokens_observed: 0, reasoning_tokens_observed: 0 });

  assert.throws(() => aggregateUsage([first, second], registry, pricing),
    error => error instanceof RangeError && error.message.includes('SAFE_INTEGER_OVERFLOW'));
});

test('aggregateUsage rejects an isolated strong-token overflow when monetary sums remain safe', () => {
  const pricing = snapshot({ tariffs: [{
    binding_ref: 'binding-strong-v1', input_token_micro_units_per_token: 0,
    output_token_micro_units_per_token: 0, cached_input_token_micro_units_per_token: null,
    reasoning_token_micro_units_per_token: null, authoritative_charge_supported: false,
  }] });
  const first = usage({
    usage_id: 'usage-a', input_tokens_observed: Number.MAX_SAFE_INTEGER,
    output_tokens_observed: 0, cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  });
  const second = usage({
    usage_id: 'usage-b', input_tokens_observed: 1,
    output_tokens_observed: 0, cached_input_tokens_observed: 0, reasoning_tokens_observed: 0,
  });

  assert.throws(
    () => aggregateUsage([first, second], registry, pricing),
    error => error instanceof RangeError && error.message.includes('SAFE_INTEGER_OVERFLOW:strong_tokens_observed.input'),
  );
});
