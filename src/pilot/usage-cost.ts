import { canonicalize, hashCanonical } from './canonical-json.js';
import type { PilotEventV3, PilotManifestV3 } from './contracts.js';

export type UsageRecordedV3 = Extract<PilotEventV3, { event_type: 'USAGE_RECORDED' }>['payload'];
export type PricingSnapshotV3 = PilotManifestV3['pricing_snapshot'];
export type BindingRegistryV3 = readonly PilotManifestV3['binding_registry'][number][];

export interface PricedUsageV3 extends Omit<UsageRecordedV3, 'cost_observed' | 'cost_estimated'> {
  cost_observed: number | null;
  cost_estimated: number | null;
  pricing_snapshot_hash: string;
  observed_pricing_complete: boolean;
  estimated_pricing_complete: boolean;
  observed_cost_provenance: 'TARIFF_REPRODUCED' | 'AUTHORITATIVE_BILL' | null;
  estimated_cost_provenance: 'ESTIMATED_TARIFF' | null;
  pricing_errors: readonly string[];
}

export interface AggregateMeasureV3 {
  value: number | null;
  complete: number;
  total: number;
  completeness_ratio: number;
}

export interface StrongTokenAggregateV3 {
  input: AggregateMeasureV3;
  output: AggregateMeasureV3;
  cached_input: AggregateMeasureV3;
  reasoning: AggregateMeasureV3;
  total: AggregateMeasureV3;
}

export interface UsageAggregateV3 {
  operations: number;
  duplicate_replays: number;
  usage_ids: readonly string[];
  priced_usage: readonly PricedUsageV3[];
  unknown_binding_usage_ids: readonly string[];
  incomplete_usage: readonly { usage_id: string; reason_codes: readonly string[] }[];
  cost_observed: AggregateMeasureV3;
  cost_estimated: AggregateMeasureV3;
  strong_tokens_observed: StrongTokenAggregateV3;
  strong_tokens_estimated: StrongTokenAggregateV3;
}

type TariffV3 = PricingSnapshotV3['tariffs'][number];
type DimensionV3 = 'input' | 'output' | 'cached_input' | 'reasoning';
type EvidenceKindV3 = 'observed' | 'estimated';

const dimensions: readonly DimensionV3[] = ['input', 'output', 'cached_input', 'reasoning'];
const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER);

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value) as T;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function assertNonnegativeSafeInteger(value: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`UNSAFE_INTEGER:${label}`);
  if (value < 0 || (positive && value === 0)) throw new RangeError(`INVALID_INTEGER:${label}`);
}

function safeNumber(value: bigint, label: string): number {
  if (value > maxSafeBigInt) throw new RangeError(`SAFE_INTEGER_OVERFLOW:${label}`);
  return Number(value);
}

function tokenField(kind: EvidenceKindV3, dimension: DimensionV3): keyof UsageRecordedV3 {
  return `${dimension}_tokens_${kind}` as keyof UsageRecordedV3;
}

function rateField(dimension: DimensionV3): keyof TariffV3 {
  return `${dimension}_token_micro_units_per_token` as keyof TariffV3;
}

function assertArithmeticInputs(usage: UsageRecordedV3, snapshot: PricingSnapshotV3): void {
  assertNonnegativeSafeInteger(snapshot.unit_scale, 'pricing_snapshot.unit_scale', true);
  for (const tariff of snapshot.tariffs) {
    for (const dimension of dimensions) {
      const rate = tariff[rateField(dimension)] as number | null;
      if (rate !== null) assertNonnegativeSafeInteger(rate, `tariff.${tariff.binding_ref}.${dimension}`);
    }
  }
  for (const kind of ['observed', 'estimated'] as const) {
    for (const dimension of dimensions) {
      const tokens = usage[tokenField(kind, dimension)] as number | null;
      if (tokens !== null) assertNonnegativeSafeInteger(tokens, `usage.${kind}.${dimension}`);
    }
  }
  if (usage.cost_observed !== null) assertNonnegativeSafeInteger(usage.cost_observed, 'usage.cost_observed');
  if (usage.cost_estimated !== null) assertNonnegativeSafeInteger(usage.cost_estimated, 'usage.cost_estimated');
}

