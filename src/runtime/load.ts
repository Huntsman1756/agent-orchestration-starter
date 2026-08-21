import { z } from 'zod';
import { verifyRuntimeExecutionPolicyV4 } from './adaptive-execution.js';

import {
  reviewAttestationV4Schema,
  runtimeProfileV4Schema,
  runtimeRepositoryPolicyV4Schema,
  runtimeResultV4Schema,
  runtimeTaskRequestV4Schema,
  runtimeWorkContractV4Schema,
} from './contract-schemas.js';
import type {
  ReviewAttestationV4,
  RuntimeProfileV4,
  RuntimeRepositoryPolicyV4,
  RuntimeResultV4,
  RuntimeTaskRequestV4,
  RuntimeWorkContractV4,
} from './contracts.js';

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`Runtime contract validation failed: ${z.prettifyError(error)}`);
    throw error;
  }
}

export function loadRuntimeProfileV4(value: unknown): RuntimeProfileV4 {
  return parseContract(runtimeProfileV4Schema, value) as RuntimeProfileV4;
}

export function loadRuntimeTaskRequestV4(value: unknown): RuntimeTaskRequestV4 {
  return parseContract(runtimeTaskRequestV4Schema, value) as RuntimeTaskRequestV4;
}

export function loadRuntimeWorkContractV4(value: unknown): RuntimeWorkContractV4 {
  const contract = parseContract(runtimeWorkContractV4Schema, value) as RuntimeWorkContractV4;
  if (contract.execution_policy !== undefined) verifyRuntimeExecutionPolicyV4(contract.execution_policy);
  return contract;
}

export function loadRuntimeRepositoryPolicyV4(value: unknown): RuntimeRepositoryPolicyV4 {
  return parseContract(runtimeRepositoryPolicyV4Schema, value) as RuntimeRepositoryPolicyV4;
}

export function loadRuntimeResultV4(value: unknown): RuntimeResultV4 {
  return parseContract(runtimeResultV4Schema, value) as RuntimeResultV4;
}

export function loadReviewAttestationV4(value: unknown): ReviewAttestationV4 {
  return parseContract(reviewAttestationV4Schema, value) as ReviewAttestationV4;
}
