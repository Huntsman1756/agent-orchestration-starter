import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

interface PackageManifest {
  files?: string[];
  license?: string;
  scripts?: Record<string, string>;
}

interface PackedFile { path: string }
interface PackResult { files?: PackedFile[] }

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function markdownFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.toLowerCase().endsWith('.md')) result.push(path);
    }
  }
  await visit(directory);
  return result;
}

function localMarkdownTarget(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value)) return null;
  const path = value.startsWith('<') ? value.slice(1, value.indexOf('>')) : value.split(/\s+/u, 1)[0];
  const withoutFragment = path.split(/[?#]/u, 1)[0];
  return withoutFragment.length === 0 ? null : withoutFragment;
}

async function readPackFileList(): Promise<Set<string>> {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const result = await execFileAsync(command, args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(result.stdout) as PackResult[];
  assert.equal(parsed.length, 1, 'npm pack must return exactly one package result');
  return new Set((parsed[0]?.files ?? []).map((file) => file.path));
}

test('npm package contains every local README/documentation link', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as PackageManifest;

  assert.ok(manifest.files?.includes('docs/**'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.scripts?.prepublishOnly, 'npm run validate');

  const packed = await readPackFileList();
  assert.ok(packed.has('README.md'));
  assert.equal(
    [...packed].some((path) => path.startsWith('docs/superpowers/') || path.startsWith('pilot/')),
    false,
    'published packages must exclude completed tool-specific plans and local pilot fixtures',
  );
  for (const document of [resolve(root, 'README.md'), ...(await markdownFiles(resolve(root, 'docs')))]) {
    const content = await readFile(document, 'utf8');
    const links = [...content.matchAll(/\[[^\]]*\]\(([^)\n]+)\)/gu)]
      .map((match) => localMarkdownTarget(match[1] ?? ''))
      .filter((value): value is string => value !== null);
    for (const link of links) {
      const target = resolve(dirname(document), link);
      const relativeTarget = relative(root, target).replaceAll('\\', '/');
      assert.ok(!relativeTarget.startsWith('../') && relativeTarget !== '..', `${relative(document, root)} links outside package root: ${link}`);
      assert.equal((await stat(target)).isFile(), true, `${relative(document, root)} links to a non-file: ${link}`);
      assert.ok(packed.has(relativeTarget), `${relative(document, root)} links to an unpacked file: ${relativeTarget}`);
    }
  }
});
