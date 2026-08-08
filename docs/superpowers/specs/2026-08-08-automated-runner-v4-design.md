# Automated Runner V4 Design

**Task:** `TASK-AGENT-ORCHESTRATION-AUTOMATED-RUNNER-V4-001`

**Status:** Approved design specification

## 1. Objective

V4 turns the existing compiler and offline evidence system into an automatic, fail-closed coding workflow. A user asks for a normal coding task in Codex. A Sol orchestrator classifies and contracts the work, a local typed broker executes it in an isolated Git worktree, OpenCode with ArliAI performs eligible implementation work, deterministic gates run, and an independent Sol reviewer accepts or rejects the resulting evidence. The broker creates a local commit on a task branch only after every required gate passes.

The intended default path is:

```text
Codex/Sol orchestrator
  -> typed broker
  -> isolated worktree
  -> OpenCode/MiMo
  -> deterministic validation
  -> fresh Codex/Sol reviewer
  -> broker commit on codex/auto/<run-id>
```

The user does not need to request delegation, worktree creation, validation, review, or commit explicitly. Automation does not mean bypass: any invalid contract, unavailable runner, policy violation, failed validation, rejected review, or evidence mismatch stops the run without a commit.

## 2. Relationship to V3

V3 remains the provider-neutral contract, telemetry, reduction, and evaluation layer. It answers whether an observed route has enough evidence to qualify for bounded promotion. V4 is a separate runtime layer that executes one task using a currently permitted route and emits evidence.

V4 must not:

- add provider calls or process execution to `src/pilot/`;
- reinterpret or weaken V3 schemas, state machines, or gates;
- make a runtime success count as routing promotion;
- mutate historical V3 evidence;
- infer capabilities from provider marketing labels.

V4 may emit V3-compatible events through a dedicated telemetry adapter. The adapter is downstream of runtime state and cannot influence the live run decision.

## 3. Scope and non-goals

V4 includes:

- role bindings that include both harness and profile;
- a local STDIO MCP broker with typed domain operations;
- repository allowlisting and one active run lock per repository;
- isolated Git worktrees and `codex/auto/<run-id>` branches;
- frozen base SHA, contract hash, diff hash, and final tree hash;
- headless OpenCode execution using explicit ArliAI models;
- capability probes for executable model bindings;
- fail-closed OpenCode permissions generated from project policy;
- deterministic validation with exact command allowlists;
- a fresh read-only Sol review session with a bounded evidence envelope;
- a bounded MiMo repair and GLM-4.7 escalation state machine;
- broker-owned final commit;
- append-only runtime artifacts and V3 telemetry export.

V4 excludes:

- push, pull request creation, merge, deploy, publication, SSH, or remote administration;
- production databases, production MCPs, real customer or fiscal data, and project secrets;
- arbitrary shell, Git, or filesystem tools exposed over MCP;
- Hermes production integration;
- DeepSeek, Qwen, Gemma, or GLM-4.6 in the default critical path;
- automatic modification of an unmanaged existing `AGENTS.md`;
- general-purpose workflow scheduling, queues, or multi-repository fan-out;
- automatic routing promotion based on one run.

## 4. Trust boundaries

MCP is the control plane, not the security boundary. The broker process is trusted to enforce the runtime policy and must assume that every model-produced value is untrusted input.

The broker exposes only these domain operations:

```text
run_coding_task(work_contract)
repair_coding_task(run_id, findings)
finalize_coding_task(run_id, review_attestation)
abort_coding_task(run_id)
get_coding_task_status(run_id)
```

It must never expose generic equivalents of:

```text
run_shell(command)
write_file(path, content)
git(command)
```

Before every state-changing operation the broker verifies:

- the repository resolves to an allowlisted canonical path;
- the run ID maps to that repository and cannot be reused elsewhere;
- the frozen base SHA still exists;
- the isolated worktree identity and branch match run state;
- the contract, policy, profile, and validation hashes match their frozen values;
- changed paths remain within the contract allowlist;
- the validation command is an exact permitted command, not a caller-supplied shell expression;
- no push, deploy, external repository access, or prohibited binary occurred;
- attempt and repair ceilings have not been exceeded;
- the supplied diff and tree hashes reproduce locally;
- finalization reviews the exact tree being committed.

