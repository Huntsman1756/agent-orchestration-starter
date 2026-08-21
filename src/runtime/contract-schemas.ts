import { z } from 'zod';

import { RUNTIME_FAILURE_CODES_V4 } from './failures.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const identifierSchema = z.string().min(1).max(128);
const runIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]{16,96}$/);
const requestIdSchema = z.string().regex(/^req_[A-Za-z0-9_-]{16,96}$/);
const sourceSensitivitySchema = z.enum(['PUBLIC', 'PRIVATE']);
const dataScopeSchema = z.literal('SOURCE_CODE_ONLY');
const taskTraitSchema = z.enum(['mechanical', 'localized', 'semantic-debugging', 'cross-file-reasoning', 'multimodal', 'long-horizon', 'architecture', 'security-sensitive', 'migration']);
const modelGuidanceSchema = z.object({
  id: identifierSchema,
  revision: identifierSchema,
  sourceUrls: uniqueArray(z.url().max(2_048).refine((value) => value.startsWith('https://'), 'guidance sources must use HTTPS'), { min: 1, max: 8 }),
  promptFormat: z.enum(['plain', 'markdown', 'xml']),
  contextPlacement: z.enum(['before-task', 'after-task']),
  reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  textVerbosity: z.enum(['low', 'medium', 'high']),
  temperature: z.number().min(0).max(2).nullable(),
  maxSteps: z.number().int().min(1).max(128),
  instructions: uniqueArray(z.string().min(1).max(500), { max: 16 }),
}).strict();
const windowsReservedDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const prohibitedPathCharacter = /[\0\\:*?"<>|[\]{}]/;

export function isNormalizedRepositoryRelativePathV4(value: string): boolean {
  if (value.length === 0 || value.startsWith('/')) return false;

  return value.split('/').every((segment) => (
    segment !== ''
    && segment !== '.'
    && segment !== '..'
    && !prohibitedPathCharacter.test(segment)
    && !/[. ]$/.test(segment)
    && !windowsReservedDeviceName.test(segment)
  ));
}

export const normalizedRepositoryRelativePathV4Schema = z.string().min(1).refine(
  isNormalizedRepositoryRelativePathV4,
  'path must be a normalized repository-relative exact path',
);

function uniqueArray<T extends z.ZodType>(item: T, options: { min?: number; max?: number } = {}) {
  let schema = z.array(item);
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  return schema.superRefine((value, context) => {
    if (new Set(value).size !== value.length) context.addIssue({ code: 'custom', message: 'duplicate values are not allowed' });
  });
}

const allowedChangeSchema = z.object({
  path: normalizedRepositoryRelativePathV4Schema,
  operations: uniqueArray(z.enum(['CREATE', 'MODIFY', 'DELETE']), { min: 1 }),
}).strict();

const acceptanceTestPathSchema = normalizedRepositoryRelativePathV4Schema.refine(
  (value) => /\.(?:spec|test)\.tsx?$/u.test(value),
  'acceptance tests must be .spec.ts[x] or .test.ts[x] files',
);

const implementationTargetSchema = z.object({
  path: normalizedRepositoryRelativePathV4Schema.refine(
    (value) => /\.tsx?$/u.test(value) && !/\.(?:spec|test)\.tsx?$/u.test(value),
    'implementation targets must be non-test TypeScript files',
  ),
  operations: uniqueArray(z.enum(['CREATE', 'MODIFY', 'DELETE']), { min: 1 }),
}).strict();

type SddStrictPolicyValue = {
  allowed_changes: readonly { path: string; operations: readonly string[] }[];
  acceptance_tests: readonly string[];
  implementation_targets: readonly { path: string; operations: readonly string[] }[];
};

function changeKey(change: { path: string; operations: readonly string[] }): string {
  return `${change.path}\u0000${[...change.operations].sort().join(',')}`;
}

function refineSddStrictPolicy(value: SddStrictPolicyValue, context: z.RefinementCtx): void {
  const acceptanceTests = new Set(value.acceptance_tests.map((path) => path.toLocaleLowerCase('en-US')));
  const targets = new Set(value.implementation_targets.map((change) => change.path.toLocaleLowerCase('en-US')));
  if (acceptanceTests.size !== value.acceptance_tests.length) {
    context.addIssue({ code: 'custom', path: ['acceptance_tests'], message: 'acceptance test paths must be unique case-insensitively' });
  }
  if (targets.size !== value.implementation_targets.length) {
    context.addIssue({ code: 'custom', path: ['implementation_targets'], message: 'implementation target paths must be unique case-insensitively' });
  }
  for (const path of acceptanceTests) {
    if (targets.has(path)) context.addIssue({ code: 'custom', path: ['implementation_targets'], message: 'acceptance tests cannot be implementation targets' });
  }
  const allowed = value.allowed_changes.map(changeKey).sort();
  const implementation = value.implementation_targets.map(changeKey).sort();
  if (allowed.length !== implementation.length || allowed.some((entry, index) => entry !== implementation[index])) {
    context.addIssue({ code: 'custom', path: ['implementation_targets'], message: 'implementation_targets must exactly mirror allowed_changes' });
  }
}

const taskRequestFields = {
  schema_version: z.literal(4),
  task_id: identifierSchema,
  request_id: requestIdSchema,
  repository_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  objective: z.string().min(1).max(4_000),
  task_class: identifierSchema,
  requested_risk_class: identifierSchema,
  requested_route: z.enum(['AUTO', 'ECONOMY', 'FRONTIER']),
  execution_requirements: z.object({
    taskTraits: uniqueArray(taskTraitSchema, { min: 1, max: 9 }),
    contextBytes: z.number().int().min(0).max(16 * 1024 * 1024),
    acceptanceCriteriaCount: z.number().int().min(1).max(64),
  }).strict().optional(),
  allowed_changes: z.array(allowedChangeSchema).min(1).max(256),
  acceptance_tests: uniqueArray(acceptanceTestPathSchema, { min: 1, max: 64 }),
  implementation_targets: z.array(implementationTargetSchema).min(1).max(256),
  allowed_validation_ids: uniqueArray(identifierSchema, { min: 1, max: 64 }),
  inputs: z.array(z.string().max(2_000)).max(64),
  constraints: z.array(z.string().max(2_000)).max(64),
  success_criteria: z.array(z.string().max(2_000)).min(1).max(64),
  max_files_changed: z.number().int().positive().max(256),
  max_changed_lines: z.number().int().positive().max(100_000),
  max_attempts: z.number().int().min(1).max(3),
  prohibited_actions: uniqueArray(identifierSchema, { max: 64 }),
  result_schema_version: z.literal(4),
};

export const runtimeTaskRequestV4Schema = z.object(taskRequestFields).strict().superRefine(refineSddStrictPolicy);

const bindingSchema = z.object({
  harness: identifierSchema,
  provider: identifierSchema,
  model: identifierSchema,
  tier: z.enum(['frontier', 'economy']),
  authentication: z.enum(['provider-api-key', 'chatgpt-subscription']).optional(),
  capability: identifierSchema,
  allowedDataScopes: uniqueArray(dataScopeSchema, { min: 1, max: 1 }),
  allowedSourceSensitivity: uniqueArray(sourceSensitivitySchema, { min: 1, max: 2 }),
  permissions: z.enum(['read-only', 'contract-write']),
  guidance: modelGuidanceSchema,
  execution: z.object({
    supportedTaskTraits: uniqueArray(taskTraitSchema, { min: 1, max: 9 }),
    maxSteps: z.number().int().min(1).max(128),
    maxToolUses: z.number().int().min(1).max(256),
    maxNoMutationSteps: z.number().int().min(1).max(32),
    timeoutSeconds: z.number().int().min(30).max(3_600),
    supportsFailedCandidateRepair: z.boolean(),
  }).strict().optional(),
}).strict();

export const runtimeProfileV4Schema = z.object({
  schemaVersion: z.literal(4),
  id: identifierSchema,
  bindings: z.object({
    orchestrator: bindingSchema,
    executor: bindingSchema,
    reasoningExecutor: bindingSchema.optional(),
    escalationExecutor: bindingSchema,
    frontierExecutor: bindingSchema,
    reviewer: bindingSchema,
  }).strict(),
  runtime: z.object({
    maxEconomyParallelRequests: z.number().int().positive().max(64),
    maxConcurrentRunsPerRepository: z.number().int().positive().max(64),
  }).strict(),
}).strict().superRefine((value, context) => {
  const roles = ['orchestrator', 'executor', 'reasoningExecutor', 'escalationExecutor', 'frontierExecutor', 'reviewer'] as const;
  const expected = {
    orchestrator: { tier: 'frontier', permissions: 'read-only' },
    executor: { tier: 'economy', permissions: 'contract-write' },
    reasoningExecutor: { tier: 'economy', permissions: 'contract-write' },
    escalationExecutor: { tier: 'economy', permissions: 'contract-write' },
    frontierExecutor: { tier: 'frontier', permissions: 'contract-write' },
    reviewer: { tier: 'frontier', permissions: 'read-only' },
  } as const;
  for (const role of roles) {
    const binding = value.bindings[role];
    if (binding === undefined) continue;
    if (binding.tier !== expected[role].tier) {
      context.addIssue({ code: 'custom', path: ['bindings', role, 'tier'], message: `${role} must use the ${expected[role].tier} tier` });
    }
    if (binding.permissions !== expected[role].permissions) {
      context.addIssue({ code: 'custom', path: ['bindings', role, 'permissions'], message: `${role} must use ${expected[role].permissions} permissions` });
    }
    if (binding.permissions === 'contract-write' && binding.execution === undefined) {
      context.addIssue({ code: 'custom', path: ['bindings', role, 'execution'], message: `${role} must declare an explicit qualified execution envelope` });
    }
    if (binding.authentication !== 'chatgpt-subscription') continue;
    if (binding.harness !== 'codex' || binding.permissions !== 'read-only' || (role !== 'orchestrator' && role !== 'reviewer')) {
      context.addIssue({ code: 'custom', path: ['bindings', role, 'authentication'], message: 'ChatGPT subscription authentication is restricted to read-only Codex orchestrator and reviewer bindings' });
    }
  }
});

const validationSchema = z.object({
  argv: z.array(identifierSchema).min(1).max(32),
  workingDirectory: z.string().min(1).max(512),
  timeoutSeconds: z.number().int().positive().max(86_400),
  sandboxProfile: identifierSchema,
}).strict();

export const runtimeRepositoryPolicyV4Schema = z.object({
  schemaVersion: z.literal(4),
  repositoryId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  base: z.object({ allowedBranches: uniqueArray(identifierSchema, { min: 1, max: 64 }) }).strict(),
  worktrees: z.object({ parentRef: identifierSchema }).strict(),
  routing: z.object({
    frontierOnly: z.object({
      riskClasses: uniqueArray(identifierSchema, { max: 64 }),
      taskClasses: uniqueArray(identifierSchema, { max: 64 }),
      paths: uniqueArray(normalizedRepositoryRelativePathV4Schema.max(512), { max: 256 }),
      sourceSensitivity: uniqueArray(sourceSensitivitySchema, { max: 2 }),
    }).strict(),
  }).strict(),
  validation: z.record(identifierSchema, validationSchema).refine((value) => Object.keys(value).length > 0, 'validation must not be empty'),
  sourcePolicy: z.object({ dataScope: dataScopeSchema, sourceSensitivity: sourceSensitivitySchema }).strict(),
  sandbox: z.object({
    requiredBackend: identifierSchema,
    requiredProfiles: uniqueArray(identifierSchema, { min: 1, max: 16 }),
  }).strict(),
  instructions: z.object({ approvedSources: uniqueArray(normalizedRepositoryRelativePathV4Schema.max(512), { min: 1, max: 64 }) }).strict(),
  publication: z.object({
    enabled: z.boolean(),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/).refine((value) => !value.includes('..') && !value.endsWith('.') && !value.endsWith('/')),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']),
    requireRequiredChecks: z.boolean(),
    timeoutSeconds: z.number().int().min(30).max(3_600),
  }).strict(),
}).strict();

