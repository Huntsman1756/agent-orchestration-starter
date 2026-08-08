# Automated Runner V4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved V4 automatic coding runtime so a read-only Codex/Sol primary can enqueue a task, use a broker-selected isolated executor, validate and review the exact resulting tree, and create a local task-branch commit without push, merge, deploy, or direct-write fallback.

**Architecture:** Keep V4 in a new `src/runtime/` domain and expose only short typed operations through a thin STDIO MCP adapter backed by a durable local daemon. Every executor runs from an `ExecutorCapsule`, repository-controlled processes run through a certified `ProcessSandboxBackend`, review runs from a separate `ReviewCapsule`, and finalization uses hook-free Git plumbing over the accepted tree. Existing compiler/routing code and V2 contracts remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Zod 4, AJV 8, YAML 2, `node:test`, Node `fs/net/crypto/child_process`, Docker Engine Linux containers for the first sandbox backend, OpenCode 1.18.15, Codex CLI 0.147.0, and `@modelcontextprotocol/sdk` 1.30.0.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-08-08-automated-runner-v4-design.md` at approved commit `6514910` or a descendant containing only reviewed amendments.
- Keep V4 separate from `src/core/`, `src/routing/`, and the existing V2 schemas; do not reinterpret existing public inputs or CLI output.
- The repository currently contains the V3 specification and plan but no `src/pilot/` implementation. V4 must not invent or duplicate V3; Task 12 exposes a typed adapter port and keeps concrete V3 import disabled until the separate V3 plan is implemented.
- Node.js floor remains `>=20`; public JSON Schemas and strict Zod loaders must reject unknown properties and agree for every parity fixture.
- Stable repository policy contains no provider/model name. Concrete providers/models remain in `profiles/*.yaml`.
- ArliAI economy execution accepts only `SOURCE_CODE_ONLY + PUBLIC`. `PRIVATE` must route to an explicitly compatible frontier binding or fail with `SOURCE_SENSITIVITY_UNSUPPORTED`.
- No model or MCP caller may choose `run_id`, effective route, effective risk, data scope, source sensitivity, command argv, environment variables, credentials, repository root, or sandbox expansion.
- No source mutation outside exact normalized `allowed_changes`; operation kind is one of `CREATE`, `MODIFY`, or `DELETE`.
- No generic shell, Git, filesystem, provider, or repository-registration operation is exposed over MCP.
- No push, pull request, merge, deploy, SSH, publication, production database, real customer/fiscal data, or project secret handling.
- The primary Codex/Sol context remains read-only. Broker unavailability or any unknown state is a typed terminal failure, never a direct-edit fallback.
- First certified sandbox backend: Docker Engine with Linux containers, `seccomp`, cgroup namespaces, digest-pinned images, no Docker socket mount, dropped capabilities, `no-new-privileges`, non-root UID, read-only rootfs, bounded tmpfs/PIDs/CPU/memory, and either no network or a broker-owned allowlisting proxy.
- The trusted sandbox image is built from `node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0` and pins OpenCode `1.18.15` plus Codex CLI `0.147.0`. Runtime uses the resulting immutable local image ID, not the tag.
- A host/platform/profile without a fresh hostile-fixture certification returns `PROCESS_SANDBOX_UNAVAILABLE` before provider or repository-controlled execution.
- Live provider probes are opt-in and never run in default CI. Fake harnesses drive default integration tests.
- Every task follows red-green-refactor, ends with `npm run typecheck` plus its focused tests, and receives a fresh review gate before its commit.
- Run `npm run validate` and `git diff --check` before final completion. Deterministic failures are authoritative.

---

## File Map

| Area | Files | Responsibility |
|---|---|---|
| Contracts | `src/runtime/contracts.ts`, `src/runtime/failures.ts`, `src/runtime/contract-schemas.ts`, `src/runtime/load.ts`, `contracts/runtime-*.schema.json` | Strict public V4 vocabulary and failures, Zod loaders, JSON Schema parity |
| Policy/routing | `src/runtime/repository-registry.ts`, `repository-policy.ts`, `bindings.ts`, `routing.ts`, `path-policy.ts` | Resolve local registrations, freeze owner policy, resolve compatible bindings, derive effective route, reject unsafe paths |
| Durable control | `src/runtime/journal.ts`, `run-state.ts`, `request-idempotency.ts`, `broker-daemon.ts`, `broker-ipc.ts` | Hash-chained state, locks, recovery, idempotent local control |
| Sandbox | `src/runtime/process-sandbox.ts`, `docker-sandbox.ts`, `sandbox-egress-proxy.ts`, `infra/sandbox/Dockerfile` | OS-enforced execution, resource/network policy, hostile certification |
| Isolation | `src/runtime/worktree.ts`, `executor-capsule.ts`, `review-capsule.ts` | Task worktree and broker-owned executor/reviewer filesystem views |
| Harnesses | `src/runtime/opencode-runner.ts`, `codex-runner.ts`, `capabilities.ts`, `credential-adapter.ts` | Exact argv/env, structured outputs, binding probes and TTL |
| Gates | `src/runtime/validation.ts`, `diff-policy.ts`, `review-envelope.ts`, `review-attestation.ts` | Deterministic validation, scope checks, fresh independent review |
| Finalization | `src/runtime/git-object-writer.ts`, `finalize.ts` | Hook/filter-free object creation and atomic task-ref update |
| MCP | `src/mcp/stdio-adapter.ts`, `src/mcp/tools.ts`, `src/runtime/codex-project-config.ts` | Five typed domain tools and required project configuration |
| Evidence | `src/runtime/telemetry.ts`, `v3-telemetry-port.ts`, `artifact-store.ts` | Bounded append-only V4 events, content-addressed artifacts, optional V3 handoff |

---

### Task 1: Strict V4 contracts and JSON Schema/Zod parity

**Files:**

- Create: `src/runtime/contracts.ts`
- Create: `src/runtime/failures.ts`
- Create: `src/runtime/contract-schemas.ts`
- Create: `src/runtime/load.ts`
- Create: `contracts/runtime-profile-v4.schema.json`
- Create: `contracts/runtime-task-request-v4.schema.json`
- Create: `contracts/runtime-work-contract-v4.schema.json`
- Create: `contracts/runtime-repository-policy-v4.schema.json`
- Create: `contracts/runtime-result-v4.schema.json`
- Create: `contracts/review-attestation-v4.schema.json`
- Create: `tests/runtime-contracts.test.ts`
- Create: `tests/runtime-schema-parity.test.ts`

**Interfaces:**

```ts
export type DataScopeV4 = 'SOURCE_CODE_ONLY';
export type SourceSensitivityV4 = 'PUBLIC' | 'PRIVATE';
export type RequestedRouteV4 = 'AUTO' | 'ECONOMY' | 'FRONTIER';
export type EffectiveRouteV4 = 'ECONOMY' | 'FRONTIER';
export type ChangeOperationV4 = 'CREATE' | 'MODIFY' | 'DELETE';
export type ReviewDecisionV4 = 'REQUEST_CONTEXT' | 'ACCEPT' | 'REJECT';
export type RuntimeRoleV4 = 'orchestrator' | 'executor' | 'escalationExecutor' | 'frontierExecutor' | 'reviewer';
export type RuntimeFailureCodeV4 =
  | 'INVALID_CONTRACT'
  | 'REPOSITORY_NOT_ALLOWED'
  | 'REPOSITORY_BUSY'
  | 'BASE_SHA_INVALID'
  | 'WORKTREE_CREATION_FAILED'
  | 'CAPABILITY_UNVERIFIED'
  | 'SOURCE_SENSITIVITY_UNSUPPORTED'
  | 'PROCESS_SANDBOX_UNAVAILABLE'
  | 'REVIEW_SANDBOX_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'EXECUTOR_INVALID_OUTPUT'
  | 'EXECUTOR_POLICY_VIOLATION'
  | 'OUT_OF_SCOPE_CHANGE'
  | 'VALIDATION_FAILED'
  | 'REVIEW_REJECTED'
  | 'REVIEW_ATTESTATION_INVALID'
  | 'EVIDENCE_HASH_MISMATCH'
  | 'FINALIZATION_ISOLATION_FAILED'
  | 'FINALIZATION_FAILED'
  | 'ABORTED'
  | 'UNKNOWN_FAILURE';

export interface RuntimeFailureV4 {
  code: RuntimeFailureCodeV4;
  message: string;
  retryable: boolean;
  evidence_hashes: readonly string[];
}

export function loadRuntimeProfileV4(value: unknown): RuntimeProfileV4;
export function loadRuntimeTaskRequestV4(value: unknown): RuntimeTaskRequestV4;
export function loadRuntimeWorkContractV4(value: unknown): RuntimeWorkContractV4;
export function loadRuntimeRepositoryPolicyV4(value: unknown): RuntimeRepositoryPolicyV4;
export function loadRuntimeResultV4(value: unknown): RuntimeResultV4;
export function loadReviewAttestationV4(value: unknown): ReviewAttestationV4;
```

- [ ] **Step 1: Write minimal valid fixtures and failing loader tests**

```ts
const request = {
  schema_version: 4,
  task_id: 'TASK-1',
  request_id: 'req_01HZX3YH8C7Y9QJ4J6M2G5K8N1',
  repository_id: 'fixture-repo',
  objective: 'Change the greeting',
  task_class: 'mechanical-change',
  requested_risk_class: 'normal',
  requested_route: 'AUTO',
  allowed_changes: [{ path: 'src/greeting.ts', operations: ['MODIFY'] }],
  allowed_validation_ids: ['test'],
  inputs: [],
  constraints: [],
  success_criteria: ['fixture test passes'],
  max_files_changed: 1,
  max_changed_lines: 20,
  max_attempts: 3,
  prohibited_actions: ['push', 'deploy'],
  result_schema_version: 4,
};

assert.deepEqual(loadRuntimeTaskRequestV4(request), request);
assert.throws(() => loadRuntimeTaskRequestV4({ ...request, run_id: 'caller-owned' }), /unrecognized|run_id/i);
```

- [ ] **Step 2: Run the focused tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-contracts.test.ts tests/runtime-schema-parity.test.ts`

Expected: FAIL because `src/runtime/load.ts` and the public schemas do not exist.

- [ ] **Step 3: Implement the exact TypeScript vocabulary and strict Zod schemas**

```ts
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const allowedChangeSchema = z.object({
  path: z.string().min(1),
  operations: z.array(z.enum(['CREATE', 'MODIFY', 'DELETE'])).min(1),
}).strict();

export const runtimeTaskRequestV4Schema = z.object({
  schema_version: z.literal(4),
  task_id: z.string().min(1).max(128),
  request_id: z.string().regex(/^req_[A-Za-z0-9_-]{16,96}$/),
  repository_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  objective: z.string().min(1).max(4_000),
  task_class: z.string().min(1).max(128),
  requested_risk_class: z.string().min(1).max(128),
  requested_route: z.enum(['AUTO', 'ECONOMY', 'FRONTIER']),
  allowed_changes: z.array(allowedChangeSchema).min(1).max(256),
  allowed_validation_ids: z.array(z.string().min(1).max(128)).min(1).max(64),
  inputs: z.array(z.string().max(2_000)).max(64),
  constraints: z.array(z.string().max(2_000)).max(64),
  success_criteria: z.array(z.string().max(2_000)).min(1).max(64),
  max_files_changed: z.number().int().positive().max(256),
  max_changed_lines: z.number().int().positive().max(100_000),
  max_attempts: z.number().int().min(1).max(3),
  prohibited_actions: z.array(z.string().min(1).max(128)).max(64),
  result_schema_version: z.literal(4),
}).strict();
```

Implement all six loaders with `schema.parse(value)` and convert `ZodError` into `Runtime contract validation failed: ...` without logging the rejected document. Define the failure-code union once in `failures.ts`; contract and result types import it instead of repeating strings.

- [ ] **Step 4: Add matching draft-2020-12 JSON Schemas and mutation parity cases**

The mutation table must independently cover unknown keys, caller-owned `run_id`, caller-owned effective fields, malformed hashes, invalid route, duplicate operations, empty validation lists, profile/repository-policy mixing, `PRIVATE` misspelling, an unapproved failure code, and attestation acceptance with unresolved findings.

```ts
for (const mutate of invalidMutations) {
  const candidate = mutate(structuredClone(validDocument));
  assert.equal(ajvValidator(candidate), false);
  assert.throws(() => zodLoader(candidate));
}
```

- [ ] **Step 5: Run Task 1 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-contracts.test.ts tests/runtime-schema-parity.test.ts`

Run: `npm run typecheck`

Expected: all Task 1 tests PASS; TypeScript exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/runtime/contracts.ts src/runtime/failures.ts src/runtime/contract-schemas.ts src/runtime/load.ts contracts/runtime-*.schema.json contracts/review-attestation-v4.schema.json tests/runtime-contracts.test.ts tests/runtime-schema-parity.test.ts
git commit -m "feat(runtime): add strict v4 contracts"
```

---

### Task 2: Repository policy, bindings, routing, and pre-launch path safety

**Files:**

- Create: `src/runtime/canonical.ts`
- Create: `src/runtime/repository-registry.ts`
- Create: `src/runtime/repository-policy.ts`
- Create: `src/runtime/bindings.ts`
- Create: `src/runtime/routing.ts`
- Create: `src/runtime/path-policy.ts`
- Create: `profiles/arliai-opencode.example.yaml`
- Create: `policies/repository-policy.example.yaml`
- Create: `tests/runtime-repository-policy.test.ts`
- Create: `tests/runtime-repository-registry.test.ts`
- Create: `tests/runtime-bindings.test.ts`
- Create: `tests/runtime-routing.test.ts`
- Create: `tests/runtime-path-policy.test.ts`

**Interfaces:**

```ts
export function canonicalJsonV4(value: unknown): string;
export function hashCanonicalV4(value: unknown): string;
export function loadRepositoryRegistration(repositoryId: string, registry: RepositoryRegistryV4): RegisteredRepositoryV4;
export function freezeRepositoryPolicy(input: RuntimeRepositoryPolicyV4): FrozenRepositoryPolicyV4;
export function resolveBinding(input: BindingResolutionInputV4): ResolvedBindingV4;
export function deriveWorkContract(input: DeriveWorkContractInputV4): RuntimeWorkContractV4;
export async function inspectAllowedChanges(input: PathInspectionInputV4): Promise<readonly InspectedChangeV4[]>;
```

- [ ] **Step 1: Write failing separation and routing tests**

```ts
assert.equal(profile.bindings.executor.model, 'MiMo-V2.5');
assert.equal('model' in repositoryPolicy, false);
assert.equal(loadRepositoryRegistration('fixture-repo', registry).canonical_root, fixtureRoot);
assert.throws(() => loadRepositoryRegistration('missing-repo', registry), /REPOSITORY_NOT_ALLOWED/);
assert.equal(deriveWorkContract(publicNormal).effective_route, 'ECONOMY');
assert.equal(deriveWorkContract(privateNormal).effective_route, 'FRONTIER');
assert.throws(() => deriveWorkContract(privateWithoutCompatibleBinding), /SOURCE_SENSITIVITY_UNSUPPORTED/);
assert.equal(deriveWorkContract(requestedFrontier).effective_route, 'FRONTIER');
```

- [ ] **Step 2: Run Task 2 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-repository-registry.test.ts tests/runtime-repository-policy.test.ts tests/runtime-bindings.test.ts tests/runtime-routing.test.ts tests/runtime-path-policy.test.ts`

Expected: FAIL because registry lookup, policy freezing, binding resolution, routing, and path inspection are absent.

- [ ] **Step 3: Implement canonical hashing, frozen policy, and monotonic routing**

```ts
const requestedRank = { AUTO: 0, ECONOMY: 1, FRONTIER: 2 } as const;

export function effectiveRoute(requested: RequestedRouteV4, policyRequiresFrontier: boolean): EffectiveRouteV4 {
  if (requestedRank[requested] === 2 || policyRequiresFrontier) return 'FRONTIER';
  return 'ECONOMY';
}
```

The broker reads the user-owned local registry, canonicalizes the registered repository root, and resolves only policy/profile/worktree/state references from that entry. The task request cannot override any registration field. `deriveWorkContract` receives the daemon-generated `run_id`, freezes base/profile/policy/sandbox hashes, and includes ordered `route_decision_reasons`.

- [ ] **Step 4: Implement exact path normalization and pre-launch filesystem inspection**

```ts
export interface PathInspectionInputV4 {
  repositoryRoot: string;
  changes: readonly AllowedChangeV4[];
  platform: NodeJS.Platform;
}

export interface InspectedChangeV4 extends AllowedChangeV4 {
  canonical_parent: string;
  existed_at_freeze: boolean;
}
```

Reject absolute paths, `.`/`..`, empty segments, NUL, Windows ADS colons, reserved Windows names, trailing dot/space, case-fold collisions, symlink/junction/reparse resolution changes, parent device/mount changes, and any canonical parent outside the repository root. Perform this inspection before worktree or model launch and again after each attempt.

- [ ] **Step 5: Add real temporary-filesystem escape tests**

Create a repository fixture containing a normal file, a directory symlink/junction to an external sentinel, two case-colliding requested paths, an ADS-shaped name, and a missing file below a symlinked parent. Each unsafe request must fail before the injected executor spy is called.

- [ ] **Step 6: Add generic example profile and repository policy**

The profile contains Sol/MiMo/GLM concrete bindings and `allowedSourceSensitivity`; the repository policy contains only branches, routing classes/paths, exact validation argv, source policy, sandbox requirements, and approved instruction sources. Assert `rg -i "esdata" profiles policies contracts src/runtime` returns no match.

- [ ] **Step 7: Run Task 2 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-repository-registry.test.ts tests/runtime-repository-policy.test.ts tests/runtime-bindings.test.ts tests/runtime-routing.test.ts tests/runtime-path-policy.test.ts`

Run: `npm run typecheck`

Expected: all Task 2 tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/runtime/canonical.ts src/runtime/repository-registry.ts src/runtime/repository-policy.ts src/runtime/bindings.ts src/runtime/routing.ts src/runtime/path-policy.ts profiles/arliai-opencode.example.yaml policies/repository-policy.example.yaml tests/runtime-repository-registry.test.ts tests/runtime-repository-policy.test.ts tests/runtime-bindings.test.ts tests/runtime-routing.test.ts tests/runtime-path-policy.test.ts
git commit -m "feat(runtime): resolve repository policy and routing"
```

---

### Task 3: Durable daemon, hash-chained journal, locks, and request idempotency

**Files:**

- Create: `src/runtime/journal.ts`
- Create: `src/runtime/run-state.ts`
- Create: `src/runtime/request-idempotency.ts`
- Create: `src/runtime/repository-lock.ts`
- Create: `src/runtime/broker-daemon.ts`
- Create: `src/runtime/broker-ipc.ts`
- Create: `tests/runtime-journal.test.ts`
- Create: `tests/runtime-run-state.test.ts`
- Create: `tests/runtime-idempotency.test.ts`
- Create: `tests/runtime-broker-daemon.test.ts`
- Create: `tests/runtime-broker-ipc.test.ts`

**Interfaces:**

```ts
export interface JournalRecordV4 {
  sequence: number;
  previous_hash: string | null;
  command: BrokerCommandV4;
  recorded_at: string;
  record_hash: string;
}

export interface BrokerDaemonV4 {
  submit(command: BrokerCommandV4): Promise<BrokerReplyV4>;
  status(runId: string): Promise<RuntimeResultV4>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export function createBrokerDaemon(deps: BrokerDaemonDependenciesV4): BrokerDaemonV4;
export function createBrokerIpcServer(deps: BrokerIpcDependenciesV4): Promise<BrokerIpcServerV4>;
export function createBrokerIpcClient(config: BrokerIpcClientConfigV4): BrokerIpcClientV4;
```

- [ ] **Step 1: Write failing journal and replay tests**

```ts
await journal.append(commandA);
await journal.append(commandB);
const recovered = await reopenJournal(directory);
assert.deepEqual(recovered.records.map((record) => record.command), [commandA, commandB]);
await assert.rejects(() => reopenJournal(tamperedDirectory), /JOURNAL_CORRUPT/);
```

Cover a partial trailing record, wrong sequence, broken previous hash, duplicate command ID with different bytes, and an atomic cache snapshot that disagrees with journal replay.

- [ ] **Step 2: Run Task 3 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-journal.test.ts tests/runtime-run-state.test.ts tests/runtime-idempotency.test.ts tests/runtime-broker-daemon.test.ts tests/runtime-broker-ipc.test.ts`

Expected: FAIL because the durable-control modules do not exist.

- [ ] **Step 3: Implement append-and-fsync journal plus pure state reducer**

```ts
export async function appendJournalRecord(file: FileHandle, record: JournalRecordV4): Promise<void> {
  await file.write(`${canonicalJsonV4(record)}\n`, null, 'utf8');
  await file.sync();
}
```

The daemon acknowledges a mutation only after journal fsync and atomic current-state cache replacement. The cache is rebuildable; journal corruption is terminal and never repaired automatically.

- [ ] **Step 4: Implement idempotency and repository locks**

`request_id` maps to canonical request hash plus broker-generated `run_id`. Same ID/same hash returns the existing run. Same ID/different hash returns `INVALID_CONTRACT`. Acquire the per-repository lock with exclusive creation and a random boot nonce; a live or unverifiable owner returns `REPOSITORY_BUSY` rather than stealing the lock.

- [ ] **Step 5: Implement authenticated user-local IPC**

```ts
const endpoint = process.platform === 'win32'
  ? `\\\\.\\pipe\\agent-orchestration-${userIdentityHash}`
  : join(stateDirectory, 'broker.sock');
```

Use length-prefixed canonical JSON messages, a 256-bit token stored in the owner-only state directory, constant-time token comparison, maximum frame size 1 MiB, request deadlines, and strict command loading. Tests prove unauthenticated, oversized, malformed, replayed-mutating, and unknown commands fail without journal append.

- [ ] **Step 6: Test restart reconciliation**

Simulate daemon exit after journal fsync but before reply, reconnect through a new STDIO-like client, resubmit the same `request_id`, and assert the original `run_id` is returned. Simulate an unknown child-process state and assert terminal typed failure rather than success.

- [ ] **Step 7: Run Task 3 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-journal.test.ts tests/runtime-run-state.test.ts tests/runtime-idempotency.test.ts tests/runtime-broker-daemon.test.ts tests/runtime-broker-ipc.test.ts`

Run: `npm run typecheck`

Expected: all Task 3 tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/runtime/journal.ts src/runtime/run-state.ts src/runtime/request-idempotency.ts src/runtime/repository-lock.ts src/runtime/broker-daemon.ts src/runtime/broker-ipc.ts tests/runtime-journal.test.ts tests/runtime-run-state.test.ts tests/runtime-idempotency.test.ts tests/runtime-broker-daemon.test.ts tests/runtime-broker-ipc.test.ts
git commit -m "feat(runtime): add durable broker daemon"
```

---

### Task 4: Docker ProcessSandboxBackend and hostile acceptance suite

**Files:**

- Create: `src/runtime/process-sandbox.ts`
- Create: `src/runtime/docker-sandbox.ts`
- Create: `src/runtime/sandbox-egress-proxy.ts`
- Create: `src/runtime/sandbox-certification.ts`
- Create: `infra/sandbox/Dockerfile`
- Create: `tests/fixtures/sandbox/hostile-child.mjs`
- Create: `tests/fixtures/sandbox/network-probe.mjs`
- Create: `tests/runtime-process-sandbox.test.ts`
- Create: `tests/runtime-docker-sandbox.test.ts`
- Create: `tests/runtime-sandbox-hostile.test.ts`

**Interfaces:**

```ts
export type SandboxProfileV4 = 'EXECUTOR_NETWORKED' | 'FRONTIER_NETWORKED' | 'VALIDATION_UNTRUSTED' | 'REVIEW_CAPSULE';

export interface ProcessSandboxBackendV4 {
  readonly id: string;
  probe(profile: SandboxProfileV4): Promise<SandboxProbeResultV4>;
  run(request: SandboxRunRequestV4): Promise<SandboxRunResultV4>;
  terminate(executionId: string): Promise<void>;
}

export interface DockerSandboxConfigV4 {
  docker_executable: string;
  image_id: `sha256:${string}`;
  certification_ttl_seconds: number;
  provider_hosts: readonly string[];
}
```

- [ ] **Step 1: Write backend contract tests with an unsupported backend**

```ts
const result = await backend.probe('VALIDATION_UNTRUSTED');
assert.deepEqual(result, { status: 'UNSUPPORTED', failure: 'PROCESS_SANDBOX_UNAVAILABLE' });
await assert.rejects(() => backend.run(request), /PROCESS_SANDBOX_UNAVAILABLE/);
```

- [ ] **Step 2: Run Task 4 unit tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-process-sandbox.test.ts tests/runtime-docker-sandbox.test.ts tests/runtime-sandbox-hostile.test.ts`

Expected: FAIL because no backend contract or Docker implementation exists.

- [ ] **Step 3: Add the pinned trusted harness image**

```dockerfile
FROM node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
RUN npm install --global opencode-ai@1.18.15 @openai/codex@0.147.0 \
    && npm cache clean --force
RUN mkdir -p /capsule /broker && chown -R node:node /capsule /broker
USER node
WORKDIR /capsule
ENTRYPOINT []
```

Build without pulling a mutable replacement and capture the immutable local image ID:

```powershell
docker build --pull=false -t agent-orchestration-sandbox:v4 -f infra/sandbox/Dockerfile .
$env:AO_SANDBOX_IMAGE = docker image inspect --format '{{.Id}}' agent-orchestration-sandbox:v4
```

- [ ] **Step 4: Implement exact Docker argv and fail-closed probe**

The probe requires server `OSType=linux`, architecture match, `seccomp`, cgroup namespaces, a `sha256:` image ID, and successful hostile certification for the exact Docker server ID/image ID/policy hash. Runtime argv must include:

```ts
const isolationArgs = [
  'run', '--rm', '--read-only', '--cap-drop=ALL',
  '--security-opt=no-new-privileges', '--pids-limit=64',
  '--memory=1024m', '--cpus=2', '--user=1000:1000',
  '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m',
  '--network=none',
];
```

Never mount `/var/run/docker.sock`, host home, credential directories, broker state, or the active worktree. Spawn Docker with `shell: false`, an environment allowlist, bounded stdout/stderr, and a process-tree timeout.

- [ ] **Step 5: Implement broker-owned provider egress proxy**

Run the proxy as a sibling container with no repository mount. The target container joins only a per-run `--internal` network; the proxy joins that network and a separate outbound bridge. The proxy accepts only HTTP `CONNECT` to exact lower-case `host:443` entries from `provider_hosts`, resolves after allowlist comparison, rejects IP literals/private ranges/redirect expansion, and records only host, decision, byte counts, and duration.

- [ ] **Step 6: Add hostile fixtures that attempt real effects**

`hostile-child.mjs` must attempt: read an outside sentinel, enumerate host home, read injected `ARLIAI_API_KEY`/`OPENAI_API_KEY`, write outside the mount, spawn 100 descendants, keep a grandchild alive after timeout, open the Docker socket, and access loopback. `network-probe.mjs` must reach one local allowlisted TLS fixture through the proxy and fail against a second non-allowlisted fixture plus a direct IP.

- [ ] **Step 7: Run hostile certification early**

Run: `npm run build`

Run: `npm exec -- tsx --test tests/runtime-sandbox-hostile.test.ts`

Expected: PASS only when every forbidden effect is blocked by Docker/OS enforcement and the allowlisted proxy case succeeds. If this fails on the initial host, stop V4 implementation here and report `PROCESS_SANDBOX_UNAVAILABLE`; do not proceed to harness integration.

- [ ] **Step 8: Run Task 4 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-process-sandbox.test.ts tests/runtime-docker-sandbox.test.ts tests/runtime-sandbox-hostile.test.ts`

Run: `npm run typecheck`

Expected: all Task 4 tests PASS with a fresh certification bound to host, Docker server, image, broker version, and policy hash.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/runtime/process-sandbox.ts src/runtime/docker-sandbox.ts src/runtime/sandbox-egress-proxy.ts src/runtime/sandbox-certification.ts infra/sandbox/Dockerfile tests/fixtures/sandbox tests/runtime-process-sandbox.test.ts tests/runtime-docker-sandbox.test.ts tests/runtime-sandbox-hostile.test.ts
git commit -m "feat(runtime): certify docker process sandbox"
```

---

### Task 5: Isolated Git worktrees and ExecutorCapsule

**Files:**

- Create: `src/runtime/git-runner.ts`
- Create: `src/runtime/worktree.ts`
- Create: `src/runtime/executor-capsule.ts`
- Create: `src/runtime/instruction-bundle.ts`
- Create: `src/runtime/diff-policy.ts`
- Create: `tests/runtime-worktree.test.ts`
- Create: `tests/runtime-executor-capsule.test.ts`
- Create: `tests/runtime-instruction-bundle.test.ts`
- Create: `tests/runtime-diff-policy.test.ts`

**Interfaces:**

```ts
export interface WorktreeManagerV4 {
  create(contract: RuntimeWorkContractV4): Promise<WorktreeRecordV4>;
  verify(record: WorktreeRecordV4): Promise<WorktreeVerificationV4>;
}

export interface ExecutorCapsuleBuilderV4 {
  build(input: ExecutorCapsuleInputV4): Promise<ExecutorCapsuleV4>;
}

export function buildInstructionBundle(input: InstructionBundleInputV4): Promise<InstructionBundleV4>;
export function enforceDiffPolicy(input: DiffPolicyInputV4): Promise<DiffPolicyResultV4>;
```

- [ ] **Step 1: Write failing worktree-isolation tests**

Create a temporary Git repository whose active worktree has an untracked file and an unstaged edit. Assert `create()` produces `codex/auto/run_fixture`, freezes the requested base SHA, and leaves active HEAD/status/bytes unchanged.

```ts
assert.equal(created.branch, 'codex/auto/run_fixture');
assert.deepEqual(await activeTreeSnapshot(repo), before);
assert.equal(created.base_sha, await revParse(repo, 'HEAD'));
```

- [ ] **Step 2: Write failing capsule and instruction tests**

Place hostile `opencode.json`, `.opencode/tools/bash.ts`, `.opencode/plugins/pwn.ts`, `AGENTS.md`, and `CLAUDE.md` in the worktree. Assert capsule root contains only broker-owned `config/`, `agent/`, `instructions/`, `home/`, `cache/`, `tmp/`, and the broker-created `repo/` mount. Assert only policy-approved instruction paths are copied from the frozen base tree and all hashes appear in the bundle manifest.

- [ ] **Step 3: Run Task 5 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-worktree.test.ts tests/runtime-executor-capsule.test.ts tests/runtime-instruction-bundle.test.ts tests/runtime-diff-policy.test.ts`

Expected: FAIL because worktree/capsule/diff services do not exist.

- [ ] **Step 4: Implement exact Git runner and worktree lifecycle**

```ts
export async function runGit(repo: string, argv: readonly string[]): Promise<GitResultV4> {
  return spawnExact('git', ['-C', repo, ...argv], {
    env: sanitizedGitEnvironment(),
    timeoutMs: 30_000,
  });
}
```

Allow only broker-internal argv templates for `rev-parse`, `status --porcelain=v2 -z`, `worktree add --detach`, `branch`, and read-only tree inspection. Never expose `runGit` through MCP or harness prompts. Validate the worktree parent against the local registry before creation.

- [ ] **Step 5: Implement ExecutorCapsule and approved instruction bundle**

Build the capsule outside both active and task worktrees. Use synthetic directories and a broker-owned mount manifest. Copy approved instructions by reading blobs from frozen `base_sha`, not mutable worktree bytes. Instruction text is bounded and cannot change tools, network, route, validation, or allowed paths.

```ts
interface InstructionBundleEntryV4 {
  source_path: string;
  content_hash: string;
  byte_length: number;
  capsule_path: string;
}
```

- [ ] **Step 6: Implement post-attempt diff policy**

Compare the current tree against `base_sha`, classify each exact path as `CREATE`, `MODIFY`, or `DELETE`, reject mode/submodule/symlink changes unless explicitly supported, count files/lines, and reproduce `diff_hash` plus `tree_hash`. Any mismatch or unsafe parent chain returns `OUT_OF_SCOPE_CHANGE` before validation.

- [ ] **Step 7: Run Task 5 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-worktree.test.ts tests/runtime-executor-capsule.test.ts tests/runtime-instruction-bundle.test.ts tests/runtime-diff-policy.test.ts`

Run: `npm run typecheck`

Expected: all Task 5 tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/runtime/git-runner.ts src/runtime/worktree.ts src/runtime/executor-capsule.ts src/runtime/instruction-bundle.ts src/runtime/diff-policy.ts tests/runtime-worktree.test.ts tests/runtime-executor-capsule.test.ts tests/runtime-instruction-bundle.test.ts tests/runtime-diff-policy.test.ts
git commit -m "feat(runtime): isolate worktrees and executor capsules"
```

---

### Task 6: OpenCode MiMo/GLM runner and versioned capability probes

**Files:**

- Create: `src/runtime/credential-adapter.ts`
- Create: `src/runtime/opencode-config.ts`
- Create: `src/runtime/opencode-runner.ts`
- Create: `src/runtime/capabilities.ts`
- Create: `tests/fixtures/bin/fake-opencode.mjs`
- Create: `tests/runtime-opencode.test.ts`
- Create: `tests/runtime-capabilities.test.ts`
- Modify: `profiles/arliai-opencode.example.yaml`

**Interfaces:**

```ts
export interface CredentialAdapterV4 {
  lease(binding: ResolvedBindingV4): Promise<CredentialLeaseV4>;
  revoke(leaseId: string): Promise<void>;
}

export interface OpenCodeRunnerV4 {
  execute(input: ExecutorAttemptInputV4): Promise<ExecutorAttemptResultV4>;
}

export function createOpenCodeRunner(deps: OpenCodeRunnerDependenciesV4): OpenCodeRunnerV4;
export function probeRuntimeBinding(input: CapabilityProbeInputV4): Promise<CapabilityRecordV4>;
export function assertFreshCapability(record: CapabilityRecordV4, expected: CapabilityIdentityV4): void;
```

- [ ] **Step 1: Write failing fake-harness argv/env/config tests**

The fake binary writes its cwd, argv, visible environment-key names, resolved config, and emitted JSON events to a broker-owned capture file. Assert cwd is capsule root; argv contains `run --pure --auto --dir /capsule --model arliai/MiMo-V2.5 --agent executor --format json`; no shell fragment exists; and environment contains only the credential lease plus explicit OpenCode/runtime variables.

- [ ] **Step 2: Add hostile configuration-discovery tests**

Put conflicting model/provider values and executable custom tools in `repo/`, synthetic host-global config, and a fake managed-config path. The fake harness must resolve only broker config with:

```json
{
  "share": "disabled",
  "autoupdate": false,
  "enabled_providers": ["arliai"],
  "permission": {
    "*": "deny",
    "read": { "*": "deny", "repo/**": "allow" },
    "glob": { "*": "deny", "repo/**": "allow" },
    "grep": "allow",
    "edit": { "*": "deny", "repo/src/greeting.ts": "allow" }
  }
}
```

- [ ] **Step 3: Run Task 6 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-opencode.test.ts tests/runtime-capabilities.test.ts`

Expected: FAIL because the credential adapter, runner, and probe registry do not exist.

- [ ] **Step 4: Implement broker-owned config and structured result parser**

Set `OPENCODE_CONFIG_DIR=/capsule/config`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, and `OPENCODE_DISABLE_CLAUDE_CODE=1`. Define the ArliAI provider with its fixed base URL and an environment credential reference; never serialize the key. Reject non-JSON events, output over budget, missing terminal result, unexpected tool, or changed binding identity as `EXECUTOR_INVALID_OUTPUT`.

- [ ] **Step 5: Implement sandboxed MiMo then GLM attempt execution**

Run OpenCode only through a freshly certified `EXECUTOR_NETWORKED` backend. MiMo may perform the initial attempt and one repair from stored findings. GLM-4.7 is legal only after two persisted review rejections and a typed `ESCALATION_DECIDED` event. Every attempt is followed immediately by `enforceDiffPolicy`.

- [ ] **Step 6: Implement versioned capability probes and TTL**

```ts
const identity: CapabilityIdentityV4 = {
  profile_hash,
  harness: 'opencode',
  harness_version: '1.18.15',
  agent_policy_hash,
  broker_version,
  probe_version: 1,
};
```

Probe structured result, exact bounded edit, multi-step file-tool use, and repair from supplied failed-validation evidence without shell. Store content-addressed evidence with `probed_at`/`expires_at`. Any identity mismatch or expiry yields `CAPABILITY_UNVERIFIED`.

- [ ] **Step 7: Add opt-in live ArliAI probe**

Gate it behind `AO_LIVE_PROVIDER_PROBES=1`; require the user credential adapter and a disposable public fixture only. Default CI asserts the test is not run and no network call occurs.

- [ ] **Step 8: Run Task 6 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-opencode.test.ts tests/runtime-capabilities.test.ts`

Run: `npm run typecheck`

Expected: fake harness tests PASS with no provider call; TypeScript exits 0.

- [ ] **Step 9: Commit Task 6**

```bash
git add src/runtime/credential-adapter.ts src/runtime/opencode-config.ts src/runtime/opencode-runner.ts src/runtime/capabilities.ts tests/fixtures/bin/fake-opencode.mjs tests/runtime-opencode.test.ts tests/runtime-capabilities.test.ts profiles/arliai-opencode.example.yaml
git commit -m "feat(runtime): run verified opencode executors"
```

---

### Task 7: Deterministic validation in VALIDATION_UNTRUSTED

**Files:**

- Create: `src/runtime/validation.ts`
- Create: `src/runtime/process-policy.ts`
- Create: `src/runtime/artifact-store.ts`
- Create: `tests/fixtures/bin/fake-validation.mjs`
- Create: `tests/runtime-validation.test.ts`
- Create: `tests/runtime-process-policy.test.ts`
- Create: `tests/runtime-artifact-store.test.ts`

**Interfaces:**

```ts
export interface ValidationRunnerV4 {
  run(input: ValidationRunInputV4): Promise<ValidationResultV4>;
}

export function resolveValidation(policy: FrozenRepositoryPolicyV4, validationId: string): ResolvedValidationV4;
export function createValidationRunner(deps: ValidationRunnerDependenciesV4): ValidationRunnerV4;
export interface ArtifactStoreV4 {
  put(kind: ArtifactKindV4, bytes: Uint8Array): Promise<ArtifactReferenceV4>;
  verify(reference: ArtifactReferenceV4): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing exact-command tests**

Assert validation IDs resolve to owner policy argv arrays and reject caller argv, shell metacharacters, unknown IDs, wrong cwd, timeout expansion, executable substitution, and policy-hash mismatch before sandbox launch.

- [ ] **Step 2: Write failing containment/result tests**

The fake validation attempts to print a synthetic secret, use network, create a survivor child, write outside `repo/`, and emit over-budget output. Assert secrets are absent, forbidden effects fail, the process tree is gone after timeout, output is truncated by bytes without invalid UTF-8, full bytes are content-addressed locally, and the result binds to the validated `tree_hash`.

- [ ] **Step 3: Run Task 7 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-validation.test.ts tests/runtime-process-policy.test.ts tests/runtime-artifact-store.test.ts`

Expected: FAIL because validation and artifact services do not exist.

- [ ] **Step 4: Implement exact policy resolution and sandbox request**

```ts
const request: SandboxRunRequestV4 = {
  execution_id,
  profile: 'VALIDATION_UNTRUSTED',
  argv: validation.argv,
  cwd: `/capsule/repo/${validation.workingDirectory}`,
  env: validationEnvironment(),
  mounts,
  limits: validation.limits,
  network: { mode: 'NONE' },
};
```

No provider/user/Git/cloud/package-manager credential is present. Install/lifecycle steps are separate trusted provisioning and cannot be validation commands.

- [ ] **Step 5: Implement bounded artifact storage and validation manifest**

Store full logs/diffs under broker-owned content-addressed paths with create-exclusive writes and hash verification. Runtime result contains only command ID, sandbox policy hash, executable/image hash, exit code, duration/resource counters, truncated-output hash, artifact hash, and validated tree hash.

- [ ] **Step 6: Enforce validation gate semantics**

All mandatory validations must pass on the current tree. A changed tree invalidates prior results. Timeout, sandbox violation, missing artifact, hash mismatch, or nonzero exit returns `VALIDATION_FAILED` and prevents review/finalization.

- [ ] **Step 7: Run Task 7 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-validation.test.ts tests/runtime-process-policy.test.ts tests/runtime-artifact-store.test.ts`

Run: `npm run typecheck`

Expected: all Task 7 tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit Task 7**

```bash
git add src/runtime/validation.ts src/runtime/process-policy.ts src/runtime/artifact-store.ts tests/fixtures/bin/fake-validation.mjs tests/runtime-validation.test.ts tests/runtime-process-policy.test.ts tests/runtime-artifact-store.test.ts
git commit -m "feat(runtime): validate trees in untrusted sandbox"
```

---

### Task 8: Sol frontier executor in ExecutorCapsule

**Files:**

- Create: `src/runtime/codex-runner.ts`
- Create: `src/runtime/frontier-executor.ts`
- Create: `contracts/frontier-executor-result-v4.schema.json`
- Create: `tests/fixtures/bin/fake-codex.mjs`
- Create: `tests/runtime-codex-runner.test.ts`
- Create: `tests/runtime-frontier.test.ts`
- Modify: `tests/runtime-schema-parity.test.ts`

**Interfaces:**

```ts
export interface CodexRunnerV4 {
  execute(input: CodexExecutionInputV4): Promise<CodexExecutionResultV4>;
}

export interface FrontierExecutorV4 {
  execute(contract: RuntimeWorkContractV4, capsule: ExecutorCapsuleV4): Promise<ExecutorAttemptResultV4>;
}

export function createCodexRunner(deps: CodexRunnerDependenciesV4): CodexRunnerV4;
export function createFrontierExecutor(deps: FrontierExecutorDependenciesV4): FrontierExecutorV4;
```

- [ ] **Step 1: Write failing exact Codex argv/capsule tests**

Assert the fake CLI receives capsule root, never the original worktree path, and exact flags:

```text
codex exec --ephemeral --ignore-user-config --ignore-rules
  --sandbox workspace-write --output-schema /capsule/config/frontier-executor-result-v4.schema.json
  --json --cd /capsule
```

The prompt identifies `repo/` as the only editable source, includes the frozen contract and approved instruction manifest, and forbids commit/push/deploy/network.

- [ ] **Step 2: Write failing credential-separation hostile test**

Provide a fake saved-auth sentinel to the trusted Codex parent and instruct a model-invoked fixture command to read it. The nested/outer sandbox combination must allow provider authentication but deny the command access to auth bytes and network. Failure returns `PROCESS_SANDBOX_UNAVAILABLE`, not a weaker run.

- [ ] **Step 3: Run Task 8 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-codex-runner.test.ts tests/runtime-frontier.test.ts tests/runtime-schema-parity.test.ts`

Expected: FAIL because Codex/frontier services and result schema do not exist.

- [ ] **Step 4: Implement structured Codex execution through FRONTIER_NETWORKED**

Use saved CLI authentication only through `CredentialAdapterV4`; do not set `OPENAI_API_KEY` or `CODEX_API_KEY` in tool-child environments. Parse JSONL with byte/event ceilings and validate the final message against `frontier-executor-result-v4.schema.json`.

- [ ] **Step 5: Implement the terminal frontier state machine**

```ts
type FrontierStateV4 =
  | 'FRONTIER_EXECUTION'
  | 'VALIDATION'
  | 'FRESH_REVIEW'
  | 'ACCEPTED'
  | 'TERMINAL_REJECTED';
```

There is exactly one frontier execution. Rejection is terminal; no automatic frontier repair exists. Every output passes path/diff policy and deterministic validation before review.

- [ ] **Step 6: Add opt-in live Codex capability probe**

Use only the disposable public fixture, require `AO_LIVE_PROVIDER_PROBES=1`, record Codex version/auth mode/policy hashes, and prove credential separation. Default CI uses `fake-codex.mjs` only.

- [ ] **Step 7: Run Task 8 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-codex-runner.test.ts tests/runtime-frontier.test.ts tests/runtime-schema-parity.test.ts`

Run: `npm run typecheck`

Expected: all Task 8 tests PASS; TypeScript exits 0.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/runtime/codex-runner.ts src/runtime/frontier-executor.ts contracts/frontier-executor-result-v4.schema.json tests/fixtures/bin/fake-codex.mjs tests/runtime-codex-runner.test.ts tests/runtime-frontier.test.ts tests/runtime-schema-parity.test.ts
git commit -m "feat(runtime): execute frontier tasks in capsule"
```

---

### Task 9: ReviewCapsule, fresh Sol review, and strict attestation

**Files:**

- Create: `src/runtime/review-envelope.ts`
- Create: `src/runtime/review-capsule.ts`
- Create: `src/runtime/review-attestation.ts`
- Create: `src/runtime/reviewer.ts`
- Create: `tests/runtime-review-envelope.test.ts`
- Create: `tests/runtime-review-capsule.test.ts`
- Create: `tests/runtime-review-attestation.test.ts`
- Create: `tests/runtime-reviewer.test.ts`

**Interfaces:**

```ts
export function buildReviewEnvelope(input: ReviewEnvelopeInputV4): ReviewEnvelopeV4;
export function buildReviewCapsule(input: ReviewCapsuleInputV4): Promise<ReviewCapsuleV4>;
export function verifyReviewAttestation(input: AttestationVerificationInputV4): ReviewAttestationV4;

export interface ReviewerV4 {
  review(input: ReviewInputV4): Promise<ReviewOutcomeV4>;
}
```

- [ ] **Step 1: Write failing evidence-envelope tests**

Assert the envelope contains only contract, base SHA, complete current diff, changed-file list, validation manifest, current hashes, and immediately preceding unresolved findings. Reject planner/executor reasoning, transcripts, hidden traces, environment values, raw credentials, prior verdict, or unrelated repository files.

- [ ] **Step 2: Write failing physical-capsule tests**

Create an original worktree with a sentinel file not present in the diff. Assert `ReviewCapsule` contains only immutable envelope files plus explicitly approved context. A fake reviewer attempting `../`, absolute paths, original worktree path, host home, or broker state must fail at the filesystem boundary.

- [ ] **Step 3: Run Task 9 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-review-envelope.test.ts tests/runtime-review-capsule.test.ts tests/runtime-review-attestation.test.ts tests/runtime-reviewer.test.ts`

Expected: FAIL because review services do not exist.

- [ ] **Step 4: Implement capsule creation and exact Codex review argv**

```text
codex exec --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only --skip-git-repo-check
  --output-schema /capsule/review-attestation-v4.schema.json
  --json --cd /capsule
```

Run through fresh `REVIEW_CAPSULE` certification. Each review has a new session ID different from every executor and earlier reviewer. The worktree is not mounted.

- [ ] **Step 5: Implement one bounded context-expansion round**

The first result may be `REQUEST_CONTEXT` with exact repository-relative paths and hashes. Validate requests against review policy, copy approved frozen/current bytes into a newly built capsule, and start another fresh ephemeral session. A second `REQUEST_CONTEXT` is `REVIEW_ATTESTATION_INVALID`.

- [ ] **Step 6: Implement strict attestation verification**

```ts
assert.equal(attestation.contract_hash, current.contract_hash);
assert.equal(attestation.reviewed_tree_hash, current.tree_hash);
assert.equal(attestation.reviewed_diff_hash, current.diff_hash);
assert.equal(attestation.validation_manifest_hash, current.validation_manifest_hash);
assert.deepEqual(attestation.unresolved_finding_ids, []);
```

Recompute `attestation_hash`, reject stale/forged/session-reused attestations, and persist the accepted attestation in broker-owned append-only state.

- [ ] **Step 7: Encode the economy review/repair/escalation sequence**

Test exactly: MiMo → validation → review 1 → MiMo repair → validation → review 2 → typed GLM escalation → validation → final fresh review. A fourth attempt, second MiMo repair, early GLM, validation failure, or final rejection is terminal without commit.

- [ ] **Step 8: Run Task 9 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-review-envelope.test.ts tests/runtime-review-capsule.test.ts tests/runtime-review-attestation.test.ts tests/runtime-reviewer.test.ts`

Run: `npm run typecheck`

Expected: all Task 9 tests PASS; TypeScript exits 0.

- [ ] **Step 9: Commit Task 9**

```bash
git add src/runtime/review-envelope.ts src/runtime/review-capsule.ts src/runtime/review-attestation.ts src/runtime/reviewer.ts tests/runtime-review-envelope.test.ts tests/runtime-review-capsule.test.ts tests/runtime-review-attestation.test.ts tests/runtime-reviewer.test.ts
git commit -m "feat(runtime): attest isolated sol reviews"
```

---

### Task 10: GitObjectWriter and compare-and-commit finalization

**Files:**

- Create: `src/runtime/git-object-writer.ts`
- Create: `src/runtime/finalize.ts`
- Create: `tests/runtime-git-object-writer.test.ts`
- Create: `tests/runtime-finalize.test.ts`
- Create: `tests/fixtures/git/hooks/pre-commit`
- Create: `tests/fixtures/git/filters/hostile-filter.mjs`

**Interfaces:**

```ts
export interface GitObjectWriterV4 {
  writeAcceptedTree(input: AcceptedTreeInputV4): Promise<GitTreeObjectV4>;
  createCommit(input: CommitObjectInputV4): Promise<GitCommitObjectV4>;
  updateTaskRef(input: TaskRefUpdateInputV4): Promise<void>;
}

export function createGitObjectWriter(deps: GitObjectWriterDependenciesV4): GitObjectWriterV4;
export function finalizeRun(input: FinalizeRunInputV4): Promise<FinalizedRunV4>;
```

- [ ] **Step 1: Write failing hostile hook/filter tests**

Configure `pre-commit`, `commit-msg`, clean/smudge filters, aliases, global Git config, credential helper, signing, and a second non-task ref. Each writes an external sentinel if invoked. Finalization must create the expected commit while every sentinel remains absent.

- [ ] **Step 2: Write failing hash and compare-and-update tests**

Test accepted tree equality, stale base/ref, changed file after review, mismatched diff/validation/attestation/policy/profile hashes, non-task ref mutation, hook-created tree mutation, and concurrent finalizers. Every failure occurs before or atomically instead of a partial successful state.

- [ ] **Step 3: Run Task 10 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-git-object-writer.test.ts tests/runtime-finalize.test.ts`

Expected: FAIL because object writer/finalizer do not exist.

- [ ] **Step 4: Implement hook/filter-free object construction**

Use only broker-owned exact plumbing argv arrays with sanitized Git environment:

```ts
const hashObjectArgv = ['hash-object', '-w', '--no-filters', '--stdin'] as const;
const makeTreeArgv = ['mktree', '-z'] as const;
const commitTreeArgv = ['commit-tree', acceptedTree, '-p', baseSha] as const;
const updateRefArgv = ['update-ref', taskRef, newCommit, expectedOld] as const;
```

Feed bytes through stdin, never a shell. Set author/committer identity and timestamps explicitly. Set `GIT_CONFIG_NOSYSTEM=1`, point `GIT_CONFIG_GLOBAL` to a broker-owned empty file, do not pass `-S`, and never execute porcelain `git commit`. Reject unsupported object format or file mode with `FINALIZATION_ISOLATION_FAILED`.

- [ ] **Step 5: Implement compare-and-commit transaction**

Acquire run and repository locks; reproduce contract/policy/profile/diff/tree/validation/review hashes; verify exact allowed changes and accepted attestation; write objects; atomically update only the expected task ref; verify committed tree; append `COMMIT_CREATED`; then mark terminal success. A journal failure after ref update is recovered by matching the recorded intended commit and ref transaction, never by creating another commit.

- [ ] **Step 6: Prove active worktree and other refs remain unchanged**

Snapshot active worktree bytes/status/HEAD, all refs, config, and reflogs before finalization. After success, only the task ref and its reflog may differ; active worktree and branch remain byte-identical.

- [ ] **Step 7: Run Task 10 GREEN gates**

Run: `npm exec -- tsx --test tests/runtime-git-object-writer.test.ts tests/runtime-finalize.test.ts`

Run: `npm run typecheck`

Expected: all Task 10 tests PASS; no hostile sentinel exists; TypeScript exits 0.

- [ ] **Step 8: Commit Task 10**

```bash
git add src/runtime/git-object-writer.ts src/runtime/finalize.ts tests/runtime-git-object-writer.test.ts tests/runtime-finalize.test.ts tests/fixtures/git
git commit -m "feat(runtime): finalize accepted trees without hooks"
```

---

### Task 11: Required STDIO MCP adapter and automatic project activation

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/stdio-adapter.ts`
- Create: `src/runtime/codex-project-config.ts`
- Modify: `src/cli/main.ts`
- Create: `tests/mcp-server.test.ts`
- Create: `tests/runtime-codex-project-config.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**

```ts
export const V4_MCP_TOOLS = [
  'run_coding_task',
  'repair_coding_task',
  'finalize_coding_task',
  'abort_coding_task',
  'get_coding_task_status',
] as const;

export function createMcpStdioAdapter(deps: McpAdapterDependenciesV4): McpServerV4;
export function renderCodexProjectConfig(input: CodexProjectConfigInputV4): GeneratedFile;
```

- [ ] **Step 1: Install the pinned official MCP SDK**

Run: `npm install @modelcontextprotocol/sdk@1.30.0`

Expected: `package.json` and `package-lock.json` change; `npm audit` reports no known vulnerability at install time or the task stops for dependency review.

- [ ] **Step 2: Write failing tool-surface and strict-schema tests**

Assert initialization instructions begin with the mandatory source-mutation rule, only the five domain tools are listed, every schema rejects additional properties, `run_coding_task` accepts `request_id` but not `run_id`, and finalize accepts only `run_id`.

- [ ] **Step 3: Write failing short-call/idempotency/disconnect tests**

Use a fake daemon client. Assert each mutation durably enqueues and returns without waiting for model execution; a dropped STDIO connection followed by the same request returns the original `run_id`; daemon unavailable is a typed MCP error and does not touch a repository.

- [ ] **Step 4: Run Task 11 tests and record RED**

Run: `npm exec -- tsx --test tests/mcp-server.test.ts tests/runtime-codex-project-config.test.ts tests/cli.test.ts`

Expected: FAIL because MCP/config/CLI surfaces do not exist.

- [ ] **Step 5: Implement the thin SDK adapter over authenticated IPC**

Tool handlers call only `BrokerIpcClientV4`. Bound result payloads to state, IDs, hashes, failure code, and status token. Never return prompts, source, diff, transcript, environment, or credentials. MCP interruption cannot cancel or duplicate daemon-owned work.

- [ ] **Step 6: Generate fail-closed project Codex configuration**

```toml
sandbox_mode = "read-only"

[mcp_servers.agent_orchestration_v4]
command = "node"
args = [".agent-orchestration/runtime/dist/cli/main.js", "runtime", "mcp-stdio"]
required = true
enabled_tools = ["run_coding_task", "repair_coding_task", "finalize_coding_task", "abort_coding_task", "get_coding_task_status"]
startup_timeout_sec = 10
tool_timeout_sec = 30
default_tools_approval_mode = "auto"
```

The renderer installs the immutable runtime bundle at the project-local canonical path shown above and emits that path as one argv value. It creates `.codex/config.toml` only when absent or inventory-managed; unmanaged conflicts are reported and never overwritten.

- [ ] **Step 7: Add CLI lifecycle commands**

```text
agent-orchestration runtime daemon
agent-orchestration runtime mcp-stdio
agent-orchestration runtime doctor --repository-policy policies/repository-policy.yaml --profile profiles/runtime.yaml
agent-orchestration runtime status --run-id run_01HZX3YH8C7Y9QJ4J6M2G5K8N1
```

`doctor` checks daemon IPC, repository registry, exact profile/policy hashes, harness versions, credentials without printing them, sandbox certification, worktree parent, and capability TTL. Any missing mandatory item exits nonzero.

- [ ] **Step 8: Prove automatic activation and no direct-write fallback**

In a temporary project, render the managed config, initialize the MCP adapter, issue a normal coding request, and assert the daemon receives one `run_coding_task`. Simulate required MCP startup failure and assert the primary flow terminates before any direct file edit.

- [ ] **Step 9: Run Task 11 GREEN gates**

Run: `npm exec -- tsx --test tests/mcp-server.test.ts tests/runtime-codex-project-config.test.ts tests/cli.test.ts`

Run: `npm run typecheck`

Expected: all Task 11 tests PASS; existing CLI tests remain unchanged and green.

- [ ] **Step 10: Commit Task 11**

```bash
git add package.json package-lock.json src/mcp/tools.ts src/mcp/stdio-adapter.ts src/runtime/codex-project-config.ts src/cli/main.ts tests/mcp-server.test.ts tests/runtime-codex-project-config.test.ts tests/cli.test.ts
git commit -m "feat(runtime): expose required v4 mcp control plane"
```

---

### Task 12: V4 telemetry, optional V3 handoff, full E2E, and documentation

**Files:**

- Create: `src/runtime/telemetry.ts`
- Create: `src/runtime/v3-telemetry-port.ts`
- Create: `src/runtime/orchestrator.ts`
- Create: `src/runtime/index.ts`
- Create: `contracts/runtime-event-v4.schema.json`
- Create: `tests/runtime-telemetry.test.ts`
- Create: `tests/runtime-v3-telemetry-port.test.ts`
- Create: `tests/runtime-e2e.test.ts`
- Create: `tests/runtime-security.test.ts`
- Modify: `tests/runtime-schema-parity.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/runtime-v4-operations.md`

**Interfaces:**

```ts
export function appendRuntimeEventV4(log: readonly RuntimeEventV4[], event: RuntimeEventV4): readonly RuntimeEventV4[];

export interface V3TelemetryPortV4 {
  available(): Promise<boolean>;
  export(events: readonly RuntimeEventV4[]): Promise<V3TelemetryExportResultV4>;
}

export interface RuntimeOrchestratorV4 {
  start(request: RuntimeTaskRequestV4): Promise<RuntimeResultV4>;
  resume(runId: string): Promise<RuntimeResultV4>;
  abort(runId: string): Promise<RuntimeResultV4>;
}
```

- [ ] **Step 1: Write failing bounded telemetry tests**

Cover every approved event type, strict sequence/hash chain, append idempotency, bounded findings, and recursive rejection of prompt/response/reasoning/transcript/diff/source/environment/credential fields or credential-shaped values. Telemetry append/export failure must never change a runtime gate from failure to success.

- [ ] **Step 2: Write the V3 absence test before creating the port**

```ts
assert.equal(await port.available(), false);
const result = await port.export(events);
assert.deepEqual(result, { status: 'UNAVAILABLE', reason: 'V3_RUNTIME_NOT_INSTALLED' });
assert.equal(runState.state, 'COMMITTED');
```

The port must not create `src/pilot/`, V3 schemas, or guessed V3 events. When the separate V3 implementation lands, a follow-up adapter may implement this interface without changing V4 runtime state.

- [ ] **Step 3: Run Task 12 tests and record RED**

Run: `npm exec -- tsx --test tests/runtime-telemetry.test.ts tests/runtime-v3-telemetry-port.test.ts tests/runtime-e2e.test.ts tests/runtime-security.test.ts tests/runtime-schema-parity.test.ts`

Expected: FAIL because telemetry/orchestrator/E2E integration do not exist.

- [ ] **Step 4: Implement strict runtime events and public schema**

Events contain only IDs, hashes, enums, counters, timestamps, durations, binding references, sandbox certification references, and bounded findings for the event list approved by the spec. Add AJV/Zod parity for `runtime-event-v4.schema.json`.

- [ ] **Step 5: Implement the complete daemon-owned orchestrator**

Wire Tasks 1–11 in this order: request/idempotency → policy/routing → lock/worktree/capsule → verified execution → diff policy → validation → fresh review → bounded repair/escalation or frontier terminal route → final hash transaction → local commit. Every thrown/returned failure maps to one approved typed failure and persists terminal evidence.

- [ ] **Step 6: Add fake-harness normal/economy E2E**

Prove one MCP task automatically executes MiMo, validates, receives fresh Sol acceptance, commits exact accepted bytes on `codex/auto/run_01HZX3YH8C7Y9QJ4J6M2G5K8N1`, leaves the active worktree untouched, and performs no push. Assert journal, artifact manifest, attestation, tree, diff, and commit hashes reproduce.

- [ ] **Step 7: Add repair/escalation/frontier/failure E2E matrix**

Cover: MiMo repair acceptance; second rejection then GLM acceptance; final rejection without commit; private source routed to Sol; security task routed to Sol; frontier rejection terminal; validation failure; sandbox unavailable; stale capability; forged attestation; out-of-scope path; daemon restart; abort; and broker failure with no direct-edit fallback.

- [ ] **Step 8: Add package exports and operator documentation**

Publish `./runtime-v4` from `src/runtime/index.ts`. Document installation, repository registry/profile/policy separation, Docker sandbox build/certification, OpenCode/Codex authentication, public-only ArliAI default, MCP project config, run/status/abort, artifact retention/cleanup, typed failures, no-push guarantee, and the currently unavailable concrete V3 adapter.

- [ ] **Step 9: Run focused V4 verification**

Run: `npm exec -- tsx --test tests/runtime-*.test.ts tests/mcp-server.test.ts`

Expected: all V4 and MCP tests PASS with fake harnesses; hostile sandbox suite PASS on the certified initial host.

- [ ] **Step 10: Run full repository verification**

Run: `npm run validate`

Run: `git diff --check`

Run: `git status --short`

Expected: all tests, typecheck, and build PASS; diff check is empty; status contains only intended V4 implementation/docs before commit.

- [ ] **Step 11: Request independent final review and repair by new red-green cycles**

Review specifically for credential exposure, Docker escape/bypass, config discovery, path/reparse escapes, journal corruption, idempotency races, stale hash acceptance, hook/filter execution, non-task ref mutation, MCP overreach, direct-write fallback, V2 regressions, and invented V3 behavior. Each accepted finding receives a failing regression test before its fix.

- [ ] **Step 12: Rerun complete verification after review repairs**

Run: `npm run validate`

Run: `npm exec -- tsx --test tests/runtime-sandbox-hostile.test.ts tests/runtime-security.test.ts tests/runtime-e2e.test.ts`

Run: `git diff --check`

Expected: every command exits 0 with zero test failures.

- [ ] **Step 13: Commit Task 12**

```bash
git add src/runtime/telemetry.ts src/runtime/v3-telemetry-port.ts src/runtime/orchestrator.ts src/runtime/index.ts contracts/runtime-event-v4.schema.json tests/runtime-telemetry.test.ts tests/runtime-v3-telemetry-port.test.ts tests/runtime-e2e.test.ts tests/runtime-security.test.ts tests/runtime-schema-parity.test.ts package.json README.md docs/runtime-v4-operations.md
git commit -m "feat(runtime): complete automated runner v4"
```

## Stop Conditions

Stop and report rather than weakening a boundary when:

- Docker Linux/seccomp/cgroup support or hostile certification is unavailable;
- provider authentication cannot be separated from repository-controlled child processes;
- an executor/reviewer loads unapproved project, global, managed, Claude, plugin, tool, skill, rule, or agent configuration;
- a private source would reach an economy binding without explicit profile and repository-policy authorization;
- exact path/reparse/mount/ADS checks cannot be enforced before model launch;
- a validation requires network or credentials;
- finalization would require porcelain commit, executable hooks/filters, user Git configuration, or a non-task ref update;
- MCP cannot remain a short typed adapter over durable daemon state;
- implementation would require push, merge, deploy, production data, secrets in repository files, or direct-write fallback;
- concrete V3 translation would require guessing contracts absent from the current branch.
