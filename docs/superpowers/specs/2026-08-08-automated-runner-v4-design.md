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
- a short-lived local STDIO MCP adapter backed by a durable local broker daemon;
- repository allowlisting and one active run lock per repository;
- isolated Git worktrees and `codex/auto/<run-id>` branches;
- frozen base SHA, contract hash, diff hash, and final tree hash;
- mandatory OS-enforced process sandboxes for executors, validation, and review;
- broker-built executor capsules that prevent harness configuration discovery from repositories;
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

The starter core, public contracts, runtime profiles, examples, and tests are repository-agnostic. A concrete project is a consumer configured through a separate repository policy; no consumer identity or domain rule is part of the canonical runtime profile.

## 4. Trust boundaries

MCP is the control plane, not the security boundary. A durable local broker daemon is the security boundary and state owner. The project-scoped STDIO process is a thin, stateless adapter over authenticated local IPC. It does not execute models, validations, Git mutations, or long-running work itself. The daemon must assume that every MCP field and every model-produced value is untrusted input.

The broker exposes only these domain operations:

```text
run_coding_task(task_request)
repair_coding_task(run_id, findings)
finalize_coding_task(run_id)
abort_coding_task(run_id)
get_coding_task_status(run_id)
```

It must never expose generic equivalents of:

```text
run_shell(command)
write_file(path, content)
git(command)
```

`run_coding_task` accepts a caller-generated `request_id` for idempotency. The daemon generates `run_id`. Replaying the same canonical request returns the existing run; reusing `request_id` with different content fails. Review attestations are generated and stored by the daemon, never accepted as authoritative MCP input.

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

Four additional boundaries are normative:

- `ProcessSandbox`: an OS-enforced launcher for any process that handles repository-controlled content;
- `ExecutorCapsule`: a broker-owned launch root for economy and frontier executors, with the isolated worktree exposed only as `repo/`;
- `ReviewCapsule`: a filesystem view containing only the bounded review envelope, never the worktree;
- `GitObjectWriter`: a hook-free, filter-free path that writes the accepted tree and updates only the task ref.

OpenCode permissions, Codex read-only mode, exact argv validation, sanitized environment variables, and post-execution diff checks are defense in depth. None substitutes for `ProcessSandbox`. If the selected host cannot prove filesystem, process-tree, environment, and network enforcement for the required sandbox profile, the run fails with `PROCESS_SANDBOX_UNAVAILABLE` before any model or repository-controlled process starts.