export const runtimeWorkContractV4Schema = z.object({
  ...taskRequestFields,
  run_id: runIdSchema,
  repository_root_hash: hashSchema,
  base_sha: shaSchema,
  effective_risk_class: identifierSchema,
  effective_route: z.enum(['ECONOMY', 'FRONTIER']),
  route_decision_reasons: z.array(z.string().min(1).max(2_000)).min(1).max(64),
  route_decision_hash: hashSchema,
  execution_policy: z.object({
    lane: z.enum(['MECHANICAL_ECONOMY', 'REASONING_ECONOMY', 'FRONTIER_EXECUTION']),
    executorRole: z.enum(['executor', 'reasoningExecutor', 'frontierExecutor']),
    taskTraits: uniqueArray(taskTraitSchema, { min: 1, max: 9 }),
    maxSteps: z.number().int().min(1).max(128),
    maxToolUses: z.number().int().min(1).max(256),
    maxNoMutationSteps: z.number().int().min(1).max(32),
    timeoutSeconds: z.number().int().min(30).max(3_600),
    maxAttempts: z.number().int().min(1).max(3),
    repairBase: z.enum(['LAST_ACCEPTED_TREE', 'FAILED_CANDIDATE_TREE']),
    reasons: z.array(z.string().min(1).max(2_000)).min(1).max(16),
    healthEvidenceHashes: uniqueArray(hashSchema, { max: 128 }).optional(),
    policyHash: hashSchema,
  }).strict().optional(),
  effective_data_scope: dataScopeSchema,
  effective_source_sensitivity: sourceSensitivitySchema,
  sandbox_profile_hashes: z.record(identifierSchema, hashSchema).refine((value) => Object.keys(value).length > 0, 'sandbox profile hashes must not be empty'),
  policy_hash: hashSchema,
  profile_hash: hashSchema,
  contract_hash: hashSchema,
}).strict().superRefine(refineSddStrictPolicy);