function hasDimensionEvidence(usage: UsageRecordedV3, kind: EvidenceKindV3): boolean {
  return dimensions.some(dimension => usage[tokenField(kind, dimension)] !== null);
}

function dimensionalCost(
  usage: UsageRecordedV3,
  tariff: TariffV3,
  kind: EvidenceKindV3,
  errors: string[],
): number | null {
  let total = 0n;
  let complete = true;
  for (const dimension of dimensions) {
    const rate = tariff[rateField(dimension)] as number | null;
    if (rate === null) continue;
    const tokens = usage[tokenField(kind, dimension)] as number | null;
    if (tokens === null) {
      errors.push(`${kind.toUpperCase()}_DIMENSION_MISSING:${dimension}`);
      complete = false;
      continue;
    }
    total += BigInt(tokens) * BigInt(rate);
  }
  return complete ? safeNumber(total, `${kind}_cost`) : null;
}

function snapshotErrors(usage: UsageRecordedV3, snapshot: PricingSnapshotV3): { errors: string[]; tariff: TariffV3 | null } {
  const errors: string[] = [];
  const { pricing_snapshot_hash: _selfHash, ...content } = snapshot;
  if (snapshot.pricing_snapshot_hash !== hashCanonical(content)) errors.push('PRICING_SNAPSHOT_HASH_MISMATCH');
  if (usage.pricing_snapshot_id !== snapshot.pricing_snapshot_id) errors.push('PRICING_SNAPSHOT_ID_MISMATCH');
  if (usage.currency !== snapshot.currency) errors.push('PRICING_CURRENCY_MISMATCH');
  const tariffBindings = new Set<string>();
  for (const tariff of snapshot.tariffs) {
    if (tariffBindings.has(tariff.binding_ref)) errors.push(`PRICING_TARIFF_BINDING_DUPLICATE:${tariff.binding_ref}`);
    tariffBindings.add(tariff.binding_ref);
  }
  const matches = snapshot.tariffs.filter(candidate => candidate.binding_ref === usage.binding_ref);
  if (matches.length === 0) errors.push('PRICING_TARIFF_NOT_FOUND');
  return { errors, tariff: matches.length === 1 ? matches[0] : null };
}

