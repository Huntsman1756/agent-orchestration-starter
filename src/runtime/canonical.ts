import { createHash } from 'node:crypto';

function normalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, ancestors));
  if (typeof value !== 'object') throw new Error(`canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new Error('canonical JSON does not support cyclic values');

  ancestors.add(value);
  const sorted = Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, normalize(item, ancestors)]),
  );
  ancestors.delete(value);
  return sorted;
}

export function canonicalJsonV4(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function hashCanonicalV4(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV4(value), 'utf8').digest('hex');
}
