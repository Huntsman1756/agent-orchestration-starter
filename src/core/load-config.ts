import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

import type { ModelProfile, Policy } from './types.js';

const roleNameSchema = z.enum(['orchestrator', 'executor', 'reviewer']);
const tierSchema = z.enum(['frontier', 'economy']);
const permissionSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
}).strict();
const roleSchema = z.object({
  tier: tierSchema,
  capabilities: z.array(z.string().min(1)).min(1),
  permissions: permissionSchema,
}).strict();

const policySchema = z.object({
  version: z.number().int().positive(),
  roles: z.record(roleNameSchema, roleSchema),
  validation: z.object({
    commands: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict();

const assignmentSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  tier: tierSchema,
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  capabilities: z.array(z.string().min(1)).min(1),
}).strict();

const profileSchema = z.object({
  version: z.number().int().positive(),
  id: z.string().min(1),
  assignments: z.record(roleNameSchema, assignmentSchema),
}).strict();

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
