import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';
import { z } from 'zod';

import type { BenchmarkObservation, RoutingGatePolicy } from './types.js';

const routeSchema = z.enum(['economy_only', 'orchestrated', 'frontier_execution']);
const tokenUsageSchema = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).strict();
const observationSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  taskClass: z.string().min(1),
  attemptedRoute: routeSchema,
  firstPassAccepted: z.boolean(),
  finalAccepted: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  repairCount: z.number().int().nonnegative(),
  escalated: z.boolean(),
  postAcceptanceDefects: z.number().int().nonnegative(),
  frontierTokens: tokenUsageSchema,
  economyTokens: tokenUsageSchema,
}).strict().superRefine((value, context) => {
  if (value.firstPassAccepted && !value.finalAccepted) {
    context.addIssue({ code: 'custom', message: 'first-pass accepted tasks must also be finally accepted' });
  }
  if (value.escalated && value.firstPassAccepted) {
    context.addIssue({ code: 'custom', message: 'escalated tasks cannot count as first-pass accepted' });
  }
});

const gateSchema = z.object({
  schemaVersion: z.literal(1),
  baselineRoute: routeSchema,
  candidateRoutes: z.array(routeSchema).min(1),
  minSamplesPerRoute: z.number().int().positive(),
  minAcceptedTaskCostSavingsRate: z.number().min(0).max(1),
  maxFirstPassAcceptanceDropRate: z.number().min(0).max(1),
  maxEscalationRate: z.number().min(0).max(1),
  maxPostAcceptanceDefectRate: z.number().min(0),
}).strict().superRefine((value, context) => {
  if (new Set(value.candidateRoutes).size !== value.candidateRoutes.length) {
    context.addIssue({ code: 'custom', message: 'candidateRoutes must be unique' });
  }
  if (value.candidateRoutes.includes(value.baselineRoute)) {
    context.addIssue({ code: 'custom', message: 'baselineRoute cannot also be a candidate route' });
  }
});

function asError(kind: string, error: unknown): Error {
  if (error instanceof z.ZodError) return new Error(`${kind} validation failed: ${z.prettifyError(error)}`);
  return error instanceof Error ? error : new Error(String(error));
}

export async function loadBenchmarkObservations(path: string): Promise<BenchmarkObservation[]> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  const observations: BenchmarkObservation[] = [];
  const taskIds = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const observation = observationSchema.parse(JSON.parse(line)) as BenchmarkObservation;
      if (taskIds.has(observation.taskId)) throw new Error(`duplicate taskId: ${observation.taskId}`);
      taskIds.add(observation.taskId);
      observations.push(observation);
    } catch (error) {
      throw asError(`Observation line ${index + 1}`, error);
    }
  }
  if (observations.length === 0) throw new Error('Benchmark observations file is empty');
  return observations;
}

export async function loadRoutingGatePolicy(path: string): Promise<RoutingGatePolicy> {
  try {
    return gateSchema.parse(parse(await readFile(path, 'utf8'))) as RoutingGatePolicy;
  } catch (error) {
    throw asError('Routing gate policy', error);
  }
}
