# Delegation practice packs V4

This runbook defines how a frontier planner delegates frontend, backend and cross-stack coding work without hard-coding one framework, provider or model into the runtime core. It builds on `WorkerCapabilityV4`, hash-bound story plans and approved repository instructions.

## Status and trust boundary

Runtime V4 enforces the selected worker identity, required capability IDs, story budgets, validation IDs, repair evidence and escalation. It does not infer a framework or ship practice packs by itself. That resolution belongs to the separately certified `practice_pack_resolver` host component and must complete before the plan is accepted.

A coding model cannot select, download, modify or self-certify a practice pack. The trusted host owns pack discovery, hashing, allowlisting and qualification. Repository content may constrain work but cannot grant new filesystem, network, credential, publication or deployment authority.

## Three instruction layers

The worker-visible instruction bundle is assembled from three bounded layers:

1. **Runtime invariants.** Minimal authorized changes, no secret access, no authority expansion, deterministic validation, evidence-only completion and stop conditions.
2. **Stack practice packs.** Versioned guidance for the detected and approved stack, such as component implementation, API handling, migrations or browser validation.
3. **Repository instructions.** Approved sources copied from the frozen base tree, including `AGENTS.md`, local architecture rules, design-system usage and established validation commands.

The host hashes the exact ordered bundle, including every pack ID, revision and content hash plus the approved repository-instruction manifest. That value becomes `deployment.instruction_bundle_hash` in `WorkerCapabilityV4`. Any content or ordering change invalidates the prior capability snapshot, qualification evidence and story plan.

Instruction precedence is deterministic: runtime security and authority invariants cannot be overridden; repository-specific conventions override generic style guidance when they do not weaken those invariants. An unresolved conflict fails closed before execution.

## Deterministic resolution

For each run, the trusted practice-pack resolver and thin composition root should:

1. Inspect only allowlisted stack evidence at the exact base SHA: manifests, lockfiles, compiler configuration, framework configuration and repository policy.
2. Load only repository-approved instruction sources from the frozen base tree.
3. Map the task class, authorized paths and stack evidence to allowlisted, versioned practice packs installed outside the writable worktree.
4. Verify every pack content hash and reject mutable aliases, network-fetched instructions and missing packs.
5. Match pack capability requirements against the exact qualified worker snapshot.
6. Build and hash the instruction bundle before frontier planning.
7. Require the planner to produce stories whose paths, capabilities, context, steps and acceptance criteria fit that snapshot.

Stack inference is evidence, not authority. If multiple frameworks appear or the relevant architecture is ambiguous, the resolver must require explicit repository configuration or route the planning/execution decision to frontier. It must not let the economy worker guess.

Only task-relevant packs should be loaded. Giving a smaller worker every available skill increases context pressure and creates conflicting instructions; it does not increase its proven capability.

## Practice-pack responsibilities

These names are examples, not fixed core identifiers. Each installation or repository may use different IDs, but the qualification catalog must define their exact semantics and probes.

| Work kind | Relevant context | Typical capabilities | Deterministic evidence |
|---|---|---|---|
| Frontend component | Nearby components, public types, design tokens, state and test patterns | component implementation, accessibility, browser validation | typecheck, unit tests, production build, approved browser/a11y checks |
| Backend API | Route/service patterns, public schema, authorization boundary, persistence interface | API implementation, input validation, authorization, integration testing | typecheck, unit/integration tests, API contract checks |
| Database change | Current schema, migration policy, rollback and fixture rules | migration planning, transactional safety, compatibility testing | migration lint/dry-run, compatibility and rollback evidence |
| Full-stack feature | Shared public contract and separately bounded frontend/backend context | only the capabilities required by each child story | contract tests followed by backend, frontend and end-to-end gates |
| Infrastructure/security | Exact policy and target-specific evidence | privileged or high-risk capabilities | frontier route plus repository-defined security/host checks |

Database, authentication, authorization, deployment, infrastructure and security-sensitive work should remain frontier-only unless the exact narrower capability has explicit repository authorization and fresh qualification evidence.

## Frontend delegation example

The planner should emit a small story body equivalent to:

