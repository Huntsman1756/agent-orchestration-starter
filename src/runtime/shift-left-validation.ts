import { hashCanonicalV4 } from './canonical.js';
import {
  createShiftLeftLintRepairPacketV4,
  isStaticQualityValidationIdV4,
  type RepairPacketV4,
  type ShiftLeftValidationEvidenceV4,
} from './repair-packet.js';

export interface ShiftLeftReviewGateInputV4 {
  readonly story_id: string;
  readonly failed_attempt: number;
  readonly validation_results: readonly ShiftLeftValidationEvidenceV4[];
  readonly on_repair_packet?: (packet: RepairPacketV4) => Promise<void> | void;
  readonly review: () => Promise<void>;
}

export class ShiftLeftValidationFailureErrorV4 extends Error {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly repair_packet: RepairPacketV4;
  readonly failed_validation_ids: readonly string[];

  constructor(packet: RepairPacketV4, failedValidationIds: readonly string[]) {
    super('VALIDATION_FAILED: static quality gates rejected the candidate; a Repair Packet was emitted for Economy');
    this.name = 'ShiftLeftValidationFailureErrorV4';
    this.repair_packet = packet;
    this.failed_validation_ids = Object.freeze([...failedValidationIds]);
  }
}

function failed(message: string): never {
  throw new Error(`VALIDATION_FAILED: ${message}`);
}

export function deriveShiftLeftStoryIdV4(taskId: string): string {
  const stableTaskId = typeof taskId === 'string' && taskId.length > 0 ? taskId : 'frontier-execution';
  return `story_${hashCanonicalV4({ schema_version: 4, task_id: stableTaskId }).slice(0, 24)}`;
}

export async function runReviewAfterDeterministicValidationV4<T>(input: {
  readonly story_id: string;
  readonly failed_attempt: number;
  readonly validation_results: readonly ShiftLeftValidationEvidenceV4[];
  readonly on_repair_packet?: (packet: RepairPacketV4) => Promise<void> | void;
  readonly review: () => Promise<T>;
}): Promise<T> {
  if (input.validation_results.length === 0) failed('validation manifest is empty');
  const failedResults = input.validation_results.filter((result) => !result.passed);
  if (failedResults.length > 0) {
    const staticQualityFailures = failedResults.filter((result) => isStaticQualityValidationIdV4(result.validation_id));
    if (staticQualityFailures.length === 0) failed('deterministic validation failed');
    const packet = createShiftLeftLintRepairPacketV4({
      story_id: input.story_id,
      failed_attempt: input.failed_attempt,
      validation_results: staticQualityFailures,
    });
    await input.on_repair_packet?.(packet);
    throw new ShiftLeftValidationFailureErrorV4(
      packet,
      staticQualityFailures.map((result) => result.validation_id),
    );
  }
  return input.review();
}
