import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
process.stdout.write(`${JSON.stringify({ type: 'message', role: 'assistant', text: 'done' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'result', status: 'completed', session_id: 'session_fixture_0001' })}\n`);
