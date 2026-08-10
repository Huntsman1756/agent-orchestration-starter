import { pilotEventV3Schema, type PilotEventV3 } from './contracts.js';

const MAX_STRING_LENGTH = 128;
const RAW_CONTENT_FIELDS = new Set(['prompt', 'response', 'transcript', 'diff', 'source', 'environment']);
const SECRET_BEARING_FIELDS = new Set(['apikey', 'secret', 'password', 'passwd', 'authorization', 'credential', 'privatekey', 'accesstoken', 'token']);
const CREDENTIAL_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^AKIA[0-9A-Z]{16}$/,
  /^gh[pousr]_[A-Za-z0-9_]{20,}$/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----$/,
];

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function assertSafeValue(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new Error(`Event value at ${path} is too long`);
    if (CREDENTIAL_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
      throw new Error(`Event value at ${path} has credential-shaped content`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertSafeValue(value[index], `${path}[${index}]`, seen);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Event value at ${path} is cyclic`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (RAW_CONTENT_FIELDS.has(normalized)) throw new Error(`Event contains forbidden raw ${key} field at ${path}`);
    if (SECRET_BEARING_FIELDS.has(normalized)) throw new Error(`Event contains secret-bearing ${key} field at ${path}`);
    assertSafeValue(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function assertSafeEvent(event: PilotEventV3): void {
  assertSafeValue(event, 'event', new Set<object>());
  const result = pilotEventV3Schema.safeParse(event);
  if (!result.success) throw new Error('Event violates the closed PilotEventV3 contract');
}
