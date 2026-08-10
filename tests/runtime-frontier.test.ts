import assert from 'node:assert/strict';
import test from 'node:test';

import { createFrontierExecutor } from '../src/runtime/frontier-executor.js';

const diff = { changes: [{ path: 'src/greeting.ts', operation: 'MODIFY' as const, content_hash: '1'.repeat(64) }], changed_files: 1, changed_lines: 2, diff_hash: '2'.repeat(64), tree_hash: '3'.repeat(64) };
const attempt = { session_id: 'executor-session', events: [], diff };
const capsule = { root: 'C:/capsule', manifest_hash: '4'.repeat(64), instruction_manifest_hash: '5'.repeat(64) };
const contract = { effective_route: 'FRONTIER', contract_hash: '6'.repeat(64) } as any;

test('performs exactly one frontier execution, validation, and fresh exact-tree review', async () => {
  let executions = 0;
  const states: string[] = [];
  const runner = createFrontierExecutor({
    execute_once: async () => { executions += 1; return attempt; },
    validate: async () => [{ passed: true, result_hash: '7'.repeat(64), validated_tree_hash: diff.tree_hash }],
    fresh_review: async () => ({ decision: 'ACCEPT', reviewer_session_id: 'fresh-review-session', reviewed_tree_hash: diff.tree_hash, reviewed_diff_hash: diff.diff_hash }),
    on_state: (state) => { states.push(state); },
  });
  assert.equal(await runner.execute(contract, capsule), attempt);
  assert.equal(executions, 1);
  assert.deepEqual(states, ['FRONTIER_EXECUTION', 'VALIDATION', 'FRESH_REVIEW', 'ACCEPTED']);
});

test('validation failure or rejection is terminal and never triggers frontier repair', async () => {
  for (const scenario of ['validation', 'review'] as const) {
    let executions = 0;
    const states: string[] = [];
    const runner = createFrontierExecutor({
      execute_once: async () => { executions += 1; return attempt; },
      validate: async () => [{ passed: scenario !== 'validation', result_hash: '7'.repeat(64), validated_tree_hash: diff.tree_hash }],
      fresh_review: async () => ({ decision: scenario === 'review' ? 'REJECT' : 'ACCEPT', reviewer_session_id: 'fresh-review-session', reviewed_tree_hash: diff.tree_hash, reviewed_diff_hash: diff.diff_hash }),
      on_state: (state) => { states.push(state); },
    });
    await assert.rejects(() => runner.execute(contract, capsule), scenario === 'validation' ? /VALIDATION_FAILED/ : /REVIEW_REJECTED/);
    assert.equal(executions, 1);
    assert.equal(states.at(-1), 'TERMINAL_REJECTED');
  }
});
