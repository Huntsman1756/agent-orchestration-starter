import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/cli/main.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function quickStartCommands(markdown: string): string[][] {
  const section = markdown.match(/## Quick start(?<body>[\s\S]*?)## Autonomous lifecycle/u)?.groups?.body;
  assert.ok(section, 'README must contain a Quick start section before Autonomous lifecycle');
  const blocks = [...section.matchAll(/```powershell\r?\n(?<body>[\s\S]*?)```/gu)];
  return blocks.flatMap((match) => {
    const normalized = (match.groups?.body ?? '').replace(/`\s*\r?\n\s*/gu, ' ');
    return normalized
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('node dist/cli/main.js '))
      .map((line) => line.split(/\s+/u).slice(2));
  });
}

function powershellCommands(markdown: string, startHeading: string, endHeading: string): string[][] {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start + startHeading.length);
  assert.ok(start >= 0 && end > start, `${startHeading} must precede ${endHeading}`);
  const section = markdown.slice(start, end);
  return [...section.matchAll(/```powershell\r?\n(?<body>[\s\S]*?)```/gu)]
    .flatMap((match) => (match.groups?.body ?? '').split(/\r?\n/gu))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
}

test('README Quick start commands execute through the public CLI', async () => {
  const target = await mkdtemp(resolve(tmpdir(), 'ao-readme-quick-start-'));
  try {
    const markdown = await readFile(resolve(root, 'README.md'), 'utf8');
    const commands = quickStartCommands(markdown);
    assert.deepEqual(commands.map(([command]) => command), ['init', 'runtime', 'init', 'check', 'doctor']);
    assert.ok(commands[0]?.includes('--dry-run'), 'the first init must be an inspection-only dry run');
    assert.equal(commands[2]?.includes('--dry-run'), false, 'the second init must explicitly materialize the configuration');

    for (const [index, documented] of commands.entries()) {
      const argv = [...documented];
      const targetIndex = argv.indexOf('--target');
      if (targetIndex >= 0) argv[targetIndex + 1] = target;
      const errors: string[] = [];
      const exitCode = await runCli(argv, {
        stdout: () => undefined,
        stderr: (line) => errors.push(line),
        checkBinary: () => true,
      });
      assert.equal(exitCode, 0, `${argv[0]} failed: ${errors.join('; ')}`);
      if (index === 0) assert.deepEqual(await readdir(target), [], 'the documented dry run must not write the target');
    }
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

test('Runtime operations bind every privileged lifecycle command to one activation', async () => {
  const markdown = await readFile(resolve(root, 'docs/runtime-v4-operations.md'), 'utf8');
  const commands = powershellCommands(markdown, '## Intended lifecycle', '## Security and credentials');
  assert.deepEqual(commands, [
    ['agent-orchestration', 'runtime', 'daemon', '--activation', '<activation-v4.json>'],
    ['agent-orchestration', 'runtime', 'doctor', '--activation', '<activation-v4.json>'],
    ['agent-orchestration', 'runtime', 'status', '--run-id', 'run_...', '--activation', '<activation-v4.json>'],
  ]);
});

test('dated V1 and V2 design records cannot be mistaken for current runtime contracts', async () => {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');
  const providerDesign = await readFile(resolve(root, 'docs/plans/2026-08-08-provider-agnostic-orchestration-design.md'), 'utf8');
  const routingDesign = await readFile(resolve(root, 'docs/plans/2026-08-08-evidence-based-routing-design.md'), 'utf8');

  assert.match(providerDesign.slice(0, 600), /> \*\*Status: historical design record\.\*\*/u);
  assert.match(routingDesign.slice(0, 600), /> \*\*Status: historical design record\.\*\*/u);
  assert.match(readme, /\[historical evidence-based routing design\]\(docs\/plans\/2026-08-08-evidence-based-routing-design\.md\)/u);
  assert.doesNotMatch(readme, /V3\s+\[(?:provider-neutral routing design|historical evidence-based routing design)\]/u);
});

test('reusable architecture documentation records portable lessons instead of local project identity', async () => {
  const review = await readFile(resolve(root, 'docs/research/architecture-review.md'), 'utf8');
  const roadmap = await readFile(resolve(root, 'docs/plans/2026-08-10-runtime-consolidation-roadmap.md'), 'utf8');

  assert.match(review, /## Consumer-derived lessons/u);
  assert.doesNotMatch(review, /## Local projects/u);
  assert.match(roadmap.slice(0, 500), /does not specialize the runtime for any single consumer repository, model or provider/u);
});