The implementation plan selects the first concrete `ProcessSandboxBackend` and must prove it with hostile fixtures. Other operating systems/backends begin explicitly unsupported and return `PROCESS_SANDBOX_UNAVAILABLE`; V4 does not claim portable security before each backend passes the same contract tests.

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
id: arliai-opencode-pro
bindings:
  orchestrator:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-planning
    allowedDataScopes: [SOURCE_CODE_ONLY]
    allowedSourceSensitivity: [PUBLIC, PRIVATE]
    permissions: read-only

  executor:
    harness: opencode
    provider: arliai
    model: MiMo-V2.5
    capability: economy-coding
    allowedDataScopes: [SOURCE_CODE_ONLY]
    allowedSourceSensitivity: [PUBLIC]
    permissions: contract-write

  escalationExecutor:
    harness: opencode
    provider: arliai
    model: GLM-4.7
    capability: strong-economy-coding
    allowedDataScopes: [SOURCE_CODE_ONLY]
    allowedSourceSensitivity: [PUBLIC]
    permissions: contract-write

  frontierExecutor:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-coding
    allowedDataScopes: [SOURCE_CODE_ONLY]
    allowedSourceSensitivity: [PUBLIC, PRIVATE]
    permissions: contract-write

  reviewer:
    harness: codex
    provider: openai
    model: gpt-5.6-sol
    capability: frontier-review
    allowedDataScopes: [SOURCE_CODE_ONLY]
    allowedSourceSensitivity: [PUBLIC, PRIVATE]
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
harness_version
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
allowed_data_scopes[]
allowed_source_sensitivity[]
probe_version
agent_policy_hash
broker_version
probed_at
expires_at
probe_evidence_hash
status: VERIFIED | FAILED | STALE | UNPROBED
```

Model descriptions do not satisfy a capability requirement. `doctor --probe-runtime` performs bounded probes in a disposable fixture repository and records content-addressed evidence. A runtime binding must be `VERIFIED` under the exact profile hash, harness version, agent-policy hash, broker version, probe version, and unexpired TTL. Any identity change, expiry, stale result, or failed probe stops execution. Runtime auto-update is disabled so a binding cannot change after probing.

Initial required probes are:

- MiMo: structured result, bounded edit, multi-step file-tool use, and one repair from broker-supplied failed-validation evidence without invoking a shell;
- GLM-4.7: the same executor capabilities;
- Sol reviewer: strict review-attestation output and read-only behavior;
- Sol frontier executor: bounded capsule edit, command containment, and credential separation.

Gemma may later register image/document capabilities, but it is explicitly ineligible for the executor binding until a separate tool-calling probe passes.

## 7. Runtime contracts

### 7.1 Task request and effective work contract V4

`runtime-task-request-v4.schema.json` is the strict, untrusted MCP input:

```text
schema_version = 4
task_id
request_id
repository_id
objective
task_class
requested_risk_class
requested_route: AUTO | ECONOMY | FRONTIER
allowed_changes[]
allowed_validation_ids[]
inputs[]
constraints[]
success_criteria[]
max_files_changed
max_changed_lines
max_attempts
prohibited_actions[]
result_schema_version
```

Each `allowed_changes` entry is a normalized, repository-relative exact path plus an operation allowlist drawn from `CREATE | MODIFY | DELETE`. Globs, absolute paths, empty segments, `.`/`..`, ADS syntax, and platform-ambiguous spellings are forbidden. Before launching a model, the broker canonicalizes the full existing parent chain and rejects symlinks, junctions, mount crossings, reparse points, case-folding collisions, and alternate data streams. A read-only discovery phase may propose exact paths, but the daemon must freeze them before granting any write capability.

Caller-supplied shell fragments, environment values, credentials, remote URLs, commands, `run_id`, effective classification, hashes, and final route are forbidden. Validation IDs resolve through repository policy to exact argv arrays maintained by the project owner.

After validating the request, the daemon derives and freezes `runtime-work-contract-v4.schema.json`:

```text
schema_version = 4
task_id
request_id
run_id
repository_id
repository_root_hash
base_sha
objective
task_class
requested_risk_class
effective_risk_class
requested_route
effective_route
route_decision_reasons[]
route_decision_hash
effective_data_scope = SOURCE_CODE_ONLY
effective_source_sensitivity: PUBLIC | PRIVATE
allowed_changes[]
allowed_validation_ids[]
inputs[]
constraints[]
success_criteria[]
max_files_changed
max_changed_lines
max_attempts
sandbox_profile_hashes
prohibited_actions[]
result_schema_version
policy_hash
profile_hash
contract_hash
```

The repository policy supplies data scope and source sensitivity; neither is caller- or model-selectable. V4 accepts only `SOURCE_CODE_ONLY`. `PUBLIC` means the repository policy permits the selected source to leave the host under the configured provider terms. `PRIVATE` means the source is non-public even when it contains no real-world records or secrets. A binding may execute only when both effective dimensions appear in its allowlists.

The initial ArliAI economy bindings accept `SOURCE_CODE_ONLY + PUBLIC` only. Sending private source to ArliAI requires a future explicit profile opt-in plus policy authorization and new probe evidence. A private repository therefore routes to a compatible frontier binding when policy allows it, or fails with `SOURCE_SENSITIVITY_UNSUPPORTED`; it is never silently reclassified as public.

The repository policy may mark paths, task classes, validations, risk levels, or source sensitivities as `frontier_only`. Policy resolution is monotonic: the daemon may elevate `AUTO` or `ECONOMY` to `FRONTIER`, but can never downgrade a caller-requested or policy-required frontier route. The model cannot select its effective route, data scope, or source sensitivity.

### 7.2 Runtime result V4

`runtime-result-v4.schema.json` contains bounded evidence only:

```text
run_id
request_id
state
effective_route
route_decision_hash
effective_data_scope
effective_source_sensitivity
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
decision: REQUEST_CONTEXT | ACCEPT | REJECT
findings[]
requested_context_hashes[]
unresolved_finding_ids[]
created_at
attestation_hash
```

`REQUEST_CONTEXT` is not an acceptance or rejection and is legal only for the first bounded review round. An acceptance is invalid when any material finding remains unresolved, context requests remain open, or any referenced hash differs from current broker state.

### 7.4 Repository policy V4

`runtime-repository-policy-v4.schema.json` is the public, repository-specific contract. It is independent from runtime profiles and contains no provider credentials or concrete model selection:

```yaml
schemaVersion: 4
repositoryId: my-project

