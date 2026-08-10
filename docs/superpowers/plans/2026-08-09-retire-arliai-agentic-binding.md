# Retire ArliAI Agentic Binding Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the unqualified external agentic route from the starter's active design and make executor qualification fail closed.

**Architecture:** Keep the stable policy provider- and model-agnostic. Concrete profiles may select a verified Codex/OpenAI executor, while external agentic bindings remain opt-in and unavailable until an immutable qualification record proves three identical clean tool runs. Patch generation is documented as a separate future capability and cannot reuse the current agentic pilot freeze.

**Tech Stack:** Markdown, YAML profiles, existing Node.js 20 validation suite.

## Global Constraints

- Do not add provider credentials, API keys, or live network probes.
- Do not modify the frozen EduAyudas pilot, its manifest, seed, assignments, or order.
- Do not enable an external provider by default or silently convert textual `<tool_call>` markup into executable calls.
- Concrete provider/model identifiers remain confined to `profiles/*.yaml`.
- Run `npm run validate` before publishing.

### Task 1: Record qualification evidence and policy vocabulary

**Files:**
- Create: `docs/decisions/2026-08-09-external-agentic-binding-qualification.md`
- Modify: `src/core/types.ts`, `src/core/load-config.ts`, `src/core/resolve.ts`, `contracts/profile.schema.json`
- Modify: `tests/resolve.test.ts`

- [x] Record the observed external-binding failures as pre-pilot evidence.
- [x] Add explicit profile capability metadata for verified agentic execution and qualification state.
- [x] Keep the Codex/OpenAI profile usable without claiming an unverified external binding.
- [x] Run the profile/parity tests.

### Task 2: Correct the V4 specification and implementation plan

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-automated-runner-v4-design.md`
- Modify: `docs/superpowers/plans/2026-08-08-automated-runner-v4.md`
- Modify: `README.md`

- [x] Replace the external-model default path with a verified executor binding.
- [x] Require a three-run clean qualification record before any agentic binding can execute.
- [x] Make textual tool-call markup, unexecuted calls, shell failures, and missing diff validation typed invalid-output failures.
- [x] Document patch generation as a separate capability with a new policy/freeze.
- [x] Remove stale live-provider probe and escalation instructions that would invite unsupported external execution.

### Task 3: Validate and publish

- [x] Run `npm run validate` and `git diff --check`.
- [x] Review the diff for scope and credentials.
- [ ] Create one atomic commit, push the branch, and open a draft PR.
