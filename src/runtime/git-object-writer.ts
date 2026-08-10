import { spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { isNormalizedRepositoryRelativePathV4 } from './contract-schemas.js';

const SHA1 = /^[a-f0-9]{40}$/;
const TASK_REF = /^refs\/heads\/codex\/auto\/[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

export interface AcceptedTreeEntryV4 {
  readonly path: string;
  readonly mode: '100644' | '100755';
  readonly bytes: Uint8Array;
}

export interface AcceptedTreeInputV4 { readonly entries: readonly AcceptedTreeEntryV4[]; }
export interface GitTreeObjectV4 { readonly tree_sha: string; readonly blob_shas: Readonly<Record<string, string>>; }
export interface CommitObjectInputV4 {
  readonly tree_sha: string;
  readonly base_sha: string;
  readonly message: string;
  readonly author_name: string;
  readonly author_email: string;
  readonly authored_at: string;
}
export interface GitCommitObjectV4 { readonly commit_sha: string; readonly tree_sha: string; readonly parent_sha: string; }
export interface TaskRefUpdateInputV4 { readonly task_ref: string; readonly new_commit_sha: string; readonly expected_old_sha: string; }

export interface GitObjectWriterV4 {
  writeAcceptedTree(input: AcceptedTreeInputV4): Promise<GitTreeObjectV4>;
  createCommit(input: CommitObjectInputV4): Promise<GitCommitObjectV4>;
  updateTaskRef(input: TaskRefUpdateInputV4): Promise<void>;
}

export interface GitPlumbingInvocationV4 {
  readonly argv: readonly string[];
  readonly stdin: Uint8Array;
  readonly environment: Readonly<Record<string, string>>;
}
export interface GitPlumbingResultV4 { readonly stdout: Buffer; readonly stderr: Buffer; readonly exit_code: number; }
export interface GitObjectWriterDependenciesV4 {
  readonly repository_root: string;
  readonly empty_global_config: string;
  readonly empty_hooks_directory: string;
  readonly run_git?: (input: GitPlumbingInvocationV4) => Promise<GitPlumbingResultV4>;
}

function isolationFailure(message: string): never { throw new Error(`FINALIZATION_ISOLATION_FAILED: ${message}`); }
function finalizationFailure(message: string): never { throw new Error(`FINALIZATION_FAILED: ${message}`); }

function sanitizedEnvironment(emptyGlobalConfig: string, emptyHooksDirectory: string, additional: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  const inherited = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'] as const;
  const environment: Record<string, string> = {};
  for (const name of inherited) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  return Object.freeze({
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: emptyHooksDirectory,
    LC_ALL: 'C',
    ...additional,
  });
}

async function executeGit(repositoryRoot: string, input: GitPlumbingInvocationV4): Promise<GitPlumbingResultV4> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', input.argv, {
      cwd: repositoryRoot,
      env: input.environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exit_code: code ?? -1 }));
    child.stdin.end(Buffer.from(input.stdin));
  });
}

function outputSha(result: GitPlumbingResultV4, operation: string): string {
  if (result.exit_code !== 0) finalizationFailure(`${operation} failed: ${result.stderr.toString('utf8').trim()}`);
  const output = result.stdout.toString('ascii').trim();
  if (!SHA1.test(output)) isolationFailure(`${operation} emitted an unsupported object identifier`);
  return output;
}

interface TreeNode { readonly files: Map<string, { mode: '100644' | '100755'; sha: string }>; readonly directories: Map<string, TreeNode>; }
function node(): TreeNode { return { files: new Map(), directories: new Map() }; }

function insert(root: TreeNode, path: string, mode: '100644' | '100755', sha: string): void {
  const segments = path.split('/');
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (current.files.has(segment)) isolationFailure(`file/directory collision at ${path}`);
    let child = current.directories.get(segment);
    if (child === undefined) { child = node(); current.directories.set(segment, child); }
    current = child;
  }
  const name = segments.at(-1)!;
  if (current.directories.has(name) || current.files.has(name)) isolationFailure(`duplicate or colliding path ${path}`);
  current.files.set(name, { mode, sha });
}