base:
  allowedBranches: [main]

worktrees:
  parentRef: broker-managed-worktrees

routing:
  frontierOnly:
    riskClasses: [security, architecture]
    taskClasses: []
    paths: []
    sourceSensitivity: [PRIVATE]

validation:
  test:
    argv: [npm, test]
    workingDirectory: .
    timeoutSeconds: 300
    sandboxProfile: validation-default

sourcePolicy:
  dataScope: SOURCE_CODE_ONLY
  sourceSensitivity: PUBLIC

sandbox:
  requiredBackend: auto
  requiredProfiles:
    - executor-networked
    - frontier-networked
    - validation-untrusted
    - review-capsule

instructions:
  approvedSources:
    - AGENTS.md
```

Runtime profiles answer *which verified harness/model may fill a role*. Repository policies answer *what one repository permits*. Core V3/V4 code consumes both strict contracts but contains neither project identity nor project-specific commands.

The local repository registry independently maps `repositoryId` to a canonical root, a repository-policy reference, and an installed runtime-profile reference; neither public contract embeds the other. It also resolves machine-local references such as `worktrees.parentRef`. The policy is owner-approved, content-addressed, frozen before executor launch, and excluded from allowed changes. A policy stored inside a repository is read only from the frozen base tree; an executor modification cannot affect the current run.

Instruction sources are normalized exact repository-relative paths subject to byte and count limits. The broker copies only approved sources from the frozen base tree into a broker-owned instruction bundle, records their hashes, and supplies that bundle explicitly. Instruction content may guide implementation but cannot expand paths, tools, routing, network, validation, or sandbox permissions. Repository `AGENTS.md`, `CLAUDE.md`, and harness-specific directories are never discovered automatically.

## 8. Repository and worktree lifecycle

The repository registry is local configuration owned by the user, not model input. Each entry defines the canonical root and maps a repository policy plus machine-local storage references. Allowed base branches, validation commands, routing, source policy, approved instructions, ignored volatile paths, and sandbox requirements come from the frozen `runtime-repository-policy-v4` instance.

For every new run the broker:

1. validates idempotency and generates `run_id` inside the daemon;
2. obtains an exclusive repository lock;
3. resolves policy, derives the effective route, and freezes the current permitted base SHA;
4. validates every exact allowed path and its parent chain before execution;
5. creates `codex/auto/<run-id>` and an isolated worktree under the configured worktree parent;
6. verifies the clean tree hash and records isolation evidence;
7. writes immutable run metadata outside model-editable paths;
8. proves the required process-sandbox profiles are available;
9. builds an `ExecutorCapsule` and launches the selected executor from its broker-owned root, with the worktree mounted only at `repo/`;
10. revalidates paths, diff, tree, and policy after every executor attempt;
11. retains the worktree and artifacts on rejection or failure for inspection;
12. creates a commit only after accepted review and final hash reproduction.

The broker never checks out, resets, cleans, stashes, merges, or commits in the user's active worktree. The resulting commit remains on the task branch. Push and merge are outside V4.

Run artifacts are append-only under a broker-owned state directory. Model workers cannot edit run state or attestations.

On Unix, the broker state directory and every existing component in its parent chain are a physical security boundary. The broker walks the chain without following links and rejects any symbolic link, junction-like/reparse alias, ambiguous component, ownership mismatch, or component whose stable physical identity cannot be proven. The validated physical identity, never `resolve()` or another textual path, binds endpoint coordination and every create, replace, connect, listen, cleanup, and unlink operation. Validation occurs before any socket side effect. Sensitive operations remain protected against replacement after validation by the certified cross-process coordinator plus exact identity checks inside its critical section; a pre-operation scan alone is not sufficient. Any alias or identity change fails closed without touching the legitimate socket.

## 9. Executor capsule and OpenCode worker execution

Both economy executors and the Sol frontier executor run from a newly built `ExecutorCapsule`:

```text
ExecutorCapsule/
  config/          broker-owned harness configuration
  agent/           broker-owned agent definition
  instructions/    approved, hashed instruction bundle
  home/            synthetic HOME/USERPROFILE
  cache/           synthetic cache
  tmp/             synthetic temporary directory
  repo/            isolated worktree mount and only editable source tree
