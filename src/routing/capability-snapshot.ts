import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

import { hashCanonicalV4 } from '../runtime/canonical.js';
import { isNormalizedRepositoryRelativePathV4 } from '../runtime/contract-schemas.js';
import type { RuntimeWorkContractV4 } from '../runtime/contracts.js';
import { gitTextV4, runGit } from '../runtime/git-runner.js';

const HASH = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'] as const;
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_MAX_BYTES = 128 * 1024;
const MAX_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 256;

export type CapabilitySnapshotModeV4 = 'FULL' | 'SIGNATURE_FALLBACK';
export type CapabilitySnapshotFileModeV4 = 'FULL' | 'EXPORTED_SIGNATURES';
export type CapabilitySnapshotFileRoleV4 = 'implementation_target' | 'acceptance_test' | 'local_dependency';

export interface CapabilitySnapshotFileV4 {
  readonly path: string;
  readonly role: CapabilitySnapshotFileRoleV4;
  readonly mode: CapabilitySnapshotFileModeV4;
  readonly content: string;
  readonly content_hash: string;
}

export interface CapabilitySnapshotV4 {
  readonly schema_version: 4;
  readonly repository_id: string;
  readonly base_sha: string | null;
  readonly mode: CapabilitySnapshotModeV4;
  readonly max_bytes: number;
  readonly root_paths: readonly string[];
  readonly files: readonly CapabilitySnapshotFileV4[];
  readonly ignored_dynamic_imports: readonly string[];
  readonly total_bytes: number;
  readonly snapshot_hash: string;
  readonly rendered_context: string;
}

export interface CapabilitySnapshotBuildOptionsV4 {
  /** Trusted broker path. It is never included in the model context or hash. */
  readonly repository_root?: string;
  /** Use immutable `base_sha:path` reads instead of the mutable worktree. */
  readonly read_from_git?: boolean;
  readonly max_bytes?: number;
  readonly max_files?: number;
}

type CapabilityContractV4 = Pick<RuntimeWorkContractV4, 'repository_id' | 'acceptance_tests' | 'implementation_targets'> & {
  readonly base_sha?: string;
  readonly repository_root?: string;
};

interface ParsedSourceV4 {
  readonly path: string;
  readonly content: string;
  readonly source_file: ts.SourceFile;
  readonly imports: readonly string[];
  readonly dynamic_imports: readonly string[];
  readonly exported_signatures: string;
}

interface SnapshotBodyV4 {
  readonly schema_version: 4;
  readonly repository_id: string;
  readonly base_sha: string | null;
  readonly mode: CapabilitySnapshotModeV4;
  readonly max_bytes: number;
  readonly root_paths: readonly string[];
  readonly files: readonly CapabilitySnapshotFileV4[];
  readonly ignored_dynamic_imports: readonly string[];
  readonly total_bytes: number;
}

function invalid(message: string): never {
  throw new Error(`INVALID_CONTRACT: capability snapshot ${message}`);
}

function stableSort(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function foldPath(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function assertHash(value: string, name: string): void {
  if (!HASH.test(value)) invalid(`${name} is invalid`);
}

function validateLimit(value: number | undefined, name: string, maximum: number): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) invalid(`${name} is outside policy`);
  return resolved;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function printedSignature(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isExportDeclaration(node)) {
    return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
  }
  if (ts.isFunctionDeclaration(node)) {
    const signature = ts.factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      undefined,
    );
    return printer.printNode(ts.EmitHint.Unspecified, signature, sourceFile).trim();
  }
  if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations.map((declaration) => ts.factory.updateVariableDeclaration(
      declaration,
      declaration.name,
      declaration.exclamationToken,
      declaration.type,
      undefined,
    ));
    const declarationList = ts.factory.updateVariableDeclarationList(node.declarationList, declarations);
    const signature = ts.factory.updateVariableStatement(node, node.modifiers, declarationList);
    return printer.printNode(ts.EmitHint.Unspecified, signature, sourceFile).trim();
  }
  return null;
}

function exportedSignatures(sourceFile: ts.SourceFile): string {
  const signatures = sourceFile.statements
    .filter((statement) => hasExportModifier(statement))
    .map((statement) => printedSignature(statement, sourceFile))
    .filter((value): value is string => value !== null && value.length > 0);
  return signatures.join('\n\n');
}

