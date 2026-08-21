import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

import type { ModelProfile, Policy } from './types.js';

const roleNameSchema = z.enum(['orchestrator', 'executor', 'reviewer']);
const tierSchema = z.enum(['frontier', 'economy']);
const permissionSchema = z
  .object({
    read: z.boolean(),
    write: z.boolean(),
  })
  .strict();
const roleSchema = z
  .object({
    tier: tierSchema,
    capabilities: z.array(z.string().min(1)).min(1),
    permissions: permissionSchema,
  })
  .strict();

const policySchema = z
  .object({
    version: z.number().int().positive(),
    roles: z.record(roleNameSchema, roleSchema),
    validation: z
      .object({
        commands: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    routing: z
      .object({
        strategies: z.array(z.enum(['economy_only', 'orchestrated', 'frontier_execution'])).min(1),
      })
      .strict()
      .default({ strategies: ['orchestrated'] }),
    isolation: z
      .object({
        required: z.enum(['hard', 'degraded']),
      })
      .strict()
      .default({ required: 'hard' }),
  })
  .strict();

const assignmentSchema = z
  .object({
    provider: z.string().min(1),
    harnessProviders: z
      .object({
        codex: z.string().min(1).optional(),
        opencode: z.string().min(1).optional(),
        hermes: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    model: z.string().min(1),
    tier: tierSchema,
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    capabilities: z.array(z.string().min(1)).min(1),
    qualification: z
      .object({
        policyVersion: z.string().min(1),
        status: z.enum(['VERIFIED', 'UNQUALIFIED']),
        cleanRuns: z.number().int().nonnegative(),
        requiredCleanRuns: z.literal(3),
        evidenceHash: z.string().regex(/^[a-f0-9]{64}$/i),
      })
      .strict()
      .optional(),
  })
  .strict();

const profileSchema = z
  .object({
    version: z.number().int().positive(),
    id: z.string().min(1),
    assignments: z.record(roleNameSchema, assignmentSchema),
  })
  .strict();

async function loadYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf8'));
}

function validationError(kind: string, error: unknown): Error {
  if (error instanceof z.ZodError) {
    return new Error(`${kind} validation failed: ${z.prettifyError(error)}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export async function loadPolicy(path: string): Promise<Policy> {
  try {
    return policySchema.parse(await loadYaml(path)) as Policy;
  } catch (error) {
    throw validationError('Policy', error);
  }
}

export async function loadProfile(path: string): Promise<ModelProfile> {
  try {
    return profileSchema.parse(await loadYaml(path)) as ModelProfile;
  } catch (error) {
    throw validationError('Profile', error);
  }
}