```

The harness working directory is the capsule root, never `repo/` or an ancestor of the real worktree. Repository `opencode.json`, `.opencode/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, Codex rules, plugins, tools, agents, commands, skills, and LSP definitions are therefore data inside `repo/`, not automatically discovered harness configuration. The OS sandbox exposes no user-global or system-managed harness configuration. Capability probes inspect the resolved effective configuration and fail if any unapproved source was merged.

The broker uses headless OpenCode with capsule root as `--dir`, explicit agent, model, JSON output, `--pure`, and automatic permission handling. The exact CLI argv is constructed internally; no CLI fragments come from the model or work contract. OpenCode is pinned to the probed version. Its broker-owned config directory, complete effective config, executable hash, provider endpoint, and agent policy are part of the binding identity.

The generated worker agent starts from a wildcard deny and adds only the minimum positive file tools:

```text
*: deny
read: allow only repository files approved by read policy
glob: allow only within the isolated worktree
grep: allow only within the isolated worktree
edit: allow only exact paths and operations in allowed_changes
```

All current and future tools not explicitly opened remain denied, including `bash`, `task`, `skill`, `lsp`, `question`, `webfetch`, `websearch`, MCP tools, and external directories. The worker receives no Git command capability; diffs, status, and prior findings are supplied by the broker. `--auto` may be used only with this deny-all policy and never changes an explicit deny.

The broker-owned OpenCode configuration sets `share: "disabled"`, `autoupdate: false`, and `enabled_providers: ["arliai"]`. The launch environment also disables auto-update, default plugins, LSP downloads, model-list fetching, and Claude compatibility using flags supported by the pinned harness. It points `OPENCODE_CONFIG_DIR` at immutable capsule configuration and uses `--pure`. Capability probes must prove the effective configuration, exact provider allowlist, and absence of project/global/managed config, plugins, custom tools, agents, rules, and skills; unrecognized or ineffective isolation controls invalidate the binding.

Always prohibited to the worker:

- all Git commands and APIs;
- deploy CLIs, `ssh`, `scp`, `curl`, and arbitrary network tools;
- Docker lifecycle commands unless a future explicit policy adds an exact validation ID;
- access outside the isolated worktree;
- project `.env` files, credential stores, production fixtures, and real data;
- modifying broker state, attestations, inventory, or runtime policy.

OpenCode runs inside an `EXECUTOR_NETWORKED` process sandbox whose filesystem view is the `ExecutorCapsule`. It cannot see the active repository, original worktree path, host credential stores, broker state, global/managed OpenCode directories, or arbitrary host files. It reaches only a per-run broker-owned ArliAI gateway on an internal sandbox network. The gateway receives the real ArliAI credential through the platform credential adapter, injects authentication when it creates the outbound TLS request, and never mounts repository or capsule content. OpenCode receives no ArliAI credential in configuration, environment, files, argv, or inherited process state; a fixed non-secret local gateway token may be used only if the pinned harness requires an API-key-shaped value. The gateway strips any inbound authorization, permits only the configured ArliAI origin plus approved methods and API paths, rejects redirects and alternate destinations, and records metadata without bodies. If this separation cannot be demonstrated on the host, the binding is unavailable.

Repository-controlled lifecycle hooks, plugins, language servers, package installers, shells, and binaries never run in the executor sandbox. All code execution happens later through registered validation in the credential-free sandbox.

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

High-risk, restricted, security, architecture, ambiguous debugging, and cross-cutting work routes directly to the Sol frontier executor in an isolated worktree. The complete initial frontier state machine is exactly `frontier execution -> deterministic validation -> fresh Sol review -> ACCEPT and finalize | terminal REJECT`. V4 performs no automatic frontier repair after rejection. It never uses MiMo merely to satisfy an "economy first" rule.

The frontier executor uses the same `ExecutorCapsule` layout under a separate `FRONTIER_NETWORKED` sandbox profile. Codex starts at the capsule root with user/project config and automatic rules disabled; `repo/` is its only editable source mount, and approved project instructions arrive only through the broker-owned bundle. The trusted Codex harness may use saved CLI authentication and reach only the configured OpenAI endpoint; model-invoked commands receive no credential and have no network. Any command capability is further restricted by repository policy and the same exact allowed-change contract. Lack of capsule isolation, credential separation, or OS containment makes the frontier binding unavailable.

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

