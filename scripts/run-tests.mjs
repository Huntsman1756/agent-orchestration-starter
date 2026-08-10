import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = await readdir(join(root, 'tests'), { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => join('tests', entry.name))
  .sort();

if (testFiles.length === 0) throw new Error('No TypeScript test files found');

const child = spawn(process.execPath, ['--import', 'tsx/esm', '--test', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? 1;
});