function addSpecifier(specifiers: string[], value: string): void {
  if (value.length > 0 && !specifiers.includes(value)) specifiers.push(value);
}

function parseStaticImports(path: string, sourceFile: ts.SourceFile): { imports: readonly string[]; dynamic_imports: readonly string[] } {
  const imports: string[] = [];
  const dynamicImports: string[] = [];
  const recordDynamic = (node: ts.Node, kind: string): void => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    dynamicImports.push(`${path}:${location.line + 1}:${kind}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) addSpecifier(imports, specifier.text);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) addSpecifier(imports, reference.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      addSpecifier(imports, node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const expressionName = ts.isIdentifier(expression) ? expression.text : undefined;
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = expressionName === 'require';
      if (isDynamicImport || isRequire) {
        const first = node.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first)) {
          addSpecifier(imports, first.text);
          recordDynamic(node, isDynamicImport ? 'import' : 'require');
        } else {
          recordDynamic(node, isDynamicImport ? 'dynamic-import-ignored' : 'dynamic-require-ignored');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({ imports: Object.freeze(imports), dynamic_imports: Object.freeze(dynamicImports) });
}

function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function xmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderBody(body: SnapshotBodyV4, snapshotHash: string): string {
  const files = body.files.map((file) => [
    `<file path="${xmlAttribute(file.path)}" role="${file.role}" mode="${file.mode}" content_hash="${file.content_hash}">`,
    cdata(file.content),
    '</file>',
  ].join('\n')).join('\n');
  const dynamic = body.ignored_dynamic_imports.length === 0
    ? '<ignored-dynamic-imports count="0" />'
    : `<ignored-dynamic-imports count="${body.ignored_dynamic_imports.length}">${body.ignored_dynamic_imports.map(xmlAttribute).join('\n')}</ignored-dynamic-imports>`;
  return [
    `<capability_snapshot schema_version="4" repository_id="${xmlAttribute(body.repository_id)}" source_revision="${xmlAttribute(body.base_sha ?? 'WORKTREE')}" mode="${body.mode}" snapshot_hash="${snapshotHash}">`,
    `<roots count="${body.root_paths.length}">${body.root_paths.map((path) => `<path>${xmlAttribute(path)}</path>`).join('')}</roots>`,
    dynamic,
    ...body.files.length > 0 ? [files] : ['<files count="0" />'],
    '</capability_snapshot>',
  ].join('\n');
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function bodySize(body: SnapshotBodyV4): number {
  return bytes(renderBody(body, '0'.repeat(64)));
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toRepositoryPath(root: string, candidate: string): string {
  const relativePath = relative(root, candidate);
  if (relativePath === '' || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    invalid('local import escapes the repository root');
  }
  const normalized = relativePath.split(sep).join('/');
  if (!isNormalizedRepositoryRelativePathV4(normalized)) invalid(`resolved path is not normalized: ${normalized}`);
  return normalized;
}

function extensionCandidates(candidate: string): string[] {
  const extension = extname(candidate).toLowerCase();
  const values: string[] = [];
  if (SOURCE_EXTENSIONS.includes(extension as (typeof SOURCE_EXTENSIONS)[number])) values.push(candidate);
  else if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    const withoutExtension = candidate.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_EXTENSIONS) values.push(`${withoutExtension}${sourceExtension}`);
  } else {
    values.push(candidate, ...SOURCE_EXTENSIONS.map((sourceExtension) => `${candidate}${sourceExtension}`));
  }
  values.push(...SOURCE_EXTENSIONS.map((sourceExtension) => `${candidate}/index${sourceExtension}`));
  return [...new Set(values)];
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function isRootRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('src/') || specifier.startsWith('tests/') || specifier.startsWith('test/');
}

export async function build_capability_snapshot(
  contract: CapabilityContractV4,
  options: CapabilitySnapshotBuildOptionsV4 = {},
): Promise<CapabilitySnapshotV4> {
  const repositoryRootInput = options.repository_root ?? contract.repository_root;
  if (repositoryRootInput === undefined || !isAbsolute(repositoryRootInput)) invalid('repository_root must be absolute');
  const repositoryRoot = await realpath(resolve(repositoryRootInput)).catch(() => invalid('repository_root is unavailable'));
  const maxBytes = validateLimit(options.max_bytes ?? DEFAULT_MAX_BYTES, 'maximum context size', MAX_MAX_BYTES);
  const maxFiles = validateLimit(options.max_files, 'maximum file count', DEFAULT_MAX_FILES);
  const baseSha = contract.base_sha ?? null;
  if (options.read_from_git === true && (baseSha === null || !GIT_SHA.test(baseSha))) invalid('immutable base_sha is required for Git-backed reads');

  const targetPaths = contract.implementation_targets.map((change) => change.path);
  const createTargetPaths = new Set(contract.implementation_targets
    .filter((change) => change.operations.includes('CREATE'))
    .map((change) => foldPath(change.path)));
  const acceptancePaths = [...contract.acceptance_tests];
  const roots = stableSort([...targetPaths, ...acceptancePaths]);
  const rootSet = new Set(roots.map(foldPath));
  if (roots.some((path) => !isNormalizedRepositoryRelativePathV4(path)) || rootSet.size !== roots.length) {
    invalid('contract roots are invalid or ambiguous');
  }
  const roles = new Map<string, CapabilitySnapshotFileRoleV4>();
  for (const path of targetPaths) roles.set(foldPath(path), 'implementation_target');
  for (const path of acceptancePaths) {
    const folded = foldPath(path);
    if (roles.has(folded)) invalid('acceptance tests overlap implementation targets');
    roles.set(folded, 'acceptance_test');
  }

  const gitBacked = options.read_from_git === true;
  const sourceCache = new Map<string, Promise<string>>();
  const sourceFor = (path: string): Promise<string> => {
    const cached = sourceCache.get(path);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<string> => {
      let content: string;
      if (gitBacked) {
        try {
          content = gitTextV4(await runGit(repositoryRoot, ['show', `${baseSha}:${path}`]));
        } catch (error) {
          if (!createTargetPaths.has(foldPath(path))) throw error;
          content = '';
        }
      } else {
        const candidate = resolve(repositoryRoot, ...path.split('/'));
        let physical: string;
        try {
          physical = await realpath(candidate);
        } catch (error) {
          if (!createTargetPaths.has(foldPath(path))) invalid(`source file is unavailable: ${path}`);
          content = '';
          return content;
        }
        toRepositoryPath(repositoryRoot, physical);
        const raw = await readFile(physical);
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { invalid(`source file is not UTF-8: ${path}`); }
      }
      if (content.includes('\u0000')) invalid(`source file contains NUL bytes: ${path}`);
      if (bytes(content) > MAX_MAX_BYTES) invalid(`source file exceeds the bounded parser limit: ${path}`);
      return content;
    })();
    sourceCache.set(path, pending);
    return pending;
  };

  const parsed = new Map<string, Promise<ParsedSourceV4>>();
  const parse = (path: string): Promise<ParsedSourceV4> => {
    const cached = parsed.get(path);
    if (cached !== undefined) return cached;
    const pending = sourceFor(path).then((content) => {
      const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
      const imports = parseStaticImports(path, sourceFile);
      const references = sourceFile.referencedFiles.map((reference) => reference.fileName);
      const allImports = [...imports.imports];
      for (const reference of references) addSpecifier(allImports, reference);
      return Object.freeze({
        path,
        content,
        source_file: sourceFile,
        imports: Object.freeze(allImports),
        dynamic_imports: imports.dynamic_imports,
        exported_signatures: exportedSignatures(sourceFile),
      });
    });
    parsed.set(path, pending);
    return pending;
  };

  const resolveImport = async (from: string, specifier: string): Promise<string | undefined> => {
    if (!isRelativeSpecifier(specifier) && !isRootRelativeSpecifier(specifier)) return undefined;
    const candidateBase = isRelativeSpecifier(specifier)
      ? resolve(dirname(resolve(repositoryRoot, ...from.split('/'))), specifier)
      : resolve(repositoryRoot, ...specifier.split('/'));
    if (!isRelativeSpecifier(specifier)) {
      const relativeCandidate = relative(repositoryRoot, candidateBase);
      if (relativeCandidate === '..' || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) invalid(`import escapes the repository root: ${from} -> ${specifier}`);
    }
    for (const candidate of extensionCandidates(candidateBase)) {
      let candidatePath: string;
      try { candidatePath = toRepositoryPath(repositoryRoot, resolve(candidate)); } catch { continue; }
      if (candidatePath.split('/').includes('node_modules')) continue;
      try {
        await sourceFor(candidatePath);
        return candidatePath;
      } catch {
        // A missing extension candidate is expected while resolving TypeScript's
        // source-first module variants. The final unresolved result is fail-closed.
      }
    }
    invalid(`local static import cannot be resolved: ${from} -> ${specifier}`);
  };

  const queue = [...roots];
  const discovered = new Map<string, string>();
  const ignoredDynamicImports = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const folded = foldPath(current);
    if (discovered.has(folded)) continue;
    discovered.set(folded, current);
    if (discovered.size > maxFiles) invalid(`dependency graph exceeds ${maxFiles} files`);
    const source = await parse(current);
    for (const dynamic of source.dynamic_imports) ignoredDynamicImports.add(dynamic);
    for (const specifier of source.imports) {
      const dependency = await resolveImport(current, specifier);
      if (dependency !== undefined && !discovered.has(foldPath(dependency))) queue.push(dependency);
    }
  }

  const sourcePaths = stableSort([...discovered.values()]);
  const parsedSources = new Map<string, ParsedSourceV4>();
  for (const path of sourcePaths) parsedSources.set(path, await parse(path));
  const filesFor = (mode: CapabilitySnapshotModeV4): readonly CapabilitySnapshotFileV4[] => {
    const files = sourcePaths.map((path) => {
      const source = parsedSources.get(path)!;
      const role = roles.get(foldPath(path)) ?? 'local_dependency';
      const isRoot = rootSet.has(foldPath(path));
      const full = mode === 'FULL' || isRoot;
      const content = full ? source.content : source.exported_signatures || '// dependency exposes no exported type/interface signatures; implementation omitted.\n';
      const fileMode: CapabilitySnapshotFileModeV4 = full ? 'FULL' : 'EXPORTED_SIGNATURES';
      return Object.freeze({ path, role, mode: fileMode, content, content_hash: contentHash(content) });
    });
    return Object.freeze(files);
  };

  const common = {
    schema_version: 4 as const,
    repository_id: contract.repository_id,
    base_sha: baseSha,
    max_bytes: maxBytes,
    root_paths: Object.freeze(roots),
    ignored_dynamic_imports: Object.freeze(stableSort([...ignoredDynamicImports])),
  };
  const fullFiles = filesFor('FULL');
  const fullBody: SnapshotBodyV4 = Object.freeze({ ...common, mode: 'FULL', files: fullFiles, total_bytes: bodySize({ ...common, mode: 'FULL', files: fullFiles, total_bytes: 0 }) });
  let selectedBody: SnapshotBodyV4 = fullBody;
  if (bodySize(fullBody) > maxBytes) {
    const fallbackFiles = filesFor('SIGNATURE_FALLBACK');
    const fallbackBody: SnapshotBodyV4 = Object.freeze({ ...common, mode: 'SIGNATURE_FALLBACK', files: fallbackFiles, total_bytes: bodySize({ ...common, mode: 'SIGNATURE_FALLBACK', files: fallbackFiles, total_bytes: 0 }) });
    if (bodySize(fallbackBody) > maxBytes) invalid(`root context plus dependency signatures exceed ${maxBytes} bytes`);
    selectedBody = fallbackBody;
  }
  const snapshotHash = hashCanonicalV4(selectedBody);
  assertHash(snapshotHash, 'snapshot hash');
  const rendered = renderBody(selectedBody, snapshotHash);
  const totalBytes = bytes(rendered);
  if (totalBytes > maxBytes) invalid(`rendered context exceeds ${maxBytes} bytes`);
  return freeze({ ...selectedBody, total_bytes: totalBytes, snapshot_hash: snapshotHash, rendered_context: rendered });
}

export const buildCapabilitySnapshot = build_capability_snapshot;

export function isCapabilitySnapshotHashV4(value: string): boolean {
  return HASH.test(value);
}