export function priceUsage(usage: UsageRecordedV3, snapshot: PricingSnapshotV3): PricedUsageV3 {
  assertArithmeticInputs(usage, snapshot);
  const snapshotCheck = snapshotErrors(usage, snapshot);
  const errors = [...snapshotCheck.errors];
  let costObserved: number | null = null;
  let costEstimated: number | null = null;
  let observedProvenance: PricedUsageV3['observed_cost_provenance'] = null;
  let estimatedProvenance: PricedUsageV3['estimated_cost_provenance'] = null;

  if (snapshotCheck.tariff && errors.length === 0) {
    const tariff = snapshotCheck.tariff;
    const observedEvidence = hasDimensionEvidence(usage, 'observed')
      || usage.cost_observed !== null || usage.provider_usage_id !== null || usage.cost_provenance === 'AUTHORITATIVE_BILL';
    if (observedEvidence) {
      if (usage.cost_provenance === 'AUTHORITATIVE_BILL') {
        const authoritativeErrors: string[] = [];
        if (!tariff.authoritative_charge_supported) authoritativeErrors.push('AUTHORITATIVE_CHARGE_NOT_SUPPORTED');
        if (usage.provider_usage_id === null) authoritativeErrors.push('AUTHORITATIVE_PROVIDER_USAGE_ID_MISSING');
        if (usage.cost_observed === null) authoritativeErrors.push('AUTHORITATIVE_AMOUNT_MISSING');
        if (authoritativeErrors.length === 0) {
          costObserved = usage.cost_observed;
          observedProvenance = 'AUTHORITATIVE_BILL';
        } else {
          errors.push(...authoritativeErrors);
          const reproduced = dimensionalCost(usage, tariff, 'observed', errors);
          if (reproduced !== null && usage.cost_observed !== null && usage.cost_observed !== reproduced) {
            errors.push('AUTHORITATIVE_REPRODUCED_COST_MISMATCH');
          } else if (reproduced !== null) {
            costObserved = reproduced;
            observedProvenance = 'TARIFF_REPRODUCED';
          }
        }
      } else {
        if (usage.cost_provenance === null) errors.push('AUTHORITATIVE_PROVENANCE_MISSING');
        const reproduced = dimensionalCost(usage, tariff, 'observed', errors);
        if (reproduced !== null && usage.cost_observed !== null && usage.cost_observed !== reproduced) {
          errors.push('RECORDED_OBSERVED_COST_MISMATCH');
        } else if (reproduced !== null) {
          costObserved = reproduced;
          observedProvenance = 'TARIFF_REPRODUCED';
        }
      }
    }

    const estimatedEvidence = hasDimensionEvidence(usage, 'estimated')
      || usage.token_estimator_id !== null || usage.token_estimator_version !== null
      || usage.cost_estimated !== null || usage.cost_provenance === 'ESTIMATED_TARIFF';
    if (estimatedEvidence) {
      if (usage.token_estimator_id === null || usage.token_estimator_version === null) errors.push('ESTIMATOR_IDENTITY_MISSING');
      const reproduced = dimensionalCost(usage, tariff, 'estimated', errors);
      if (usage.cost_estimated !== null && usage.cost_provenance !== 'ESTIMATED_TARIFF') {
        errors.push('ESTIMATED_PROVENANCE_INVALID');
      } else if (reproduced !== null && usage.cost_estimated !== null && usage.cost_estimated !== reproduced) {
        errors.push('RECORDED_ESTIMATED_COST_MISMATCH');
      } else if (reproduced !== null && usage.token_estimator_id !== null && usage.token_estimator_version !== null) {
        costEstimated = reproduced;
        estimatedProvenance = 'ESTIMATED_TARIFF';
      }
    }
  }

  return deepFreeze({
    ...usage,
    cost_observed: costObserved,
    cost_estimated: costEstimated,
    pricing_snapshot_hash: snapshot.pricing_snapshot_hash,
    observed_pricing_complete: costObserved !== null,
    estimated_pricing_complete: costEstimated !== null,
    observed_cost_provenance: observedProvenance,
    estimated_cost_provenance: estimatedProvenance,
    pricing_errors: sortedUnique(errors),
  });
}

function aggregateMeasure(values: readonly (number | null)[], label: string): AggregateMeasureV3 {
  let sum = 0n;
  let complete = 0;
  for (const value of values) {
    if (value === null) continue;
    assertNonnegativeSafeInteger(value, label);
    sum += BigInt(value);
    complete += 1;
  }
  const total = values.length;
  return deepFreeze({
    value: complete === total ? safeNumber(sum, label) : null,
    complete,
    total,
    completeness_ratio: total === 0 ? 0 : complete / total,
  });
}

function strongTokenAggregate(events: readonly PricedUsageV3[], kind: EvidenceKindV3): StrongTokenAggregateV3 {
  const values = (dimension: DimensionV3): Array<number | null> => events.map(event => {
    if (kind === 'estimated' && (event.token_estimator_id === null || event.token_estimator_version === null)) return null;
    return event[tokenField(kind, dimension)] as number | null;
  });
  const totals = events.map(event => {
    if (kind === 'estimated' && (event.token_estimator_id === null || event.token_estimator_version === null)) return null;
    const counts = dimensions.map(dimension => event[tokenField(kind, dimension)] as number | null);
    if (counts.some(count => count === null)) return null;
    return safeNumber(counts.reduce<bigint>((sum, count) => sum + BigInt(count as number), 0n), `strong_tokens_${kind}.total_operation`);
  });
  return {
    input: aggregateMeasure(values('input'), `strong_tokens_${kind}.input`),
    output: aggregateMeasure(values('output'), `strong_tokens_${kind}.output`),
    cached_input: aggregateMeasure(values('cached_input'), `strong_tokens_${kind}.cached_input`),
    reasoning: aggregateMeasure(values('reasoning'), `strong_tokens_${kind}.reasoning`),
    total: aggregateMeasure(totals, `strong_tokens_${kind}.total`),
  };
}