function compareGitNames(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

export function createGitObjectWriter(deps: GitObjectWriterDependenciesV4): GitObjectWriterV4 {
  const injectedRunner = deps.run_git !== undefined;
  const run = deps.run_git ?? ((input) => executeGit(deps.repository_root, input));
  const intendedTrees = new Map<string, string>();
  const invoke = async (argv: readonly string[], stdin: Uint8Array = Buffer.alloc(0), extraEnv: Readonly<Record<string, string>> = {}) => {
    if (!injectedRunner) {
      if (!isAbsolute(deps.empty_global_config) || !isAbsolute(deps.empty_hooks_directory)) isolationFailure('broker-owned Git isolation paths must be absolute');
      const [configMetadata, hooksMetadata, hooksEntries] = await Promise.all([
        lstat(deps.empty_global_config).catch(() => isolationFailure('broker-owned empty Git config is unavailable')),
        lstat(deps.empty_hooks_directory).catch(() => isolationFailure('broker-owned empty hooks directory is unavailable')),
        readdir(deps.empty_hooks_directory).catch(() => isolationFailure('broker-owned empty hooks directory is unreadable')),
      ]);
      if (!configMetadata.isFile() || configMetadata.isSymbolicLink() || !hooksMetadata.isDirectory() || hooksMetadata.isSymbolicLink() || hooksEntries.length !== 0) isolationFailure('broker-owned Git isolation paths are not empty regular objects');
      const globalConfig = await readFile(deps.empty_global_config).catch(() => isolationFailure('broker-owned empty Git config is unavailable'));
      if (globalConfig.length !== 0) isolationFailure('broker-owned Git config is not empty');
    }
    return await run({ argv: Object.freeze([...argv]), stdin, environment: sanitizedEnvironment(deps.empty_global_config, deps.empty_hooks_directory, extraEnv) });
  };

  const makeTree = async (tree: TreeNode): Promise<string> => {
    const records: { name: string; bytes: Buffer }[] = [];
    for (const [name, child] of tree.directories) {
      const sha = await makeTree(child);
      records.push({ name, bytes: Buffer.from(`040000 tree ${sha}\t${name}\0`, 'utf8') });
    }
    for (const [name, file] of tree.files) records.push({ name, bytes: Buffer.from(`${file.mode} blob ${file.sha}\t${name}\0`, 'utf8') });
    records.sort((left, right) => compareGitNames(left.name, right.name));
    return outputSha(await invoke(['mktree', '-z'], Buffer.concat(records.map((record) => record.bytes))), 'mktree');
  };

  return Object.freeze({
    writeAcceptedTree: async (input: AcceptedTreeInputV4) => {
      const objectFormat = await invoke(['rev-parse', '--show-object-format']);
      if (objectFormat.exit_code !== 0 || objectFormat.stdout.toString('ascii').trim() !== 'sha1') isolationFailure('repository object format must be sha1');
      const root = node();
      const blobShas: Record<string, string> = {};
      const foldedPaths = new Set<string>();
      for (const entry of input.entries) {
        if (!isNormalizedRepositoryRelativePathV4(entry.path) || /[\u0000-\u001f\u007f]/.test(entry.path)) isolationFailure(`unsafe accepted path ${entry.path}`);
        if (entry.mode !== '100644' && entry.mode !== '100755') isolationFailure(`unsupported file mode for ${entry.path}`);
        const folded = entry.path.toLocaleLowerCase('en-US');
        if (foldedPaths.has(folded)) isolationFailure(`case-folding path collision at ${entry.path}`);
        foldedPaths.add(folded);
        const sha = outputSha(await invoke(['hash-object', '-w', '--no-filters', '--stdin'], entry.bytes), 'hash-object');
        blobShas[entry.path] = sha;
        insert(root, entry.path, entry.mode, sha);
      }
      const treeSha = await makeTree(root);
      return Object.freeze({ tree_sha: treeSha, blob_shas: Object.freeze({ ...blobShas }) });
    },
    createCommit: async (input: CommitObjectInputV4) => {
      if (!SHA1.test(input.tree_sha) || !SHA1.test(input.base_sha)) isolationFailure('commit object identifiers are invalid');
      if (input.message.length < 1 || Buffer.byteLength(input.message, 'utf8') > 16 * 1024 || input.message.includes('\0')
        || input.author_name.length < 1 || input.author_name.length > 256 || /[\u0000-\u001f\u007f<>]/.test(input.author_name)
        || input.author_email.length < 3 || input.author_email.length > 320 || /[\u0000-\u0020\u007f<>]/.test(input.author_email)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.authored_at) || Number.isNaN(Date.parse(input.authored_at))) isolationFailure('commit metadata is invalid');
      const identity = {
        GIT_AUTHOR_NAME: input.author_name,
        GIT_AUTHOR_EMAIL: input.author_email,
        GIT_AUTHOR_DATE: input.authored_at,
        GIT_COMMITTER_NAME: input.author_name,
        GIT_COMMITTER_EMAIL: input.author_email,
        GIT_COMMITTER_DATE: input.authored_at,
      };
      const commitSha = outputSha(await invoke(['commit-tree', input.tree_sha, '-p', input.base_sha], Buffer.from(`${input.message}\n`, 'utf8'), identity), 'commit-tree');
      intendedTrees.set(commitSha, input.tree_sha);
      return Object.freeze({ commit_sha: commitSha, tree_sha: input.tree_sha, parent_sha: input.base_sha });
    },
    updateTaskRef: async (input: TaskRefUpdateInputV4) => {
      if (!TASK_REF.test(input.task_ref) || input.task_ref.includes('..') || input.task_ref.endsWith('.') || input.task_ref.endsWith('/')) isolationFailure('ref is not a broker-owned task ref');
      if (!SHA1.test(input.new_commit_sha) || !SHA1.test(input.expected_old_sha)) isolationFailure('ref transaction object identifiers are invalid');
      const result = await invoke(['update-ref', input.task_ref, input.new_commit_sha, input.expected_old_sha]);
      if (result.exit_code !== 0) finalizationFailure(`compare-and-update rejected stale task ref: ${result.stderr.toString('utf8').trim()}`);
      const resolved = await invoke(['rev-parse', '--verify', input.task_ref]);
      if (outputSha(resolved, 'task ref verification') !== input.new_commit_sha) finalizationFailure('task ref verification did not match intended commit');
      const committedTree = await invoke(['rev-parse', '--verify', `${input.new_commit_sha}^{tree}`]);
      const intendedTree = intendedTrees.get(input.new_commit_sha);
      if (intendedTree === undefined || outputSha(committedTree, 'committed tree verification') !== intendedTree) isolationFailure('committed tree does not match accepted tree');
    },
  });
}