Each review is a new Codex/Sol session whose identifier differs from every executor and previous reviewer session. It runs in a physical `ReviewCapsule`, not in or above the worktree. The capsule is a newly created temporary directory and filesystem view containing only:

- WorkContract V4;
- frozen base SHA;
- current complete diff and changed-file list;
- deterministic validation results and their hashes;
- unresolved findings from the immediately preceding review;
- bounded file context explicitly requested by the reviewer.

The reviewer never receives the worktree path or mount, planner reasoning, executor reasoning, executor transcript, hidden tool traces, or a prior verdict. The capsule uses immutable content-addressed files and a manifest covering every visible byte. The review process has a synthetic working directory, environment, and temp directory; no repository, user config, project rules, broker state, or provider credentials are visible to model-invoked tools.

The broker invokes the pinned Codex harness using the equivalent of:

```text
codex exec
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --sandbox read-only
  --skip-git-repo-check
  --output-schema review-attestation-v4.schema.json
  --json
  --cd <review-capsule>
```

Saved Codex CLI authentication may be consumed only by the trusted harness process through the platform credential adapter. It is not copied into the capsule or inherited by model-invoked processes. The `REVIEW_CAPSULE` process-sandbox profile allows the trusted harness to reach the configured OpenAI endpoint while denying network and host filesystem access to its tools. A host that cannot enforce this separation fails with `REVIEW_SANDBOX_UNAVAILABLE`.

Additional context uses at most one bounded expansion round. The first attestation may return content-addressed path requests instead of a verdict. The broker validates each exact path against review policy, rebuilds a new capsule containing only the approved additions, and starts another fresh ephemeral session. No general filesystem or MCP access is exposed to the reviewer.

The existing generated reviewer contract remains the semantic foundation. V4 adds the strict attestation and runtime hash checks; it does not create a weaker second review mechanism.

## 12. Validation and finalization

Validation commands are registered as exact argv arrays, working directories, timeouts, resource ceilings, and output budgets. They are never parsed through a shell. Registration controls only what may start; it is not treated as containment.

Every validation runs in a `VALIDATION_UNTRUSTED` process sandbox with:

- no OpenAI, ArliAI, Git, cloud, package-registry, SSH, or user credentials;
- synthetic empty `HOME`, `USERPROFILE`, config, cache, and temp roots;
- only the task worktree and dedicated scratch/output paths mounted;
- outbound and inbound network denied at the OS boundary;
- an allowlisted initial executable plus a contained descendant process tree;
- CPU, memory, process-count, file-size, and wall-clock ceilings;
- termination of the complete process tree on timeout, abort, or broker exit;
- no access to the active worktree, broker IPC, host Git config, credential helpers, agents, or unrelated host files.

Dependencies required by a validation must be provisioned before the run from trusted, pinned inputs. Repository-controlled install or lifecycle scripts cannot fetch them during validation. A validation whose sandbox requirements cannot be represented is ineligible and fails before execution with `PROCESS_SANDBOX_UNAVAILABLE`. Each result records the sandbox backend and policy hash, command ID, executable hash, exit code, resource usage, duration, truncated-output hash, full local artifact hash, and the tree hash validated.

Finalization is a compare-and-commit transaction:

1. acquire the run and repository locks;
2. reproduce contract, policy, profile, diff, validation, review, and tree hashes;
3. verify every mandatory validation passed against the current tree;
4. verify the latest attestation accepts that exact tree;
5. verify no prohibited or out-of-scope path changed;
6. write blobs and trees from the accepted bytes through `GitObjectWriter`, bypassing working-tree filters, smudge/clean drivers, user configuration, aliases, and hooks;
7. create the commit object through hook-free Git plumbing with task ID and evidence manifest hash;
8. atomically compare-and-update only `refs/heads/codex/auto/<run-id>` from the expected old object ID;
9. verify the committed tree object equals the accepted tree hash;
10. persist terminal state and release locks.

No porcelain `git commit` is executed. Repository or user hooks are never invoked during finalization. Hooks that the owner wants enforced must be registered as validations and run earlier inside `VALIDATION_UNTRUSTED`. `GitObjectWriter` must use an audited library or explicit plumbing that neither consults executable filters nor materializes unreviewed bytes. Any inability to prove hook-free, filter-free object creation fails with `FINALIZATION_ISOLATION_FAILED` before the task ref changes.