const failureSchema = z.object({
  code: z.enum(RUNTIME_FAILURE_CODES_V4),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  evidence_hashes: uniqueArray(hashSchema, { max: 64 }),
}).strict();

export const runtimeResultV4Schema = z.object({
  run_id: runIdSchema,
  request_id: requestIdSchema,
  state: identifierSchema,
  effective_route: z.enum(['ECONOMY', 'FRONTIER']),
  route_decision_hash: hashSchema,
  effective_data_scope: dataScopeSchema,
  effective_source_sensitivity: sourceSensitivitySchema,
  branch: z.string().min(1).max(512),
  base_sha: shaSchema,
  head_sha: shaSchema.nullable(),
  contract_hash: hashSchema,
  policy_hash: hashSchema,
  profile_hash: hashSchema,
  attempts: z.array(z.object({ attempt: z.number().int().positive(), executor_binding_ref: identifierSchema, result_hash: hashSchema }).strict()).max(3),
  validation_results: z.array(z.object({ validation_id: identifierSchema, exit_code: z.number().int(), result_hash: hashSchema }).strict()).max(64),
  diff_hash: hashSchema,
  tree_hash: hashSchema,
  changed_files: uniqueArray(z.string().min(1).max(512), { max: 256 }),
  review_attestation_hash: hashSchema.nullable(),
  commit_sha: shaSchema.nullable(),
  publication: z.object({
    state: z.enum(['NOT_STARTED', 'PUSHED', 'PR_OPEN', 'CHECKS_PASSED', 'MERGED', 'SKIPPED']),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).nullable(),
    base_branch: z.string().min(1).max(192).nullable(),
    pull_request: z.number().int().positive().nullable(),
    pull_request_url: z.string().url().regex(/^https:\/\/github\.com\//).max(2_048).nullable(),
    merge_commit_sha: shaSchema.nullable(),
  }).strict(),
  failure: failureSchema.nullable(),
  artifact_manifest_hash: hashSchema,
}).strict();

