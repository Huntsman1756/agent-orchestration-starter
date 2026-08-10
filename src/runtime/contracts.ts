import type { RuntimeFailureV4 } from './failures.js';

export type { RuntimeFailureCodeV4, RuntimeFailureV4 } from './failures.js';

export type DataScopeV4 = 'SOURCE_CODE_ONLY';
export type SourceSensitivityV4 = 'PUBLIC' | 'PRIVATE';
export type RequestedRouteV4 = 'AUTO' | 'ECONOMY' | 'FRONTIER';
export type EffectiveRouteV4 = 'ECONOMY' | 'FRONTIER';
export type ChangeOperationV4 = 'CREATE' | 'MODIFY' | 'DELETE';
export type ReviewDecisionV4 = 'REQUEST_CONTEXT' | 'ACCEPT' | 'REJECT';
export type RuntimeRoleV4 = 'orchestrator' | 'executor' | 'escalationExecutor' | 'frontierExecutor' | 'reviewer';
export type PromptFormatV4 = 'plain' | 'markdown' | 'xml';
export type ContextPlacementV4 = 'before-task' | 'after-task';

export interface RuntimeModelGuidanceV4 {
  id: string;
  revision: string;
  sourceUrls: readonly string[];
  promptFormat: PromptFormatV4;
  contextPlacement: ContextPlacementV4;
  reasoningEffort: string;
  textVerbosity: 'low' | 'medium' | 'high';
  temperature: number | null;
  maxSteps: number;
  instructions: readonly string[];
}

export interface AllowedChangeV4 {
  path: string;
  operations: readonly ChangeOperationV4[];
}

export interface RuntimeTaskRequestV4 {
  schema_version: 4;
  task_id: string;
  request_id: string;
  repository_id: string;
  objective: string;
  task_class: string;
  requested_risk_class: string;
  requested_route: RequestedRouteV4;
  allowed_changes: readonly AllowedChangeV4[];
  allowed_validation_ids: readonly string[];
  inputs: readonly string[];
  constraints: readonly string[];
  success_criteria: readonly string[];
  max_files_changed: number;
  max_changed_lines: number;
  max_attempts: number;
  prohibited_actions: readonly string[];
  result_schema_version: 4;
}

export interface RuntimeBindingV4 {
  harness: string;
  provider: string;
  model: string;
  capability: string;
  allowedDataScopes: readonly DataScopeV4[];
  allowedSourceSensitivity: readonly SourceSensitivityV4[];
  permissions: 'read-only' | 'contract-write';
  guidance: RuntimeModelGuidanceV4;
}

export interface RuntimeProfileV4 {
  schemaVersion: 4;
  id: string;
  bindings: Record<RuntimeRoleV4, RuntimeBindingV4>;
  runtime: { maxEconomyParallelRequests: number; maxConcurrentRunsPerRepository: number };
}

export interface RuntimeRepositoryPolicyV4 {
  schemaVersion: 4;
  repositoryId: string;
  base: { allowedBranches: readonly string[] };
  worktrees: { parentRef: string };
  routing: { frontierOnly: { riskClasses: readonly string[]; taskClasses: readonly string[]; paths: readonly string[]; sourceSensitivity: readonly SourceSensitivityV4[] } };
  validation: Record<string, { argv: readonly string[]; workingDirectory: string; timeoutSeconds: number; sandboxProfile: string }>;
  sourcePolicy: { dataScope: DataScopeV4; sourceSensitivity: SourceSensitivityV4 };
  sandbox: { requiredBackend: string; requiredProfiles: readonly string[] };
  instructions: { approvedSources: readonly string[] };
  publication: {
    enabled: boolean;
    remote: string;
    baseBranch: string;
    mergeMethod: 'squash' | 'merge' | 'rebase';
    requireRequiredChecks: boolean;
    timeoutSeconds: number;
  };
}

export interface RuntimeWorkContractV4 extends RuntimeTaskRequestV4 {
  run_id: string;
  repository_root_hash: string;
  base_sha: string;
  effective_risk_class: string;
  effective_route: EffectiveRouteV4;
  route_decision_reasons: readonly string[];
  route_decision_hash: string;
  effective_data_scope: DataScopeV4;
  effective_source_sensitivity: SourceSensitivityV4;
  sandbox_profile_hashes: Readonly<Record<string, string>>;
  policy_hash: string;
  profile_hash: string;
  contract_hash: string;
}

export interface RuntimeAttemptV4 {
  attempt: number;
  executor_binding_ref: string;
  result_hash: string;
}

export interface RuntimeValidationResultV4 {
  validation_id: string;
  exit_code: number;
  result_hash: string;
}

export interface RuntimePublicationV4 {
  state: 'NOT_STARTED' | 'PUSHED' | 'PR_OPEN' | 'CHECKS_PASSED' | 'MERGED' | 'SKIPPED';
  remote: string | null;
  base_branch: string | null;
  pull_request: number | null;
  pull_request_url: string | null;
  merge_commit_sha: string | null;
}

export interface RuntimeResultV4 {
  run_id: string;
  request_id: string;
  state: string;
  effective_route: EffectiveRouteV4;
  route_decision_hash: string;
  effective_data_scope: DataScopeV4;
  effective_source_sensitivity: SourceSensitivityV4;
  branch: string;
  base_sha: string;
  head_sha: string | null;
  contract_hash: string;
  policy_hash: string;
  profile_hash: string;
  attempts: readonly RuntimeAttemptV4[];
  validation_results: readonly RuntimeValidationResultV4[];
  diff_hash: string;
  tree_hash: string;
  changed_files: readonly string[];
  review_attestation_hash: string | null;
  commit_sha: string | null;
  publication: RuntimePublicationV4;
  failure: RuntimeFailureV4 | null;
  artifact_manifest_hash: string;
}

export interface ReviewFindingV4 { id: string; severity: string; message: string; }

export interface ReviewAttestationV4 {
  review_id: string;
  reviewer_binding_ref: string;
  reviewer_session_id: string;
  run_id: string;
  contract_hash: string;
  base_sha: string;
  reviewed_tree_hash: string;
  reviewed_diff_hash: string;
  validation_manifest_hash: string;
  decision: ReviewDecisionV4;
  findings: readonly ReviewFindingV4[];
  requested_context_hashes: readonly string[];
  unresolved_finding_ids: readonly string[];
  created_at: string;
  attestation_hash: string;
}