The primary Sol orchestrator remains read-only. Its persistent instruction is:

```text
Any task requiring source-code mutation MUST use the orchestration runner.
The primary agent must not implement the change directly.
If the runner is unavailable, invalid, or fails policy validation, stop and
report the typed failure. Do not bypass orchestration.
```

Codex supports project-scoped STDIO MCP servers and consumes server instructions. V4 uses both a narrowly described tool surface and a read-only primary agent so broker failure cannot silently fall back to direct editing.

## 5. Hybrid role bindings

Harness is part of each runtime role binding. Stable policy continues to name capabilities; a versioned runtime profile maps them to concrete harnesses and models.

```yaml
schemaVersion: 4
id: esdata-arliai-opencode-pro
bindings:
  orchestrator:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-planning
    permissions: read-only

  executor:
    harness: opencode
    provider: arliai
    model: MiMo-V2.5
    capability: economy-coding
    permissions: contract-write

  escalationExecutor:
    harness: opencode
    provider: arliai
    model: GLM-4.7
    capability: strong-economy-coding
    permissions: contract-write

  frontierExecutor:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-coding
    permissions: contract-write

  reviewer:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-review
    permissions: read-only

runtime:
  maxArliParallelRequests: 2
  maxConcurrentRunsPerRepository: 1
```

Compilation must fail when a binding is unsupported by its harness. A profile cannot silently turn an ArliAI model into a Codex custom agent or place a Sol subscription model in OpenCode. Provider credentials and global provider definitions remain outside the repository.

## 6. Capability registry and probes

Every executable binding has a typed capability record:

```text
binding_ref
profile_hash
harness
provider
model
text_input
image_input
tool_calling
structured_result
file_edit
shell
multi_step_tool_use
failed_test_recovery
context_tokens
output_tokens
max_parallel_requests
probe_version
probed_at
probe_evidence_hash
status: VERIFIED | FAILED | STALE | UNPROBED
```

Model descriptions do not satisfy a capability requirement. `doctor --probe-runtime` performs bounded probes in a disposable fixture repository and records content-addressed evidence. A runtime binding must be `VERIFIED` under the current probe version and profile hash. Stale or failed probes stop execution.

Initial required probes are:

- MiMo: structured result, bounded edit, permitted validation command, multi-step tool use, and one failed-test recovery;
- GLM-4.7: the same executor capabilities;
- Sol reviewer: strict review-attestation output and read-only behavior;
- Sol frontier executor: bounded edit and validation behavior.

Gemma may later register image/document capabilities, but it is explicitly ineligible for the executor binding until a separate tool-calling probe passes.

## 7. Runtime contracts

### 7.1 Work contract V4

`runtime-task-v4.schema.json` is strict and includes:

```text
schema_version = 4
task_id
run_id
repository_id
repository_root_hash
base_sha
objective
task_class
risk_class
route
allowed_files[]
allowed_validation_ids[]
inputs[]
constraints[]
success_criteria[]
max_files_changed
max_changed_lines
max_attempts
network_policy = PROVIDER_ONLY
data_classification = PUBLIC_CODE_ONLY
prohibited_actions[]
result_schema_version
policy_hash
profile_hash
contract_hash
```

Caller-supplied absolute paths, shell fragments, environment values, credentials, remote URLs, and commands are forbidden. Validation IDs resolve through repository policy to exact argv arrays maintained by the project owner.

### 7.2 Runtime result V4

`runtime-result-v4.schema.json` contains bounded evidence only:

```text
run_id
state
route
branch
base_sha
head_sha | null
contract_hash
policy_hash
profile_hash
attempts[]
validation_results[]
diff_hash
tree_hash
changed_files[]
review_attestation_hash | null
commit_sha | null
failure | null
artifact_manifest_hash
```

Raw prompts, model reasoning, unrestricted command output, secrets, and full transcripts are excluded. Full diffs and bounded logs live as local content-addressed artifacts referenced by hash.

### 7.3 Review attestation V4

The strict attestation includes:

```text
review_id
reviewer_binding_ref
reviewer_session_id
run_id
contract_hash
base_sha
reviewed_tree_hash
reviewed_diff_hash
validation_manifest_hash
decision: ACCEPT | REJECT
findings[]
requested_context_hashes[]
unresolved_finding_ids[]
created_at
attestation_hash
```

An acceptance is invalid when any material finding remains unresolved or when any referenced hash differs from current broker state.

## 8. Repository and worktree lifecycle

The repository registry is local configuration owned by the user, not model input. Each entry defines canonical root, allowed base branches, worktree parent, validation registry, ignored volatile paths, and runtime policy.

For every new run the broker:

1. obtains an exclusive repository lock;
2. resolves and freezes the current permitted base SHA;
3. creates `codex/auto/<run-id>` and an isolated worktree under the configured worktree parent;
4. verifies the clean tree hash and records isolation evidence;
5. writes immutable run metadata outside model-editable paths;
6. launches the selected executor with the worktree as its only project directory;
7. revalidates paths, diff, tree, and policy after every executor attempt;
8. retains the worktree and artifacts on rejection or failure for inspection;
9. creates a commit only after accepted review and final hash reproduction.

The broker never checks out, resets, cleans, stashes, merges, or commits in the user's active worktree. The resulting commit remains on the task branch. Push and merge are outside V4.

Run artifacts are append-only under a broker-owned state directory. Model workers cannot edit run state or attestations.

## 9. OpenCode worker execution

The broker uses headless OpenCode with explicit directory, agent, model, JSON output, and automatic permission handling. The exact CLI argv is constructed internally; no CLI fragments come from the model or work contract.

The generated worker agent is fail-closed. Its default permissions are:

```text
question: deny
webfetch: deny
websearch: deny
external_directory: deny
task: deny
edit: allow only within the isolated worktree and contract file allowlist
bash: deny by default; allow exact validation and read-only Git commands only
```

Always prohibited to the worker:

- `git commit`, `git push`, `gh`, or remote Git operations;
- deploy CLIs, `ssh`, `scp`, `curl`, and arbitrary network tools;
- Docker lifecycle commands unless a future explicit policy adds an exact validation ID;
- access outside the isolated worktree;
- project `.env` files, credential stores, production fixtures, and real data;
- modifying broker state, attestations, inventory, or runtime policy.

OpenCode authentication may use its own user-level credential store. The broker launches it with a sanitized environment allowlist and never records credential values.

## 10. Routing and attempt state machine

The initial route is deliberately small:

```text
eligible normal task
  -> MiMo implementation
  -> deterministic gates
  -> Sol review 1
     -> ACCEPT: finalize
     -> REJECT: MiMo repair 1
        -> deterministic gates
        -> Sol review 2
           -> ACCEPT: finalize
           -> REJECT: GLM-4.7 final execution
              -> deterministic gates
              -> Sol final review
                 -> ACCEPT: finalize
                 -> REJECT: fail
```

High-risk, restricted, security, architecture, ambiguous debugging, and cross-cutting work routes directly to the Sol frontier executor in an isolated worktree, followed by deterministic gates and a separate Sol reviewer. It never uses MiMo merely to satisfy an "economy first" rule.

Normative ceilings:

- at most three executor attempts for the MiMo/GLM route;
- exactly one MiMo repair after the first rejected review;
- GLM-4.7 is legal only after the second rejected review and an explicit typed escalation event;
- no provider fallback on authentication, policy, invalid output, grounding, validation, or unknown failures;
- availability failure may retry the same binding within a bounded transport retry budget, but cannot change model silently;
- failed deterministic validation prevents review acceptance and commit;
- a final rejection terminates the run.

DeepSeek, Qwen, Gemma, and GLM-4.6 remain opt-in experimental bindings and cannot enter this state machine without a future versioned policy and evidence gate.

## 11. Independent Sol review

Each review is a new Codex/Sol session whose identifier differs from every executor and previous reviewer session. The broker supplies only:

- WorkContract V4;
- frozen base SHA;
- current complete diff and changed-file list;
- deterministic validation results and their hashes;
- unresolved findings from the immediately preceding review;
- bounded file context explicitly requested by the reviewer.

The reviewer never receives planner reasoning, executor reasoning, executor transcript, hidden tool traces, or a prior verdict. Additional file requests are checked against repository and contract policy before the broker returns content.

