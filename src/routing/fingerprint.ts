import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CaseFingerprintInput {
  workContract: JsonValue;
  baseSha: string;
  fixtures: Record<string, string>;
  policy: JsonValue;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('case fingerprint input contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export function computeCaseFingerprint(input: CaseFingerprintInput): string {
  const baseSha = input.baseSha.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) {
    throw new Error('case fingerprint requires a full 40- or 64-character hexadecimal base SHA');
  }
  const canonicalInput: JsonValue = {
    workContract: input.workContract,
    baseSha,
    fixtures: { ...input.fixtures },
    policy: input.policy,
  };
  return createHash('sha256').update(canonicalJson(canonicalInput)).digest('hex');
}