```yaml
story_id: story_password_form
title: Add the password recovery form
objective: Implement the existing recovery flow in the account UI.
priority: 1
depends_on: []
allowed_changes:
  - path: src/features/account/password-recovery.tsx
    operations: [CREATE]
  - path: tests/account/password-recovery.test.tsx
    operations: [CREATE]
validation_ids: [typecheck, frontend-unit, frontend-build, browser-flow]
acceptance_criteria:
  - Reuses the repository design system and established form pattern.
  - Exposes loading, validation, error and success states.
  - Preserves keyboard operation and accessible names.
  - Does not log or persist recovery secrets.
required_capabilities: [typescript, component_implementation, accessibility]
context_budget_bytes: 32768
max_changed_lines: 160
max_steps: 24
max_attempts: 2
```

The trusted host adds the canonical `story_hash`; the planner cannot authorize paths or validation IDs absent from the work contract. The context should contain the closest accepted examples and public interfaces, not an unrestricted repository dump.

Frontend acceptance should follow the repository's existing architecture and design system. Responsive behavior, accessibility, loading/error/empty states and client/server boundaries become acceptance criteria only when relevant to the requested change. Visual or browser evidence supplements deterministic build/tests; it does not replace them.

## Backend delegation example

```yaml
story_id: story_recovery_api
title: Implement the password recovery endpoint
objective: Add the server-side operation behind the approved recovery contract.
priority: 2
depends_on: [story_recovery_contract]
allowed_changes:
  - path: src/api/account/password-recovery.ts
    operations: [CREATE]
  - path: tests/api/account/password-recovery.test.ts
    operations: [CREATE]
validation_ids: [typecheck, backend-unit, api-contract, integration]
acceptance_criteria:
  - Validates input through the repository's existing schema boundary.
  - Preserves the public error contract without user enumeration.
  - Applies existing authorization, idempotency and audit conventions.
  - Covers accepted, invalid and unauthorized cases.
required_capabilities: [typescript, api_implementation, input_validation]
context_budget_bytes: 32768
max_changed_lines: 180
max_steps: 28
max_attempts: 2
```

The worker must reuse existing transaction, error, logging and dependency-injection patterns. It may not invent credentials, weaken authorization, change a public contract or introduce a migration unless those operations are separately authorized.

## Full-stack decomposition

A full-stack request is not one large story. Prefer this dependency graph:

```text
shared contract/schema
        |
backend implementation
        |
frontend integration
        |
end-to-end validation
```

Each story receives a fresh context and only accepted predecessor receipts. Shared types or schemas are accepted before consumers depend on them. If one worker is qualified for frontend but not backend, the broker may use different exact worker snapshots only through separate plans/runs authorized by routing policy; a plan remains bound to one capability hash.

## Escalation rules

The planner or broker must split, reroute or escalate when:

- a required capability or practice pack is absent or stale;
- the story exceeds qualified file, line, context, step, dependency or attempt limits;
- stack evidence or instruction precedence is ambiguous;
- the change crosses authorization, migration, infrastructure, security or deployment boundaries;
- deterministic validation cannot be expressed from repository policy;
- the same normalized failure repeats to the worker's `NO_PROGRESS` threshold;
- repair would require expanding paths, tools, network or credentials.

Escalation must never be simulated by dynamically adding unqualified skills to the same worker.

## Provider and model replacement

Provider-specific prompt shape and inference controls remain in the replaceable model guidance profile. Practice-pack semantics, story authority and acceptance evidence remain provider-neutral. Changing provider, model revision, harness, parser, tool bundle or instruction bundle produces a new worker capability hash and requires fresh qualification. No pack should contain assumptions that a model is capable merely because of its product name.

## Host-driver checklist

Before unattended use, verify that the driver:

- resolves packs from the exact base SHA and trusted installation;
- hashes the actual bytes presented to the worker;
- enforces context and step budgets outside the model;
- records measured usage and deterministic validation evidence;
- constructs repair packets from persisted validator/reviewer findings;
- opens a fresh worker context per story/attempt;
- routes unsupported or high-risk work to a qualified frontier path;
- keeps credentials, GitHub publication and deployment authority outside every model context.

Runtime V4 now requires a separately certified `practice_pack_resolver` port and binds it into the host-component dependency chain. The repository still does not ship a universal resolver or practice-pack catalog: selection becomes automatic only when the deployed host provides that exact qualified component. Missing or stale resolution remains a fail-closed operational integration gap, never a reason for the coding model to choose its own skills.
