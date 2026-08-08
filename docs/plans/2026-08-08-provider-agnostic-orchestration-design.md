# Provider-Agnostic Agent Orchestration Design

## Purpose

`agent-orchestration-starter` is a reusable repository starter for projects that reserve a frontier model for planning and final review while delegating bounded implementation work to a cheaper model. The stable contract describes roles and capabilities; provider and model names live only in replaceable profiles.

## Decisions

- One canonical manifest defines `orchestrator`, `executor`, and `reviewer`.
- The orchestrator is frontier-capable and read-only. It plans, creates work contracts, and accepts or rejects results.
- The executor has workspace write access, receives bounded work contracts, and returns a short operational result.
- The reviewer is independent from the executor and cannot override failed deterministic checks.
- Codex, OpenCode, and Hermes are generated from the same resolved policy.
- Credentials and provider authentication remain local to each harness and are never written by this project.
- Model fallback is allowed only for typed availability failures. Authentication, policy, invalid output, grounding, and validation failures fail closed.
- Every generated artifact records the policy version and a content hash in a managed inventory.

## Canonical data flow

1. Load and validate the policy manifest and a selected model profile.
2. Resolve semantic roles to explicit provider/model assignments.
3. Compile harness-native files without weakening required permissions.
4. Create a self-contained work contract with objective, allowed inputs and files, constraints, validation commands, success criteria, budget, and result schema.
5. Run the executor on the bounded task.
6. Run deterministic validation.
7. Let the frontier reviewer assess the complete diff only after deterministic gates pass.
8. Record attempted and effective role assignments without prompts, secrets, or sensitive content.

## Repository shape

- `contracts/`: canonical schemas and example manifests.
- `profiles/`: replaceable model/provider mappings.
- `src/core/`: validation, role resolution, failure classification, hashing, and inventory.
- `src/adapters/`: Codex, OpenCode, and Hermes compilers.
- `src/cli/`: `init`, `render`, `check`, and `doctor` commands.
- `tests/`: behavior and parity tests with isolated temporary projects.
- `examples/`: a complete starter project configuration.

## Harness boundaries

Codex output uses project-scoped `.codex/agents/*.toml` custom agents and `.codex/config.toml`; provider and authentication stay machine-local. OpenCode output uses `.opencode/agents/*.md` with explicit model and permission frontmatter. Hermes output is a profile distribution containing `distribution.yaml`, `SOUL.md`, and `config.yaml`; credentials remain in Hermes-owned `.env` or auth stores.

If a harness cannot express a required capability or permission, compilation stops with an actionable error. Generated files are never silently weakened.

## Safe installation and updates

`init` and `render` are idempotent. A managed inventory stores relative paths and hashes. Existing unmanaged files are not overwritten. Managed files changed by the user are reported as drift and require an explicit per-file force operation. No command silently edits global harness configuration.

## Verification

Tests cover schema validation, capability-based role resolution, non-inheritance of executor models, fallback classification, generated output, safe overwrite behavior, and cross-adapter policy parity. `doctor` performs local binary/config checks only; authenticated network smoke tests are opt-in and out of scope for v1.

## Non-goals for v1

No daemon, queue, dashboard, billing engine, secret manager, or automatic task runner. The repository compiles and verifies configuration; the selected harness owns execution.
