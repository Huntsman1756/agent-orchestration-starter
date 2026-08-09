import { z } from 'zod';

import {
  pilotBlockObservationV3Schema,
  pilotEvaluationReportV3Schema,
  pilotEventV3Schema,
  pilotManifestV3Schema,
  pilotRoutingGateV3Schema,
  type PilotBlockObservationV3,
  type PilotEvaluationReportV3,
  type PilotEventV3,
  type PilotManifestV3,
  type PilotRoutingGateV3,
} from './contracts.js';

function parse<T>(name: string, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`${name} validation failed: ${z.prettifyError(error)}`);
    throw error;
  }
}

export function loadPilotManifestV3(value: unknown): PilotManifestV3 {
  return parse('Pilot manifest V3', pilotManifestV3Schema, value);
}

export function loadPilotEventV3(value: unknown): PilotEventV3 {
  return parse('Pilot event V3', pilotEventV3Schema, value);
}

export function loadPilotBlockObservationV3(value: unknown): PilotBlockObservationV3 {
  return parse('Pilot block observation V3', pilotBlockObservationV3Schema, value);
}

export function loadPilotRoutingGateV3(value: unknown): PilotRoutingGateV3 {
  return parse('Pilot routing gate V3', pilotRoutingGateV3Schema, value);
}

export function loadPilotEvaluationReportV3(value: unknown): PilotEvaluationReportV3 {
  return parse('Pilot evaluation report V3', pilotEvaluationReportV3Schema, value);
}