The existing generated reviewer contract remains the semantic foundation. V4 adds the strict attestation and runtime hash checks; it does not create a weaker second review mechanism.

## 12. Validation and finalization

Validation commands are registered as exact argv arrays, working directories, timeouts, and output budgets. They are never parsed through a shell. Each result records command ID, executable hash when available, exit code, duration, truncated-output hash, full local artifact hash, and the tree hash validated.

Finalization is a compare-and-commit transaction:

1. acquire the run and repository locks;
2. reproduce contract, policy, profile, diff, validation, review, and tree hashes;
3. verify every mandatory validation passed against the current tree;
4. verify the latest attestation accepts that exact tree;
5. verify no prohibited or out-of-scope path changed;
6. create a broker-authored commit with task ID and evidence manifest hash;
7. verify the committed tree equals the accepted tree;
8. persist terminal state and release locks.

The broker does not use `--no-verify`. If a Git hook changes the tree, fails, or performs a prohibited action, finalization fails and no successful terminal state is recorded.

## 13. Failure model and recovery

Every failure is typed:

```text
INVALID_CONTRACT
REPOSITORY_NOT_ALLOWED
REPOSITORY_BUSY
BASE_SHA_INVALID
WORKTREE_CREATION_FAILED
CAPABILITY_UNVERIFIED
AUTHENTICATION_FAILED
PROVIDER_UNAVAILABLE
EXECUTOR_INVALID_OUTPUT
EXECUTOR_POLICY_VIOLATION
OUT_OF_SCOPE_CHANGE
VALIDATION_FAILED
REVIEW_REJECTED
REVIEW_ATTESTATION_INVALID
EVIDENCE_HASH_MISMATCH
FINALIZATION_FAILED
ABORTED
UNKNOWN_FAILURE
```

Failures append evidence, preserve the task branch/worktree when useful, and return a bounded status to Sol. The orchestrator reports the failure and stops. It must not edit the repository, relax policy, rerun with an unapproved model, or finalize manually.

`abort_coding_task` terminates child processes, records `ABORTED`, and releases locks. It does not delete the worktree or branch automatically; cleanup is a separate explicit maintenance operation.

## 14. MCP server behavior

The local STDIO server returns concise instructions whose first section states:

- use `run_coding_task` for every source-code mutation request;
- do not write code in the primary Sol context;
- poll or resume the returned run rather than starting duplicates;
- stop on typed failure;
- never call finalization without a valid review attestation.

Tool schemas use strict JSON Schema and reject additional properties. Tool results are bounded summaries plus artifact hashes. Long-running execution uses a resumable run ID and status polling so MCP transport interruption does not duplicate work.

The server accepts only configured local repositories. A caller cannot register a new repository, alter validation commands, change provider credentials, or expand permissions through MCP.

## 15. Runtime telemetry

V4 records append-only runtime events for:

```text
RUN_PLANNED
WORKTREE_CREATED
CAPABILITY_CHECKED
EXECUTION_STARTED
EXECUTION_COMPLETED
DIFF_POLICY_CHECKED
VALIDATION_RECORDED
REVIEW_STARTED
REVIEW_COMPLETED
ESCALATION_DECIDED
FINALIZATION_STARTED
COMMIT_CREATED
RUN_FAILED
RUN_ABORTED
```

Events contain IDs, hashes, enums, counters, durations, binding references, and bounded findings. They exclude prompts, reasoning, raw model responses, credentials, environment values, and full diffs.

An adapter may translate admitted V4 events into the frozen V3 evidence vocabulary. Translation failures affect telemetry completeness but cannot turn a failed runtime gate into success.

## 16. Proposed implementation boundaries