## 13. Failure model and recovery

Every failure is typed:

```text
INVALID_CONTRACT
REPOSITORY_NOT_ALLOWED
REPOSITORY_BUSY
BROKER_STATE_CORRUPT
BASE_SHA_INVALID
WORKTREE_CREATION_FAILED
CAPABILITY_UNVERIFIED
SOURCE_SENSITIVITY_UNSUPPORTED
PROCESS_SANDBOX_UNAVAILABLE
REVIEW_SANDBOX_UNAVAILABLE
AUTHENTICATION_FAILED
PROVIDER_UNAVAILABLE
EXECUTOR_INVALID_OUTPUT
EXECUTOR_POLICY_VIOLATION
OUT_OF_SCOPE_CHANGE
VALIDATION_FAILED
REVIEW_REJECTED
REVIEW_ATTESTATION_INVALID
EVIDENCE_HASH_MISMATCH
FINALIZATION_ISOLATION_FAILED
FINALIZATION_FAILED
ABORTED
UNKNOWN_FAILURE
```

Failures append evidence, preserve the task branch/worktree when useful, and return a bounded status to Sol. The orchestrator reports the failure and stops. It must not edit the repository, relax policy, rerun with an unapproved model, or finalize manually.

`abort_coding_task` asks the durable daemon to terminate the sandbox job/process group, records `ABORTED`, and releases locks. It does not delete the worktree or branch automatically; cleanup is a separate explicit maintenance operation.

## 14. MCP server behavior

The project-scoped STDIO adapter returns concise instructions whose first section states:

- use `run_coding_task` for every source-code mutation request;
- do not write code in the primary Sol context;
- poll or resume the returned run rather than starting duplicates;
- stop on typed failure;
- never request finalization unless daemon status is `REVIEW_ACCEPTED`.

Tool schemas use strict JSON Schema and reject additional properties. Tool results are bounded summaries plus artifact hashes. Every MCP mutation is short: it validates the request with the daemon, durably appends the command, and returns `request_id`, broker-generated `run_id`, state, and status token. Model execution, validation, and review never run on the STDIO call stack.

`run_coding_task` enqueues the complete state machine. The daemon automatically advances execution, validation, review, permitted repair/escalation, and finalization without another user decision. `repair_coding_task` and `finalize_coding_task` are idempotent typed controls for orchestrator recovery and explicit state progression; they cannot override the daemon's persisted findings or gates. Any `findings` supplied to repair must be only IDs and hashes that exactly match the latest stored rejection.

The broker daemon owns an append-only journal plus transactional current-state store and communicates over an authenticated, user-local named pipe or Unix-domain socket with owner-only permissions. Unix endpoint creation additionally requires the link-free physical-path proof above; a textual alias is never an endpoint identity. It outlives individual STDIO clients. After daemon restart it reconciles journal state, sandbox process identity, worktree identity, and locks before accepting commands. Unknown process state fails closed; it is never assumed successful. Reconnecting with the same `request_id` returns the existing run. Thus "resumable" means resumable observation and control of daemon-owned state, not resumption of a dead STDIO process or model session.

The generated project `.codex/config.toml` marks the V4 MCP server `required = true`, sets an exact `enabled_tools` list to the five domain operations, uses no forwarded credential environment variables, fixes `cwd` to the canonical project root, uses an absolute canonical path to the installed runtime bundle, and sets bounded startup/tool timeouts appropriate to short control calls. Relative-path resolution and the caller's current directory cannot select the executable. If the adapter cannot initialize or authenticate to the daemon, Codex startup fails instead of continuing without orchestration.

The adapter and daemon accept only configured local repositories. A caller cannot register a new repository, alter validation commands, change provider credentials, choose `run_id`, set effective routing/classification, or expand permissions through MCP.

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
  request-idempotency.ts
  broker-daemon.ts
  broker-ipc.ts
  repository-registry.ts
  repository-policy.ts
  path-policy.ts
  worktree.ts
  executor-capsule.ts
  process-sandbox.ts
  process-policy.ts
  provider-egress-gateway.ts
  opencode-runner.ts
  codex-runner.ts
  validation.ts
  diff-policy.ts
  review-capsule.ts
  review-envelope.ts
  review-attestation.ts
  git-object-writer.ts
  finalize.ts
  telemetry.ts

