import type { RuntimeWorkContractV4 } from './contracts.js';
import type { ExecutorCapsuleV4 } from './executor-capsule.js';
import type { ExecutorAttemptResultV4 } from './opencode-runner.js';

export type FrontierStateV4 = 'FRONTIER_EXECUTION' | 'VALIDATION' | 'FRESH_REVIEW' | 'ACCEPTED' | 'TERMINAL_REJECTED';

export interface FrontierValidationEvidenceV4 {
  readonly passed: boolean;
  readonly result_hash: string;
  readonly validated_tree_hash: string;
}

export interface FrontierReviewEvidenceV4 {
  readonly decision: 'ACCEPT' | 'REJECT';
  readonly reviewer_session_id: string;
  readonly reviewed_tree_hash: string;
  readonly reviewed_diff_hash: string;
}

export interface FrontierExecutorV4 {
  execute(contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4): Promise<ExecutorAttemptResultV4>;
}

export interface FrontierExecutorDependenciesV4 {
  readonly execute_once: (contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4) => Promise<ExecutorAttemptResultV4>;
  readonly validate: (contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4, attempt: ExecutorAttemptResultV4) => Promise<readonly FrontierValidationEvidenceV4[]>;
  readonly fresh_review: (contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4, attempt: ExecutorAttemptResultV4, validation: readonly FrontierValidationEvidenceV4[]) => Promise<FrontierReviewEvidenceV4>;
  readonly on_state?: (state: FrontierStateV4) => void;
}

export function createFrontierExecutor(deps: FrontierExecutorDependenciesV4): FrontierExecutorV4 {
  const state = (value: FrontierStateV4): void => { deps.on_state?.(value); };
  const terminal = (code: 'VALIDATION_FAILED' | 'REVIEW_REJECTED', message: string): never => {
    state('TERMINAL_REJECTED');
    throw new Error(`${code}: ${message}`);
  };
  return Object.freeze({
    execute: async (contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4): Promise<ExecutorAttemptResultV4> => {
      if (contract.effective_route !== 'FRONTIER') throw new Error('EXECUTOR_POLICY_VIOLATION: frontier executor requires frontier route');
      state('FRONTIER_EXECUTION');
      let attempt: ExecutorAttemptResultV4;
      try {
        attempt = await deps.execute_once(contract, capsule);
      } catch (error) {
        state('TERMINAL_REJECTED');
        throw error;
      }
      state('VALIDATION');
      if (!/^[a-f0-9]{64}$/u.test(attempt.capability_snapshot_hash)) {
        terminal('VALIDATION_FAILED', 'executor did not return a valid capability snapshot hash');
      }
      let validation: readonly FrontierValidationEvidenceV4[];
      try {
        validation = await deps.validate(contract, capsule, attempt);
      } catch (error) {
        state('TERMINAL_REJECTED');
        throw error;
      }
      if (validation.length === 0 || validation.some((result) => !result.passed || result.validated_tree_hash !== attempt.diff.tree_hash || !/^[a-f0-9]{64}$/.test(result.result_hash))) {
        terminal('VALIDATION_FAILED', 'deterministic validation did not accept the exact tree');
      }
      state('FRESH_REVIEW');
      let review: FrontierReviewEvidenceV4;
      try {
        review = await deps.fresh_review(contract, capsule, attempt, validation);
      } catch (error) {
        state('TERMINAL_REJECTED');
        throw error;
      }
      if (review.decision !== 'ACCEPT' || review.reviewer_session_id === attempt.session_id
        || review.reviewed_tree_hash !== attempt.diff.tree_hash || review.reviewed_diff_hash !== attempt.diff.diff_hash) {
        terminal('REVIEW_REJECTED', 'fresh review did not accept the exact evidence');
      }
      state('ACCEPTED');
      return attempt;
    },
  });
}