export function aggregateUsage(
  events: readonly UsageRecordedV3[],
  registry: BindingRegistryV3,
  snapshot: PricingSnapshotV3,
): UsageAggregateV3 {
  const unique = new Map<string, { canonical: string; usage: UsageRecordedV3 }>();
  let duplicateReplays = 0;
  for (const event of events) {
    const canonical = canonicalize(event);
    const prior = unique.get(event.usage_id);
    if (prior) {
      if (prior.canonical !== canonical) throw new Error(`CONFLICTING_USAGE_ID:${event.usage_id}`);
      duplicateReplays += 1;
      continue;
    }
    unique.set(event.usage_id, { canonical, usage: event });
  }

  const bindings = new Map<string, BindingRegistryV3[number]>();
  for (const binding of registry) {
    if (bindings.has(binding.binding_ref)) throw new Error(`DUPLICATE_BINDING_REF:${binding.binding_ref}`);
    bindings.set(binding.binding_ref, binding);
  }
  const unregisteredTariffBindings = sortedUnique(snapshot.tariffs
    .filter(tariff => !bindings.has(tariff.binding_ref))
    .map(tariff => `PRICING_TARIFF_BINDING_UNREGISTERED:${tariff.binding_ref}`));

  const unknownBindingUsageIds: string[] = [];
  const incompleteUsage: Array<{ usage_id: string; reason_codes: readonly string[] }> = [];
  const pricedUsage = [...unique.values()]
    .map(({ usage: event }) => {
      let priced = priceUsage(event, snapshot);
      const reasonCodes = [...priced.pricing_errors, ...unregisteredTariffBindings];
      if (!bindings.has(event.binding_ref)) {
        unknownBindingUsageIds.push(event.usage_id);
        reasonCodes.push('UNKNOWN_BINDING');
      }
      if (reasonCodes.includes('UNKNOWN_BINDING') || unregisteredTariffBindings.length > 0) {
        priced = {
          ...priced, cost_observed: null, cost_estimated: null,
          observed_pricing_complete: false, estimated_pricing_complete: false,
          observed_cost_provenance: null, estimated_cost_provenance: null,
          pricing_errors: sortedUnique(reasonCodes),
        };
      }
      if (priced.cost_observed === null) reasonCodes.push('COST_OBSERVED_INCOMPLETE');
      if (priced.cost_estimated === null) reasonCodes.push('COST_ESTIMATED_INCOMPLETE');
      const normalizedReasons = sortedUnique(reasonCodes);
      if (normalizedReasons.length > 0) incompleteUsage.push({ usage_id: event.usage_id, reason_codes: normalizedReasons });
      return priced;
    })
    .sort((left, right) => compareCodeUnits(left.usage_id, right.usage_id));

  incompleteUsage.sort((left, right) => compareCodeUnits(left.usage_id, right.usage_id));
  const strongUsage = pricedUsage.filter(event => bindings.get(event.binding_ref)?.capability_class === 'strong');
  return deepFreeze({
    operations: pricedUsage.length,
    duplicate_replays: duplicateReplays,
    usage_ids: pricedUsage.map(event => event.usage_id),
    priced_usage: pricedUsage,
    unknown_binding_usage_ids: unknownBindingUsageIds.sort(compareCodeUnits),
    incomplete_usage: incompleteUsage,
    cost_observed: aggregateMeasure(pricedUsage.map(event => event.cost_observed), 'cost_observed'),
    cost_estimated: aggregateMeasure(pricedUsage.map(event => event.cost_estimated), 'cost_estimated'),
    strong_tokens_observed: strongTokenAggregate(strongUsage, 'observed'),
    strong_tokens_estimated: strongTokenAggregate(strongUsage, 'estimated'),
  });
}