src/mcp/
  stdio-adapter.ts
  tools.ts

contracts/
  runtime-profile-v4.schema.json
  runtime-task-request-v4.schema.json
  runtime-work-contract-v4.schema.json
  runtime-repository-policy-v4.schema.json
  runtime-result-v4.schema.json
  review-attestation-v4.schema.json

profiles/
  arliai-opencode.example.yaml

policies/
  repository-policy.example.yaml

tests/
  runtime-contracts.test.ts
  runtime-bindings.test.ts
  runtime-capabilities.test.ts
  runtime-routing.test.ts
  runtime-idempotency.test.ts
  runtime-broker-daemon.test.ts
  runtime-repository-policy.test.ts
  runtime-worktree.test.ts
  runtime-executor-capsule.test.ts
  runtime-path-policy.test.ts
  runtime-process-sandbox.test.ts
  runtime-process-policy.test.ts
  runtime-opencode.test.ts
  runtime-frontier.test.ts
  runtime-review-capsule.test.ts
  runtime-codex-review.test.ts
  runtime-validation.test.ts
  runtime-security.test.ts
  runtime-git-object-writer.test.ts
  runtime-finalize.test.ts
  runtime-telemetry.test.ts
  mcp-server.test.ts
```

Modules depend inward on strict runtime contracts. The STDIO adapter cannot execute work; harness runners cannot finalize; reviewers cannot see a worktree; telemetry cannot mutate state; MCP tools cannot bypass daemon domain services.

## 17. Testing strategy

Unit tests cover schemas, binding compatibility, risk routing, state transitions, command allowlists, diff policy, attestation verification, hashes, and failure classification.

Integration tests use fake `opencode`, `codex`, and validation binaries with controlled argv and outputs. Temporary Git repositories prove worktree isolation, branch naming, lock behavior, dirty active-worktree preservation, final tree equality, and broker-only commit ownership.

Sandbox integration tests run hostile fixture programs that attempt to enumerate host files, read synthetic and real credential locations, inherit secrets, start disallowed descendants, escape through links/reparse points, access loopback and Internet endpoints, survive timeout, and mutate outside mounted paths. A backend is accepted only when the operating system blocks the effects, not merely when telemetry detects the attempts.

Executor-capsule tests place hostile `opencode.json`, `.opencode/plugins`, `.opencode/tools/bash.ts`, `.opencode/agents`, `AGENTS.md`, `CLAUDE.md`, Codex rules, and global configuration fixtures inside and outside `repo/`. Fake and live diagnostic harnesses must prove none is loaded automatically, only broker-approved instruction hashes enter context, and only the profile provider is enabled.

Security tests prove rejection of:

- path traversal, symlink escape, alternate data streams, and case-folding collisions;
- shell metacharacters or caller-defined commands;
- changes or operation types outside exact `allowed_changes`;
- pre-launch symlink, junction, reparse-point, ADS, mount, or case-folding escapes;
- worker commit/push/deploy/network attempts;
- validation scripts that attempt credential access, network, host filesystem access, or surviving child processes;
- project/global OpenCode plugins, configuration, skills, LSP downloads, and auto-update;
- repository custom tools that shadow built-ins and automatic `AGENTS.md`/`CLAUDE.md` discovery;
- Codex review attempts to read the worktree or host files outside the capsule;
- forged or stale review attestations;
- mismatched diff, validation, tree, policy, or profile hashes;
- duplicated run IDs and concurrent runs in one repository;
- secret-bearing keys and unbounded logs in artifacts or telemetry;
- broker unavailability followed by a direct-write fallback;
- Git hooks, executable filters, user Git config, or non-task ref changes during finalization;
- duplicate MCP requests across STDIO disconnect and daemon restart.

End-to-end live-provider probes are opt-in and never part of default CI. CI uses fake harnesses, runs `npm run validate`, and requires public JSON Schema/runtime-loader parity.

## 18. Acceptance criteria

V4 is complete only when tests prove:

- one normal Codex task can activate the broker without user-directed delegation steps;
- the primary Sol agent remains read-only and a broker failure cannot fall back to direct editing;
- the project MCP is required, exposes only the exact five domain tools, and uses short daemon-backed calls;
- replaying one `request_id` cannot create a second run across reconnect or daemon restart;
- role bindings include harness and incompatible combinations fail compilation;
- runtime profiles contain only harness/model capabilities while strict repository policies contain project-specific routing, validation, source, sandbox, and instruction rules;
- only unexpired capability bindings matching exact harness, broker, profile, and policy versions can execute;
- every run uses a unique clean worktree and `codex/auto/<run-id>` branch;
- the user's active worktree is never reset, cleaned, stashed, modified, or committed;
- every repository-controlled process runs in a verified OS sandbox or the run fails before execution;
- executor and reviewer credentials are unavailable to model-invoked commands, tests, hooks, and repository code;
- validation has no network or host credentials and its whole descendant process tree is contained;
- OpenCode runs pinned with `--pure`, broker-owned config, wildcard-deny permissions, no shell/Git, no sharing/auto-update, and cannot escape its worktree;
- economy and frontier harnesses start from an `ExecutorCapsule`; repository/global config, tools, plugins, agents, skills, rules, and instructions are not auto-discovered;
- the OpenCode capsule enables only the profile provider and the ArliAI example enables only `arliai`;
- `SOURCE_CODE_ONLY` is separate from `PUBLIC | PRIVATE`; incompatible sensitivity fails or routes to an explicitly permitted binding without silent reclassification;
- exact path/operation and validation allowlists are enforced before and after every attempt;
- the daemon owns `run_id`, effective route, effective risk, data scope, and source sensitivity; routing can elevate but never downgrade frontier requirements;
- MiMo, MiMo repair, and GLM escalation follow the exact bounded state machine;
- high-risk work bypasses economy execution and follows the terminal frontier state machine without automatic repair;
- deterministic validation failure prevents acceptance and commit;
- every Sol review has a fresh ephemeral session inside a capsule where the worktree is not mounted or visible;
- forged, stale, or mismatched attestations fail closed;
- finalization invokes no hook/filter/user Git logic, atomically updates only the task ref, commits only the exact accepted tree, and never pushes it;
- failed and rejected runs retain typed status and auditable artifacts without a commit;
- V4 telemetry is append-only and cannot influence runtime success;
- V2 and V3 tests and public contracts remain unchanged and green;
- `npm run validate` passes on Node 20 or later.

## 19. Deferred work

After V4 is validated in the starter repository:

- add non-destructive installation helpers for arbitrary consumer repositories;
- generate repository-policy stubs and explicit approved-instruction imports for existing `AGENTS.md` files;
- install the project-scoped MCP adapter and policy in selected consumer repositories as development tooling only;
- import V4 telemetry into real V3 pilot blocks and evaluate routing evidence;
- consider additional model bindings only after capability probes and paired benchmark evidence;
- add optional branch publication or PR workflows as a separately authorized version;
- add explicit cleanup commands for retained failed-run worktrees and artifacts.

## 20. Source notes

- Codex supports local STDIO MCP servers, project-scoped configuration, server instructions, `required`, exact `enabled_tools`, and bounded tool timeouts: https://developers.openai.com/codex/mcp
- Codex non-interactive mode supports ephemeral sessions, read-only sandboxing, JSONL, output schemas, and saved CLI authentication; its security guidance forbids exposing API keys to repository-controlled code: https://learn.chatgpt.com/codex/non-interactive-mode
- OpenCode headless execution supports `--pure`, `--dir`, explicit model/agent selection, JSON, and `--auto`: https://opencode.ai/docs/cli/
- OpenCode custom OpenAI-compatible providers: https://opencode.ai/docs/providers/
- OpenCode permissions are permissive by default, support wildcard deny rules, and retain explicit denies under `--auto`: https://opencode.ai/docs/permissions
- OpenCode automatically loads global and project plugins unless isolated; `--pure` and sandbox enforcement are therefore required: https://opencode.ai/docs/plugins/
- OpenCode project custom tools may execute code and replace built-in tools with the same name: https://opencode.ai/docs/custom-tools/
- OpenCode automatically discovers project/global `AGENTS.md` and Claude-compatible rules from its working-directory ancestry: https://opencode.ai/docs/rules/
- OpenCode custom configuration directories and managed configuration precedence: https://opencode.ai/docs/config/
- ArliAI OpenAI-compatible chat, structured output, and tool parameters: https://www.arliai.com/docs/api
