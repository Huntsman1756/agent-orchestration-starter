# ArliAI Mechanical/Localized Stage 1 Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute the manual capture tasks task-by-task. The cohort and gate are already frozen; execution must not mutate them.

**Goal:** Measure a first provider-neutral ArliAI cheap-executor cohort without allowing Stage 1 to promote routing or alter production.

**Architecture:** Ten equivalent A/B/C triplets are frozen in `pilot/arli-mechanical-localized-20260809/`. The manifest stores only capability bindings; the resolved provider/model profile is captured in execution evidence. Codex/OpenCode launches each isolated block manually, append-only V3 events record what actually happened, and the offline CLI reduces/evaluates the evidence.

**Tech Stack:** Node 20.20.2, `agent-orchestration-starter/pilot-v3`, YAML manifest/gate, JSON work-contract registry, isolated Git worktrees, Codex/OpenCode manual execution.

## Global Constraints

- Base commit is `6f49ab9f266c5b1ff25f59781d983fcaedafed64`; the frozen manifest hash is `b431cc45d2a7cb6f08f0e3001621d446bf32b6fb8a8a82c3ec9ff8c020d70c96`.
- Exactly 10 triplets / 30 blocks are admitted; Stage 1 has 10 blocks per arm and cannot promote.
- Every block is `mechanical` or `localized`, `low` risk, `cheap_eligible=true`, and changed-line band `1-25`.
- No migrations, public schemas, concurrency, security, architecture, dependency, publication, merge, or deployment work is allowed.
- `binding-cheap-arli-v1` and `binding-strong-review-v1` are capabilities; concrete model aliases are execution evidence, never manifest identity.
- Missing exit status, usage, timestamps, review outcome, or identity is incomplete evidence; the reducer must not infer it.
- Observed token-equivalent usage and fixed subscription allocation remain separate economic views.

---

### Task 1: Verify the frozen cohort before execution

**Files:**
- Read: `pilot/arli-mechanical-localized-20260809/work-contracts.json`
- Read: `pilot/arli-mechanical-localized-20260809/manifest.yaml`
- Read: `pilot/arli-mechanical-localized-20260809/gate.yaml`

- [x] Confirm 10 unique `pair_or_triplet_id` values, 30 blocks, and exactly 10 assignments per arm.
- [x] Confirm every triplet has equal case, contract, base, tree, fixture, stratum, complexity, risk, changed-line band, and validation hashes.
- [x] Confirm `verifyManifest` returns `ok=true` and gate `manifest_hash` equals the manifest hash.

### Task 2: Launch one isolated block at a time

**Inputs:** one work contract from `work-contracts.json`, its manifest block, and the frozen base commit.

- [ ] Create a clean worktree at the frozen base commit with a unique `workspace_instance_id`.
- [ ] Emit `BLOCK_PLANNED`, `ARM_ASSIGNED`, and `ISOLATION_ATTESTED` before implementation.
- [ ] Resolve the capability binding through the current profile. Record the concrete provider/model alias in the execution evidence, without editing the manifest.
- [ ] Run only the target work contract. Execute the exact validation commands declared for that block.
- [ ] Emit execution, validation, usage, review, acceptance/rejection, and parent-rework events. Keep prompts, responses, diffs, credentials, and raw code out of V3 evidence.
- [ ] On missing evidence or a failed validation, record the corresponding fail-closed event; never synthesize success.

### Task 3: Run the bounded strong review

**Inputs:** the block's frozen contract, the executor diff, validation evidence, and V3 event stream.

- [ ] Use the strong reviewer binding with incremental diff mode.
- [ ] Permit at most one cheap repair for B and at most one cheap repair before C escalates to strong, according to the frozen arm route.
- [ ] Record reviewer usage separately from executor usage and preserve rejected/escalated work in operational totals.
- [ ] Keep publication, merge, deployment, and global routing disabled.

### Task 4: Reduce and evaluate Stage 1

**Files:**
- Read: `pilot/arli-mechanical-localized-20260809/manifest.yaml`
- Read: `pilot/arli-mechanical-localized-20260809/gate.yaml`
- Create: a private append-only JSONL event file outside the repository if it contains execution evidence

- [ ] Run `node dist/cli/main.js pilot-v3 evaluate` with the frozen manifest, gate, explicit evaluation ID, and captured events.
- [ ] Check first-pass acceptance, acceptance after one repair, strong-capability tokens per accepted block, wall time per accepted block, parent rework, escaped defects, and completeness denominators.
- [ ] Treat Stage 1 as instrumentation/early-rejection evidence only; do not promote any route from this cohort.
- [ ] Preserve the report and event hash as the baseline for any later Stage 2 expansion; changing the cohort requires a new pilot ID and manifest hash.
