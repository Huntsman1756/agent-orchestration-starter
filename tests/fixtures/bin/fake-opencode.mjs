import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Envelope captured from live OpenCode 1.18.15 and 1.18.16 JSONL runs on
// 2026-08-12. Keep this fixture aligned with the pinned harness; do not replace
// it with a broker-invented result shape.
const configPath = process.env.OPENCODE_CONFIG;
if (!configPath) throw new Error('OPENCODE_CONFIG missing');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const capture = {
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  environment_keys: Object.keys(process.env).sort(),
  config,
  hostile_project_config_present: await readFile(join(process.cwd(), 'repo', 'opencode.json'), 'utf8').then(() => true, () => false),
};
await writeFile(join(dirname(configPath), 'fake-opencode-capture.json'), `${JSON.stringify(capture)}\n`);
process.stdout.write(`${JSON.stringify({ type: 'step_start', sessionID: 'session_fixture_0001', part: { type: 'step-start' } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'tool_use', sessionID: 'session_fixture_0001', part: { type: 'tool', tool: 'write', callID: 'call_fixture_0001', state: { status: 'completed', input: { filePath: '/capsule/repo/src/greeting.ts', content: 'done' }, output: 'Wrote file successfully.' } } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'step_finish', sessionID: 'session_fixture_0001', part: { type: 'step-finish', reason: 'tool-calls' } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'step_start', sessionID: 'session_fixture_0001', part: { type: 'step-start' } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'text', sessionID: 'session_fixture_0001', part: { type: 'text', text: 'done' } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'step_finish', sessionID: 'session_fixture_0001', part: { type: 'step-finish', reason: 'stop' } })}\n`);
