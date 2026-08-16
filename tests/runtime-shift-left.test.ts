import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ESLint } from 'eslint';

import type { RuntimeWorkContractV4 } from '../src/runtime/contracts.js';
import type { ExecutorAttemptResultV4 } from '../src/runtime/opencode-runner.js';
import { SHIFT_LEFT_REPAIR_INSTRUCTION_V4, loadRepairPacketV4 } from '../src/runtime/repair-packet.js';
import { createFrontierExecutor } from '../src/runtime/frontier-executor.js';
import { ShiftLeftValidationFailureErrorV4, runReviewAfterDeterministicValidationV4 } from '../src/runtime/shift-left-validation.js';

const treeHash = 'a'.repeat(64);
const resultHash = 'b'.repeat(64);
const diffHash = 'c'.repeat(64);
const shiftLeftFixturePath = fileURLToPath(new URL('./runtime-shift-left.test.ts', import.meta.url));
const contract = {
  task_id: 'lint-red-team',
  effective_route: 'FRONTIER',
  contract_hash: 'd'.repeat(64),
} as unknown as RuntimeWorkContractV4;
const capsule = { root: 'C:/capsule', manifest_hash: 'e'.repeat(64), instruction_manifest_hash: 'f'.repeat(64) };
const attempt = {
  session_id: 'executor-session',
  events: [],
  diff: {
    changes: [{ path: 'src/greeting.ts', operation: 'MODIFY', content_hash: '1'.repeat(64) }],
    changed_files: 1,
    changed_lines: 2,
    diff_hash: diffHash,
    tree_hash: treeHash,
  },
  capability_snapshot_hash: '2'.repeat(64),
} as unknown as ExecutorAttemptResultV4;

void test('static AST lint detects a functional eval diff without executing it', async () => {
  const eslint = new ESLint({
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    overrideConfigFile: fileURLToPath(new URL('../eslint.config.mjs', import.meta.url)),
  });
  const source = 'const output = eval(input);';
  // ESLint 9 with the typed flat config can return an empty first result under CI
  // while initializing the parser/rule state. The second pass uses the same
  // absolute fixture path and the same config, so the security assertion remains real.
  await eslint.lintText(source, { filePath: shiftLeftFixturePath });
  const results = await eslint.lintText(source, { filePath: shiftLeftFixturePath });
  const result = results[0];
  assert.ok(result, 'ESLint did not return a result for the shift-left fixture');
  assert.equal(result.filePath, shiftLeftFixturePath, 'ESLint analyzed an unexpected fixture path');
  const ignoredMessage = result.messages.find(
    (message) => message.ruleId === null && /ignored|no matching configuration/i.test(message.message),
  );
  assert.equal(ignoredMessage, undefined, `ESLint ignored the shift-left fixture: ${JSON.stringify(result.messages)}`);
  assert.ok(result.errorCount > 0, `ESLint did not report the eval violation: ${JSON.stringify(result.messages)}`);
  assert.ok(result.messages.some((message) => message.ruleId === 'no-eval' || message.ruleId === 'security/detect-eval-with-expression'));
});

void test('lint failure emits a hash-bound Repair Packet and never invokes Frontier review', async () => {
  let reviewCalls = 0;
  let repairPacket: ReturnType<typeof loadRepairPacketV4> | undefined;
  await assert.rejects(
    () =>
      runReviewAfterDeterministicValidationV4({
        story_id: 'story_shift_left',
        failed_attempt: 1,
        validation_results: [
          { validation_id: 'lint', passed: false, result_hash: resultHash, validated_tree_hash: treeHash, stderr_preview: 'no-eval' },
        ],
        on_repair_packet: (packet) => {
          repairPacket = loadRepairPacketV4(packet);
        },
        review: () => {
          reviewCalls += 1;
          return Promise.resolve();
        },
      }),
    (error: unknown) => error instanceof ShiftLeftValidationFailureErrorV4 && error.repair_packet.findings.length === 1,
  );
  assert.equal(reviewCalls, 0);
  assert.ok(repairPacket);
  assert.equal(repairPacket.findings[0]?.instruction, SHIFT_LEFT_REPAIR_INSTRUCTION_V4);
  assert.equal(repairPacket.findings[0]?.category_code, 'shift_left_static_quality');
  assert.equal(repairPacket.findings[0]?.source, 'VALIDATION');
});

void test('Frontier executor stops before fresh review and forwards lint evidence to Economy', async () => {
  let reviewCalls = 0;
  let forwardedPacket: ReturnType<typeof loadRepairPacketV4> | undefined;
  const states: string[] = [];
  const runner = createFrontierExecutor({
    execute_once: () => Promise.resolve(attempt),
    validate: () => Promise.resolve([{ validation_id: 'lint', passed: false, result_hash: resultHash, validated_tree_hash: treeHash }]),
    fresh_review: () => {
      reviewCalls += 1;
      return Promise.resolve({
        decision: 'ACCEPT' as const,
        reviewer_session_id: 'fresh-review-session',
        reviewed_tree_hash: treeHash,
        reviewed_diff_hash: diffHash,
      });
    },
    story_id: 'story_shift_left',
    on_repair_packet: ({ packet }) => {
      forwardedPacket = loadRepairPacketV4(packet);
    },
    on_state: (state) => {
      states.push(state);
    },
  });

  await assert.rejects(() => runner.execute(contract, capsule), /VALIDATION_FAILED/);
  assert.equal(reviewCalls, 0);
  assert.ok(forwardedPacket);
  assert.deepEqual(states, ['FRONTIER_EXECUTION', 'VALIDATION', 'TERMINAL_REJECTED']);
});