export const reviewAttestationV4Schema = z.object({
  review_id: identifierSchema,
  reviewer_binding_ref: identifierSchema,
  reviewer_session_id: identifierSchema,
  run_id: runIdSchema,
  contract_hash: hashSchema,
  base_sha: shaSchema,
  reviewed_tree_hash: hashSchema,
  reviewed_diff_hash: hashSchema,
  validation_manifest_hash: hashSchema,
  decision: z.enum(['REQUEST_CONTEXT', 'ACCEPT', 'REJECT']),
  findings: z.array(z.object({ id: identifierSchema, severity: identifierSchema, message: z.string().min(1).max(2_000) }).strict()).max(128),
  requested_context_hashes: uniqueArray(hashSchema, { max: 64 }),
  unresolved_finding_ids: uniqueArray(identifierSchema, { max: 128 }),
  created_at: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+Z$/),
  attestation_hash: hashSchema,
}).strict().superRefine((value, context) => {
  if (value.decision === 'ACCEPT' && value.unresolved_finding_ids.length > 0) {
    context.addIssue({ code: 'custom', path: ['unresolved_finding_ids'], message: 'acceptance cannot have unresolved findings' });
  }
  if (value.decision === 'ACCEPT' && value.requested_context_hashes.length > 0) {
    context.addIssue({ code: 'custom', path: ['requested_context_hashes'], message: 'acceptance cannot have open context requests' });
  }
});
