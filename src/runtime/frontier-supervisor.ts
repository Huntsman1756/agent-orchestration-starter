import { z } from 'zod';

import {
  runIterativeExecutorV4,
  type IterativeExecutionRequestV4,
  type IterativeExecutionResultV4,
  type StoryIterationEventV4,
} from './iterative-executor.js';

const decisionSchema = z.object({
  decision_id: z.string().regex(/^decision_[A-Za-z0-9_-]{4,96}$/),
  decision_owner_ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/),
  authority_evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
  action: z.enum(['RETRY', 'ESCALATE']),
}).strict();

export type FrontierSupervisorDecisionV4 = z.infer<typeof decisionSchema>;

export interface FrontierSupervisorRequestV4 {
  readonly execution: Omit<IterativeExecutionRequestV4, 'review_control'>;
  readonly limits: {
    readonly max_frontier_decisions: number;
  };
  readonly decide: (input: {
    readonly rejected_event: StoryIterationEventV4;
    readonly tree_hash: string;
    readonly accepted_story_ids: readonly string[];
    readonly decision_index: number;
  }) => Promise<z.input<typeof decisionSchema>>;
}

/**
 * Drives the provider-neutral FRONTIER_LED loop. The host owns model access and
 * authority; this supervisor only binds each trusted decision to persisted
 * rejection evidence before another fresh worker session may start.
 */
export async function runFrontierSupervisorV4(input: FrontierSupervisorRequestV4): Promise<IterativeExecutionResultV4> {
  if (!Number.isSafeInteger(input.limits.max_frontier_decisions) || input.limits.max_frontier_decisions < 1 || input.limits.max_frontier_decisions > 64) {
    throw new Error('INVALID_CONTRACT: supervisor frontier decision budget is invalid');
  }

  let priorEvents = [...input.execution.prior_events];
  let priorDecisions = [...(input.execution.prior_frontier_decisions ?? [])];
  let frontierDecision: {
    decision_id: string;
    decision_owner_ref: string;
    authority_evidence_hash: string;
    rejected_event_hash: string;
    action: 'RETRY' | 'ESCALATE';
  } | undefined;

  for (;;) {
    const result = await runIterativeExecutorV4({
      ...input.execution,
      prior_events: priorEvents,
      prior_frontier_decisions: priorDecisions,
      review_control: frontierDecision === undefined
        ? { mode: 'FRONTIER_LED' }
        : { mode: 'FRONTIER_LED', frontier_decision: frontierDecision },
    });
    frontierDecision = undefined;

    if (result.status !== 'AWAITING_FRONTIER_DECISION') return result;
    if (result.frontier_decisions.length >= input.limits.max_frontier_decisions) {
      throw new Error('SUPERVISOR_BUDGET_EXHAUSTED: frontier decision budget reached');
    }

    const rejectedEvent = result.events.at(-1);
    if (rejectedEvent === undefined || rejectedEvent.outcome !== 'RETRY') {
      throw new Error('SUPERVISOR_POLICY_VIOLATION: pending frontier decision lacks rejected evidence');
    }

    const parsedDecision = decisionSchema.safeParse(await input.decide(Object.freeze({
      rejected_event: rejectedEvent,
      tree_hash: result.tree_hash,
      accepted_story_ids: Object.freeze(result.accepted_receipts.map((receipt) => receipt.story_id)),
      decision_index: result.frontier_decisions.length + 1,
    })));
    if (!parsedDecision.success) throw new Error('SUPERVISOR_POLICY_VIOLATION: frontier returned an invalid decision');

    priorEvents = [...result.events];
    priorDecisions = [...result.frontier_decisions];
    frontierDecision = { ...parsedDecision.data, rejected_event_hash: rejectedEvent.event_hash };
  }
}
