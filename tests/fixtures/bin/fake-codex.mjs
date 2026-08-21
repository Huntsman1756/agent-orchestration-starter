import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const capture = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  environment_keys: Object.keys(process.env).sort(),
};
await writeFile(join(process.cwd(), 'config', 'fake-codex-capture.json'), JSON.stringify(capture));
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread_fixture_0001' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
process.stdout.write(
  `${JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify({ schema_version: 4, status: 'COMPLETED', summary: 'Implemented the bounded change.', changed_paths: ['src/greeting.ts'] }) } })}\n`,
);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } })}\n`);