```text
src/runtime/
  contracts.ts
  bindings.ts
  capabilities.ts
  routing.ts
  run-state.ts
  repository-registry.ts
  worktree.ts
  process-policy.ts
  opencode-runner.ts
  codex-runner.ts
  validation.ts
  diff-policy.ts
  review-envelope.ts
  review-attestation.ts
  finalize.ts
  telemetry.ts

src/mcp/
  server.ts
  tools.ts

contracts/
  runtime-profile-v4.schema.json
  runtime-task-v4.schema.json
  runtime-result-v4.schema.json
  review-attestation-v4.schema.json

profiles/
  arliai-opencode.example.yaml

tests/
  runtime-contracts.test.ts
  runtime-bindings.test.ts
  runtime-capabilities.test.ts
  runtime-routing.test.ts
  runtime-worktree.test.ts
  runtime-process-policy.test.ts
  runtime-opencode.test.ts
  runtime-codex-review.test.ts
  runtime-validation.test.ts
  runtime-security.test.ts
  runtime-finalize.test.ts
  runtime-telemetry.test.ts
  mcp-server.test.ts
```

Modules depend inward on strict runtime contracts. Harness runners cannot finalize; reviewers cannot execute; telemetry cannot mutate state; MCP tools cannot bypass domain services.

## 17. Testing strategy

Unit tests cover schemas, binding compatibility, risk routing, state transitions, command allowlists, diff policy, attestation verification, hashes, and failure classification.

Integration tests use fake `opencode`, `codex`, and validation binaries with controlled argv and outputs. Temporary Git repositories prove worktree isolation, branch naming, lock behavior, dirty active-worktree preservation, final tree equality, and broker-only commit ownership.

Security tests prove rejection of:

- path traversal, symlink escape, alternate data streams, and case-folding collisions;
- shell metacharacters or caller-defined commands;
- changes outside `allowed_files`;
- worker commit/push/deploy/network attempts;
- forged or stale review attestations;
- mismatched diff, validation, tree, policy, or profile hashes;
- duplicated run IDs and concurrent runs in one repository;
- secret-bearing keys and unbounded logs in artifacts or telemetry;
- broker unavailability followed by a direct-write fallback.

End-to-end live-provider probes are opt-in and never part of default CI. CI uses fake harnesses, runs `npm run validate`, and requires public JSON Schema/runtime-loader parity.

## 18. Acceptance criteria

V4 is complete only when tests prove:

- one normal Codex task can activate the broker without user-directed delegation steps;
- the primary Sol agent remains read-only and a broker failure cannot fall back to direct editing;
- role bindings include harness and incompatible combinations fail compilation;
- only verified capability bindings can execute;
- every run uses a unique clean worktree and `codex/auto/<run-id>` branch;
- the user's active worktree is never reset, cleaned, stashed, modified, or committed;
- OpenCode runs with fail-closed permissions and cannot commit, push, deploy, browse, or escape its worktree;
- contract path and validation allowlists are enforced after every attempt;
- MiMo, MiMo repair, and GLM escalation follow the exact bounded state machine;
- high-risk work bypasses economy execution and uses the frontier route;
- deterministic validation failure prevents acceptance and commit;
- every Sol review has a fresh session and receives only the allowed evidence envelope;
- forged, stale, or mismatched attestations fail closed;
- the broker commits only the exact accepted tree and never pushes it;
- failed and rejected runs retain typed status and auditable artifacts without a commit;
- V4 telemetry is append-only and cannot influence runtime success;
- V2 and V3 tests and public contracts remain unchanged and green;
- `npm run validate` passes on Node 20 or later.

## 19. Deferred work

After V4 is validated in the starter repository:

- add non-destructive managed-block or fragment integration for existing `AGENTS.md` files such as ESData's;
- install the project-scoped MCP server and policy in ESData as development tooling only;
- import V4 telemetry into real V3 pilot blocks and evaluate routing evidence;
- consider additional model bindings only after capability probes and paired benchmark evidence;
- add optional branch publication or PR workflows as a separately authorized version;
- add explicit cleanup commands for retained failed-run worktrees and artifacts.

## 20. Source notes

- Codex supports local STDIO MCP servers, project-scoped MCP configuration for trusted projects, and server instructions: https://developers.openai.com/codex/mcp
- OpenCode headless execution and CLI options: https://dev.opencode.ai/docs/cli/
- OpenCode custom OpenAI-compatible providers: https://opencode.ai/docs/providers/
- OpenCode granular permissions and `--auto` behavior: https://opencode.ai/docs/permissions
- ArliAI OpenAI-compatible chat, structured output, and tool parameters: https://www.arliai.com/docs/api

