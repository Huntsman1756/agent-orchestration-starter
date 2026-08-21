import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/main.js';

const example = (name: string) => resolve('examples', name);

function validArgs(): string[] {
  return [
    'pilot-v3',
    'evaluate',
    '--manifest',
    example('pilot-manifest-v3.yaml'),
    '--events',
    example('pilot-events-v3.jsonl'),
    '--gate',
    example('pilot-routing-gate-v3.yaml'),
    '--evaluation-id',
    'evaluation-cli-v3-1',
    '--evaluation-version',
    '1',
  ];
}

test('pilot-v3 evaluate requires explicit evaluation identity instead of inventing it', async () => {
  const errors: string[] = [];
  const args = validArgs();
  args.splice(args.indexOf('--evaluation-id'), 2);

  const code = await runCli(args, { stderr: (line) => errors.push(line) });

  assert.equal(code, 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: --evaluation-id and --evaluation-version are required');
});

test('pilot-v3 evaluate deterministically reduces explicit events and emits observations plus report', async () => {
  const first: string[] = [];
  const second: string[] = [];

  assert.equal(await runCli(validArgs(), { stdout: (line) => first.push(line) }), 0);
  assert.equal(await runCli(validArgs(), { stdout: (line) => second.push(line) }), 0);
  assert.equal(first.join('\n'), second.join('\n'));

  const output = JSON.parse(first.join('\n'));
  assert.deepEqual(Object.keys(output), ['observations', 'report', 'schema_version']);
  assert.equal(output.schema_version, 3);
  assert.equal(output.observations.length, 3);
  assert.ok(output.observations.every((value: { valid_history: boolean }) => value.valid_history === false));
  assert.ok(output.observations.every((value: { total_usage: { operations: number } }) => value.total_usage.operations === 0));
  assert.equal(output.report.schema_version, 3);
  assert.equal(output.report.evaluation_id, 'evaluation-cli-v3-1');
  assert.equal(output.report.decision, 'REJECT');
});

test('pilot-v3 evaluate rejects a V2 event with a typed sanitized input error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-v3-cli-'));
  const events = join(directory, 'events.jsonl');
  await writeFile(events, '{"schemaVersion":2,"prompt":"secret payload must not echo"}\n', 'utf8');
  const args = validArgs();
  args[args.indexOf('--events') + 1] = events;
  const errors: string[] = [];

  const code = await runCli(args, { stderr: (line) => errors.push(line) });

  assert.equal(code, 2);
  assert.equal(errors[0], 'PILOT_V3_INPUT_ERROR: event line 1 is not valid V3 evidence');
  assert.doesNotMatch(errors.join('\n'), /secret payload/i);
});

test('pilot-v3 evaluate rejects empty event evidence instead of inferring execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-v3-cli-empty-'));
  const events = join(directory, 'events.jsonl');
  await writeFile(events, '\n', 'utf8');
  const args = validArgs();
  args[args.indexOf('--events') + 1] = events;
  const errors: string[] = [];

  const code = await runCli(args, { stderr: (line) => errors.push(line) });

  assert.equal(code, 2);
  assert.equal(errors[0], 'PILOT_V3_INPUT_ERROR: events JSONL is empty');
});

test('pilot-v3 evaluation versions require an exact prior report input pairing', async () => {
  const errors: string[] = [];
  const later = validArgs();
  later[later.indexOf('--evaluation-version') + 1] = '2';
  assert.equal(await runCli(later, { stderr: (line) => errors.push(line) }), 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: --prior-report is required when --evaluation-version is greater than 1');

  errors.length = 0;
  const first = [...validArgs(), '--prior-report', 'unexpected.json'];
  assert.equal(await runCli(first, { stderr: (line) => errors.push(line) }), 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: --prior-report is forbidden for evaluation version 1');
});

test('pilot-v3 evaluate rejects an option whose value is another flag', async () => {
  const args = validArgs();
  args.splice(args.indexOf('--evaluation-id') + 1, 1);
  const errors: string[] = [];

  assert.equal(await runCli(args, { stderr: (line) => errors.push(line) }), 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: --evaluation-id and --evaluation-version are required');
});

test('pilot-v3 evaluate rejects unknown arguments instead of ignoring them', async () => {
  const errors: string[] = [];

  assert.equal(await runCli([...validArgs(), '--execute-provider', 'true'], { stderr: (line) => errors.push(line) }), 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: unsupported option --execute-provider');
});

test('pilot-v3 evaluate rejects duplicate options instead of selecting one', async () => {
  const errors: string[] = [];

  assert.equal(await runCli([...validArgs(), '--evaluation-id', 'second-id'], { stderr: (line) => errors.push(line) }), 2);
  assert.equal(errors[0], 'PILOT_V3_ARGUMENT_ERROR: duplicate option --evaluation-id');
});
