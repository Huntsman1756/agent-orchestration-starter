import { basename, posix } from 'node:path';

import { hashCanonicalV4 } from './canonical.js';
import type { FrozenRepositoryPolicyV4 } from './repository-policy.js';

export interface ResolvedValidationV4 {
  readonly validation_id: string;
  readonly argv: readonly string[];
  readonly working_directory: string;
  readonly timeout_ms: number;
  readonly sandbox_profile: 'VALIDATION_UNTRUSTED';
  readonly policy_hash: string;
  readonly resolution_hash: string;
}

const issued = new WeakSet<object>();
function failed(message: string): never {
  throw new Error(`VALIDATION_FAILED: ${message}`);
}

function validateCommand(argv: readonly string[]): void {
  if (
    argv.length < 1 ||
    argv.length > 128 ||
    argv.some((value) => value.length < 1 || value.length > 8192 || /[;&|`$<>\0\r\n]/.test(value))
  ) {
    failed('validation argv is unsafe');
  }
  const executable = basename(argv[0]!)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/i, '');
  if (['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'npx', 'bunx'].includes(executable))
    failed('shell or downloader validation is forbidden');
  if (
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) &&
    ['install', 'i', 'add', 'ci', 'publish', 'pack', 'link', 'exec'].includes((argv[1] ?? '').toLowerCase())
  ) {
    failed('install or lifecycle validation is forbidden');
  }
}

function validWorkingDirectory(value: string): boolean {
  return (
    value === '.' ||
    (value.length <= 512 &&
      value === posix.normalize(value) &&
      !value.startsWith('/') &&
      value !== '..' &&
      !value.startsWith('../') &&
      !value.includes('\\'))
  );
}

export function resolveValidation(policy: FrozenRepositoryPolicyV4, validationId: string): ResolvedValidationV4 {
  const selected = policy.policy.validation[validationId];
  if (selected === undefined) failed(`unknown validation ID: ${validationId}`);
  validateCommand(selected.argv);
  if (!validWorkingDirectory(selected.workingDirectory)) failed('validation working directory is unsafe');
  if (!Number.isSafeInteger(selected.timeoutSeconds) || selected.timeoutSeconds < 1 || selected.timeoutSeconds > 3600)
    failed('validation timeout is outside policy');
  if (selected.sandboxProfile !== 'VALIDATION_UNTRUSTED') failed('validation sandbox profile is not allowed');
  const body = Object.freeze({
    validation_id: validationId,
    argv: Object.freeze([...selected.argv]),
    working_directory: selected.workingDirectory,
    timeout_ms: selected.timeoutSeconds * 1000,
    sandbox_profile: 'VALIDATION_UNTRUSTED' as const,
    policy_hash: policy.hash,
  });
  const resolved = Object.freeze({ ...body, resolution_hash: hashCanonicalV4(body) });
  issued.add(resolved);
  return resolved;
}

export function assertResolvedValidationV4(value: ResolvedValidationV4, expectedPolicyHash: string): void {
  const { resolution_hash: suppliedHash, ...body } = value;
  if (!issued.has(value) || value.policy_hash !== expectedPolicyHash || suppliedHash !== hashCanonicalV4(body)) {
    failed('validation resolution authority is invalid');
  }
}
