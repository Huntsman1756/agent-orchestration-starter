import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const shaPattern = /^[a-f0-9]{40}$/;
const branchPattern = /^codex\/auto\/[A-Za-z0-9_-]{1,96}$/;

export interface GitResultV4 {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function allowedGitArgv(argv: readonly string[]): boolean {
  const [command, ...rest] = argv;
  if (command === 'rev-parse') {
    return (rest.length === 1 && rest[0] === 'HEAD')
      || (rest.length === 2 && rest[0] === '--verify' && /^[a-f0-9]{40}\^\{commit\}$/.test(rest[1] ?? ''));
  }
  if (command === 'status') return rest.length === 2 && rest[0] === '--porcelain=v2' && rest[1] === '-z';
  if (command === 'worktree') return rest.length === 4 && rest[0] === 'add' && rest[1] === '--detach' && shaPattern.test(rest[3] ?? '');
  if (command === 'branch') return rest.length === 2 && branchPattern.test(rest[0] ?? '') && shaPattern.test(rest[1] ?? '');
  if (command === 'show') return rest.length === 1 && /^[a-f0-9]{40}:[^\0\r\n]+$/.test(rest[0] ?? '');
  if (command === 'diff') {
    return rest.length === 5
      && ['--name-status', '--numstat', '--raw'].includes(rest[0] ?? '')
      && rest[1] === '-z'
      && rest[2] === '--no-renames'
      && shaPattern.test(rest[3] ?? '')
      && rest[4] === '--';
  }
  if (command === 'ls-files') {
    return rest.join('\0') === ['--others', '--exclude-standard', '-z'].join('\0');
  }
  return false;
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export async function runGit(repo: string, argv: readonly string[]): Promise<GitResultV4> {
  if (!allowedGitArgv(argv) || repo.includes('\0')) throw new Error('BROKER_STATE_CORRUPT: unapproved Git invocation');
  try {
    const result = await execFileAsync('git', ['-C', repo, ...argv], {
      encoding: 'buffer',
      env: sanitizedGitEnvironment(),
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
  } catch {
    throw new Error('BROKER_STATE_CORRUPT: approved Git invocation failed');
  }
}

export function gitTextV4(result: GitResultV4): string {
  return result.stdout.toString('utf8');
}
