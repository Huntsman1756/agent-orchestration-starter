# Agent Orchestration Starter V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-agnostic CLI that validates semantic agent roles and generates equivalent Codex, OpenCode, and Hermes project configuration.

**Architecture:** A canonical YAML policy is validated and resolved against a replaceable profile. Pure adapter functions compile the resolved roles into harness-native files; filesystem commands add managed-inventory safety around those pure functions.

**Tech Stack:** Node.js 20, TypeScript, `tsx`, Node test runner, Zod, YAML.

## Global Constraints

- Provider and model identifiers may appear only in profiles and generated output, never in stable role policy.
- The orchestrator and reviewer require frontier capability; the executor requires the economy tier.
- The executor model must always be explicit and must not inherit from the parent.
- Authentication and secrets are never generated or persisted.
- Fallback is restricted to typed availability failures.
- Codex, OpenCode, and Hermes outputs must preserve the same role, tier, permission, and validation invariants.

---

### Task 1: Project scaffold and canonical types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/load-config.ts`
- Create: `contracts/orchestration.schema.json`, `contracts/profile.schema.json`
- Test: `tests/load-config.test.ts`

**Interfaces:**
- Produces: `loadPolicy(path): Promise<Policy>` and `loadProfile(path): Promise<ModelProfile>`.

- [ ] Write tests that reject a role with a concrete model and reject a profile missing an explicit executor assignment.
- [ ] Run `npm test -- tests/load-config.test.ts` and confirm the missing implementation fails.
- [ ] Implement Zod schemas and YAML loading with actionable validation errors.
- [ ] Run the focused test and the full test suite.

### Task 2: Role resolution and failure policy

**Files:**
- Create: `src/core/resolve.ts`, `src/core/failures.ts`
- Test: `tests/resolve.test.ts`, `tests/failures.test.ts`

**Interfaces:**
- Produces: `resolveRoles(policy, profile): ResolvedPolicy`.
- Produces: `classifyFailure(input): FailureClass` and `mayFallback(classification): boolean`.

- [ ] Write failing tests for capability mismatch, explicit economy executor selection, independent reviewer selection, and availability-only fallback.
- [ ] Run focused tests and confirm behavioral failures.
- [ ] Implement the smallest resolver and classifier that satisfy the tests.
- [ ] Run focused and full tests.

### Task 3: Harness adapters and parity

**Files:**
- Create: `src/adapters/codex.ts`, `src/adapters/opencode.ts`, `src/adapters/hermes.ts`, `src/adapters/index.ts`
- Test: `tests/adapters.test.ts`, `tests/parity.test.ts`

**Interfaces:**
- Produces: `compileHarness(harness, resolved): GeneratedFile[]` where each file has `path` and `content`.

- [ ] Write failing tests with hand-checked expected files for all three harnesses.
- [ ] Write parity tests that parse generated files and compare role/tier/permission invariants.
- [ ] Run focused tests and confirm missing compilers fail.
- [ ] Implement pure compilers with explicit model, effort, and permissions.
- [ ] Run focused and full tests.

### Task 4: Managed rendering and CLI

**Files:**
- Create: `src/core/inventory.ts`, `src/core/render.ts`, `src/cli/main.ts`
- Test: `tests/render.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: `renderProject(options): Promise<RenderReport>`.
- Produces CLI commands `init`, `render`, `check`, and `doctor`.

- [ ] Write failing tests proving unmanaged files and drifted managed files are never overwritten.
- [ ] Write CLI tests for dry-run output, render, drift detection, and local doctor checks.
- [ ] Run focused tests and confirm missing behavior fails.
- [ ] Implement SHA-256 inventory, atomic per-file writes, and CLI argument parsing.
- [ ] Run focused and full tests.

### Task 5: Examples, documentation, and release verification

**Files:**
- Create: `orchestration.yaml`, `profiles/chatgpt-subscription.yaml`, `profiles/open-compatible.yaml`
- Create: `examples/work-contract.yaml`, `README.md`, `AGENTS.md`, `LICENSE`
- Modify: `package.json`

**Interfaces:**
- Consumes all previous public interfaces.
- Produces a cloneable repository and documented first-run commands.

- [ ] Add profiles and examples that pass `check` without embedding credentials.
- [ ] Document role selection, harness boundaries, update safety, and adding future profiles.
- [ ] Run `npm run validate`.
- [ ] Run a temporary-directory `init`, then `check`, and inspect the generated inventory.
- [ ] Review `git diff --check`, `git status`, and the requirements checklist before reporting completion.
