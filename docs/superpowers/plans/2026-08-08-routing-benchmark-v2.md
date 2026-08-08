# Evidence-Based Routing V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three explicit execution strategies, enforce harness isolation guarantees, produce clean review envelopes, and evaluate provider-neutral benchmark evidence.

**Architecture:** Extend the canonical policy with routing and isolation requirements, compile a writable frontier executor from the existing frontier assignment, and keep provider execution outside the starter. A pure routing evaluator consumes normalized JSONL observations and returns deterministic recommendations against a frontier baseline.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Zod, YAML, `node:test`.

**Status:** Completed on 2026-08-08. Every task below was implemented through observable red-green cycles and verified by the project validation suite.

## Global Constraints

- Provider and model names remain confined to `profiles/*.yaml`.
- Tests and deterministic validators outrank all model verdicts.
- Automatic fallback remains limited to typed availability failures.
- Implementation follows one observable red-green slice at a time.
- No provider credentials, network execution, queue, daemon, or pricing lookup.

---

### Task 1: Strategy-aware policy and generated agents

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/load-config.ts`
- Modify: `src/core/resolve.ts`
- Modify: `contracts/orchestration.schema.json`
- Modify: `orchestration.yaml`
- Modify: `src/adapters/codex.ts`
- Modify: `src/adapters/opencode.ts`
- Modify: `src/adapters/shared.ts`
- Test: `tests/load-config.test.ts`
- Test: `tests/adapters.test.ts`

**Interfaces:**
- Produces: `RoutingStrategy`, `Policy.routing.strategies`, and generated `frontier-executor` agents.
- Consumes: the orchestrator model assignment with executor permissions for frontier execution.

- [ ] Add one loader test that accepts exactly `economy_only`, `orchestrated`, and `frontier_execution`; run it and observe RED.
- [ ] Add the routing types, Zod validation, JSON Schema, and canonical YAML; rerun to GREEN.
- [ ] Add one adapter test requiring writable `frontier-executor` output backed by the frontier model; run it and observe RED.
- [ ] Generate `.codex/agents/frontier-executor.toml` and `.opencode/agents/frontier-executor.md`; rerun to GREEN.
- [ ] Commit with `feat(routing): compile three execution strategies`.

### Task 2: Explicit write-isolation enforcement

**Files:**
- Create: `src/adapters/capabilities.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/core/render.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/adapters/shared.ts`
- Test: `tests/adapters.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/parity.test.ts`

**Interfaces:**
- Produces: `WriteIsolation = 'hard' | 'degraded'`, `CompileOptions.acceptDegradedIsolation`, and manifest fields `requiredWriteIsolation`/`effectiveWriteIsolation`.
- Consumes: `Policy.isolation.required` from Task 1.

- [ ] Add an adapter test proving hard policy rejects Hermes without explicit acceptance; run it and observe RED.
- [ ] Add the capability table (`codex`/`opencode`: hard, `hermes`: degraded) and compilation guard; rerun to GREEN.
- [ ] Add a CLI test for `--accept-degraded-isolation hermes`; run it and observe RED.
- [ ] Thread exact harness-scoped acceptance through render/check and record both isolation levels in manifests; rerun to GREEN.
- [ ] Commit with `feat(isolation): enforce harness write boundaries`.

### Task 3: Clean-context review envelope

**Files:**
- Create: `contracts/review-envelope.schema.json`
- Create: `examples/review-envelope.yaml`
- Modify: `src/adapters/shared.ts`
- Modify: `src/adapters/hermes.ts`
- Test: `tests/adapters.test.ts`

**Interfaces:**
- Produces: generated reviewer instructions that allow only `workContract`, `completeDiff`, `deterministicResults`, and `requestedFiles` as review inputs.

- [ ] Add an adapter test requiring clean-context instructions and excluding planner/executor rationale; run it and observe RED.
- [ ] Add the schema/example and update Codex/OpenCode shared instructions plus Hermes SOUL; rerun to GREEN.
- [ ] Commit with `feat(review): require clean independent context`.

### Task 4: Provider-neutral benchmark evaluator

**Files:**
- Create: `src/routing/types.ts`
- Create: `src/routing/load.ts`
- Create: `src/routing/evaluate.ts`
- Create: `contracts/benchmark-observation.schema.json`
- Create: `contracts/routing-gate.schema.json`
- Create: `routing-gate.yaml`
- Test: `tests/routing.test.ts`

**Interfaces:**
- Produces: `evaluateRouting(observations, gatePolicy): RoutingReport`.
- Consumes: JSONL `BenchmarkObservation` records and YAML `RoutingGatePolicy` thresholds.
- Returns: per-class/per-candidate metrics and `promote | reject | insufficient_evidence` decisions with reason codes.

- [ ] Add a test proving fewer than 30 observations per compared route yields `insufficient_evidence`; run RED, implement parsing/aggregation, run GREEN.
- [ ] Add a test proving a cheaper candidate with equal quality and sufficient samples is promoted; run RED, implement cost-per-finally-accepted-task comparison, run GREEN.
- [ ] Add a test proving escalation remains a first-pass failure and excessive escalation rejects promotion; run RED, implement quality gates, run GREEN.
- [ ] Add schemas and canonical `routing-gate.yaml`; validate them through public loaders.
- [ ] Commit with `feat(benchmark): evaluate accepted-task routing cost`.

### Task 5: Benchmark CLI and documentation

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `README.md`
- Modify: `docs/research/architecture-review.md`
- Create: `examples/benchmark-observations.jsonl`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces: `agent-orchestration benchmark --observations <jsonl> --routing-policy <yaml>` writing a JSON report to stdout.

- [ ] Add a CLI test for deterministic JSON output; run it and observe RED.
- [ ] Implement the command using Task 4 loaders/evaluator; rerun to GREEN.
- [ ] Document the three routes, isolation acceptance, clean review envelope, observation format, and the difference between recommendation and provider execution.
- [ ] Run `npm run validate`, a real benchmark CLI smoke test, and `git diff --check`.
- [ ] Commit with `docs: explain evidence-based routing workflow`.
