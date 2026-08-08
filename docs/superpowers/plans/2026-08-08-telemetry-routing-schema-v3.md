# Telemetry and Routing Schema V3 Implementation Plan

> **Execution:** Follow this plan with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Use strict red-green-refactor cycles and request independent review after each task boundary.

**Goal:** Implement the provider-neutral V3 pilot contracts, append-only evidence reducer, reproducible economics, and sequential bounded routing evaluator specified in `docs/superpowers/specs/2026-08-08-telemetry-routing-schema-v3-design.md`.

**Architecture:** Add a separate `src/pilot/` domain. Strict JSON Schema and Zod loaders validate frozen manifests and discriminated events; pure functions enforce state, reduce evidence, calculate cost/metrics, and evaluate 10/20/30 stages. V2 remains untouched and provider execution stays outside the repository.

**Tech stack:** TypeScript 5.9, Node.js 20+, Zod 4, AJV 8, YAML, `node:test`, built-in `node:crypto`.

## Global constraints

- No provider SDK, network call, shell runner, queue, daemon, database, credential, real pricing, or concrete model identifier.
- Do not alter V2 types, schemas, CLI semantics, example output, or evaluator behavior.
- Store only bounded IDs, enums, counters, timestamps, durations, and hashes in V3 events; never raw prompts, responses, transcripts, source files, or diffs.
- Deterministic validators and reducer failures are authoritative.
- Keep one repository task and one final atomic implementation commit; do not create intermediate commits for the numbered implementation slices.
- Develop on Node 20 for release evidence. A Node 24 run is diagnostic only.

---

### Task 1: Public V3 contracts and loader parity

**Files:**

- Create: `src/pilot/contracts.ts`
- Create: `src/pilot/load.ts`
- Create: `contracts/pilot-manifest-v3.schema.json`
- Create: `contracts/pilot-event-v3.schema.json`
- Create: `contracts/pilot-block-observation-v3.schema.json`
- Create: `contracts/pilot-routing-gate-v3.schema.json`
- Create: `contracts/pilot-evaluation-report-v3.schema.json`
- Create: `tests/pilot-schema-parity.test.ts`

**Interfaces:**

```ts
loadPilotManifestV3(value: unknown): PilotManifestV3
loadPilotEventV3(value: unknown): PilotEventV3
loadPilotBlockObservationV3(value: unknown): PilotBlockObservationV3
loadPilotRoutingGateV3(value: unknown): PilotRoutingGateV3
loadPilotEvaluationReportV3(value: unknown): PilotEvaluationReportV3
```

- [ ] Write table-driven tests proving each minimal valid document passes both AJV and Zod.
- [ ] Add invalid fixtures for unknown properties, malformed hashes/IDs, model/provider fields, open payloads, invalid thresholds, invalid observed/estimated combinations, missing timestamps, and illegal terminal outcomes. Run the test and record RED.
- [ ] Implement provider-neutral TypeScript vocabulary and strict discriminated Zod unions.
- [ ] Implement matching draft-2020-12 schemas and rerun to GREEN.
- [ ] Add a parity helper that asserts AJV and Zod agree for every fixture.
- [ ] Run `npm test -- tests/pilot-schema-parity.test.ts` and `npm run typecheck`.

### Task 2: Manifest canonicalization, frozen triplets, and assignment

**Files:**

- Create: `src/pilot/canonical-json.ts`
- Create: `src/pilot/manifest.ts`
- Create: `tests/pilot-manifest.test.ts`
- Create: `examples/pilot-manifest-v3.yaml`

**Interfaces:**

```ts
canonicalize(value: unknown): string
hashCanonical(value: unknown): string
freezeManifest(input: PilotManifestInputV3): FrozenPilotManifestV3
assignArms(input: FrozenAssignmentInputV3): ArmAssignmentV3[]
verifyManifest(manifest: PilotManifestV3): ManifestVerification
```

- [ ] Test byte-stable canonical JSON across object key order and explicit exclusion of self-hash fields. Record RED.
- [ ] Test that classification is frozen before arm assignment and that the same seed/version yields the same assignments.
- [ ] Test exact A/B/C membership per `pair_or_triplet_id`, identical matching strata, balanced declared strata, unique block assignments, and rejection of incomplete comparative triplets.
- [ ] Add a mutation matrix that independently changes contract hash, case fingerprint, base revision, fixtures hash, validation surface, complexity, risk, changed-line band, and matching stratum in one triplet member; every mutation must reject equivalence.
- [ ] Add a classification matrix proving `comparative_eligible` implies `cheap_eligible=true`, risk is not restricted, no exclusion reason exists, and direct-to-strong/excluded combinations remain outside comparison.
- [ ] Test direct-to-strong blocks remain descriptive and unassigned to comparative denominators.
- [ ] Test binding registry capability/profile hashes, common reviewer binding/policy, isolation policy, pricing snapshot hash, and typed 10/20/30 thresholds.
- [ ] Implement canonicalization, hashing, deterministic seeded stratified assignment, and verification; rerun all Task 2 tests to GREEN.

### Task 3: Safe append-only event store

**Files:**

- Create: `src/pilot/event-store.ts`
- Create: `src/pilot/sensitive-guard.ts`
- Create: `tests/pilot-event-store.test.ts`

**Interfaces:**

```ts
appendEvent(log: readonly PilotEventV3[], event: PilotEventV3): readonly PilotEventV3[]
activeEvents(log: readonly PilotEventV3[]): readonly PilotEventV3[]
assertSafeEvent(event: PilotEventV3): void
```

- [ ] Test rejection of raw prompt/response/transcript/diff/source/environment fields, secret-bearing keys, known credential-shaped values, overlong strings, and arbitrary payload properties. Record RED.
- [ ] Test globally unique IDs and strictly increasing per-block sequence numbers.
- [ ] Test byte-identical duplicate append is an idempotent no-op; same ID/different content fails.
- [ ] Test explicit `supersedes_event_id` and `EVENT_INVALIDATED` require the expected prior content hash and known event.
- [ ] Test out-of-order correction replay is deterministic and preserves the immutable audit log.
- [ ] Implement the recursive guard, canonical event hash, append logic, and active-event projection; rerun to GREEN.

### Task 4: Normative state machine, review chain, and isolation

**Files:**

- Create: `src/pilot/state-machine.ts`
- Create: `src/pilot/review-packet.ts`
- Create: `tests/pilot-state-machine.test.ts`
- Create: `tests/pilot-review-packet.test.ts`

**Interfaces:**

```ts
transition(state: PilotBlockStateV3 | null, event: PilotEventV3, manifest: PilotManifestV3): PilotBlockStateV3
replayBlock(manifest: PilotManifestV3, events: readonly PilotEventV3[]): PilotBlockReplay
buildReviewPacket(input: ReviewPacketInputV3): ReviewPacketV3
```

- [ ] Encode every row of the normative transition table as a positive test for A, B, and C.
- [ ] Add negative tests for a fourth execution, second cheap repair in C, strong rescue in B, missing C escalation event, wrong attempt/review references, and invalid capability/binding.
- [ ] Test execution `input_revision → output_revision/output_tree_hash` chaining and rejection of unreproducible tree hashes.
- [ ] Test reviewer session differs from the immediately preceding executor, reviewer binding/policy is common across arms, and arbitrary session IDs cannot review another attempt.
- [ ] Test `review_boundary_hash`, from/to revisions, previous-boundary chain, accepted revision/tree, and unresolved finding retention.
- [ ] Test unique clean workspace attestations and reject reused/cross-arm/contaminated workspace IDs.
- [ ] Test `BLOCKED` is terminal, visible, and distinct from `FAILED` and `INVALID`.
- [ ] Generate a negative case for every transition-table guard, including wrong manifest hash, illegal event/state pair, incompatible sequence gap, conflicting terminal, regressive `occurred_at`, wrong start/completion ownership, orphan or misordered validation/usage/rework/finding evidence, and a defect referencing the wrong accepted revision/review.
- [ ] Test review packets contain only allowed hashes, unresolved finding IDs, validation hashes, and bounded context requests.
- [ ] Implement the table-driven reducer and review packet builder; rerun to GREEN.

### Task 5: Reproducible usage and pricing

**Files:**

- Create: `src/pilot/usage-cost.ts`
- Create: `tests/pilot-usage-cost.test.ts`

**Interfaces:**

```ts
priceUsage(usage: UsageRecordedV3, snapshot: PricingSnapshotV3): PricedUsageV3
aggregateUsage(events: readonly UsageRecordedV3[], registry: BindingRegistryV3): UsageAggregateV3
```

- [ ] Test integer micro-unit calculation for input, output, cached-input, and reasoning dimensions.
- [ ] Test observed zero differs from unavailable null.
- [ ] Test a missing tariff-required observed dimension forces `cost_observed=null`.
- [ ] Test authoritative billed cost requires usage ID, currency, amount, provenance, and tariff permission.
- [ ] Test estimated dimensions produce only `cost_estimated`; observed and estimated values are never substituted or summed.
- [ ] Test strong observed/estimated token aggregates and independent completeness ratios from frozen binding capabilities.
- [ ] Test every usage/validation event references an existing attempt, review, or typed orchestrator operation.
- [ ] Implement exact integer arithmetic, provenance, and aggregation; rerun to GREEN.

### Task 6: Canonical block reducer, time, rework, and quality window

**Files:**

- Create: `src/pilot/reducer.ts`
- Create: `tests/pilot-reducer.test.ts`

**Interfaces:**

```ts
reduceEvents(
  manifest: PilotManifestV3,
  events: readonly PilotEventV3[],
): readonly PilotBlockObservationV3[]
```

- [ ] Test canonical byte-stable observations for shuffled input event order.
- [ ] Test an absent, non-canonical, or hash-mismatched embedded pricing snapshot invalidates reduction; a valid embedded snapshot reproduces all priced aggregates.
- [ ] Test `first_pass_accept`, cumulative `accept_after_one_repair`, derived repair rounds, and exact executor initial/final bindings.
- [ ] Test monotonic executor/reviewer durations and null cross-process wall time when UTC provenance is insufficient.
- [ ] Test parent-rework block rate inputs and production/test/docs line totals without treating rework as an executor attempt.
- [ ] Test post-acceptance membership uses `discovered_at`, accepts late recording inside the window, retains out-of-window defects as late telemetry, emits a deterministic stale-decision warning, does not rewrite a historical decision without a new evaluation version, and refuses a bare close boolean.
- [ ] Test any material defect and every high/critical defect are retained after repair.
- [ ] Test invalid/blocked/open-window observations remain visible with reason codes.
- [ ] Implement deterministic reduction and canonical output ordering; rerun to GREEN.

### Task 7: Paired metrics and sequential evaluation

**Files:**

- Create: `src/pilot/metrics.ts`
- Create: `src/pilot/evaluate.ts`
- Create: `tests/pilot-metrics.test.ts`
- Create: `tests/pilot-evaluate.test.ts`
- Create: `examples/pilot-events-v3.jsonl`
- Create: `examples/pilot-routing-gate-v3.yaml`

**Interfaces:**

```ts
computePilotMetrics(manifest: PilotManifestV3, observations: readonly PilotBlockObservationV3[]): PilotMetricsV3
evaluatePilot(manifest: PilotManifestV3, observations: readonly PilotBlockObservationV3[], gate: PilotRoutingGateV3, context: PilotEvaluationContextV3): PilotEvaluationReportV3
appendEvaluation(history: PilotEvaluationHistoryV3, report: PilotEvaluationReportV3): PilotEvaluationHistoryV3
```

- [ ] Test incomplete, blocked, invalid, missing, or open-window triplets are excluded symmetrically while operational costs remain visible.
- [ ] Test final acceptance and final quality use the exact paired numerator rules and report discordant counts.
- [ ] Test parent rework is a block rate and ratio of sums, returning null for zero production lines.
- [ ] Test cost per accepted block retains rejected/escalated/failed attempt costs in the numerator.
- [ ] Test deterministic triplet-level resampling using the frozen seed/version/iterations.
- [ ] Test Stage 1 at 10/arm can only `CONTINUE` or `REJECT`, never promote.
- [ ] Test any material, high, or critical escaped defect in C rejects promotion.
- [ ] Test final quality/acceptance below A, either rework ceiling, wall-time regression, invalid route/reviewer/isolation evidence, and >=10% complete observed cost regression reject.
- [ ] Test Stage 2 at >=20/arm promotes only when every hard gate passes, representation/completeness thresholds pass, and observed cost or observed strong tokens improve by >=15% with non-ambiguous intervals.
- [ ] Test Stage 2 ambiguity continues and Stage 3 at 30/arm terminates as `PROMOTE_BOUNDED`, `REJECT`, or `INCONCLUSIVE`.
- [ ] Test evaluation IDs/versions are append-only, exact prior report hashes are required for supersession, late quality warnings require a new version, and historical reports remain byte-identical.
- [ ] Test promoted strata meet `min_stratum_triplets_for_promotion`; untested systemic/high/restricted/security/irreversible strata remain `NOT_VALIDATED`.
- [ ] Implement metrics, reason codes, deterministic intervals, and stage evaluator; rerun to GREEN.

### Task 8: Separate V3 CLI and compatibility documentation

**Files:**

- Modify: `src/cli/main.ts`
- Create: `src/pilot/index.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `tests/pilot-cli.test.ts`
- Create: `tests/pilot-package-export.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**

```text
agent-orchestration pilot-v3 evaluate \
  --manifest <yaml> \
  --events <jsonl> \
  --gate <yaml>
```

- [ ] Snapshot the existing V2 `benchmark` output before editing; add a regression test requiring it to remain byte-identical.
- [ ] Add a failing CLI test for deterministic V3 JSON output and typed errors for V2/V3 input mismatch.
- [ ] Implement a separate `pilot-v3 evaluate` surface using only loaders/reducer/evaluator from Tasks 1–7.
- [ ] Create the complete `src/pilot/index.ts` barrel, publish it as `./pilot-v3`, build the package, and prove a consumer can import every public V3 function without internal paths.
- [ ] Document manifest freezing, event append workflow, observed/estimated provenance, staged decisions, bounded promotion, and the absence of provider/runtime execution.
- [ ] Prove concrete model/provider names occur only in profiles, not V3 stable contracts or examples.
- [ ] Rerun CLI and full tests to GREEN.

### Task 9: Final integration and release evidence

**Files:**

- Modify only files required by failures caused by Tasks 1–8.

- [ ] Run focused V3 tests first.
- [ ] Run `npm run validate` under Node 20+ and record exact Node/npm versions.
- [ ] Run a real V2 benchmark CLI smoke and compare its canonical output with baseline.
- [ ] Run a synthetic V3 CLI evaluation through manifest → events → reducer → staged report.
- [ ] Run `git diff --check`.
- [ ] Review the final diff for scope, credentials, raw prompts/responses/diffs, generated output, concrete model names outside profiles, and accidental V2 changes.
- [ ] Request independent code review; repair all Critical/Important findings with new red-green evidence.
- [ ] Rerun the complete Node 20 validation after the final repair.
- [ ] Create one atomic conventional commit for `TASK-AGENT-ORCHESTRATION-TELEMETRY-ROUTING-SCHEMA-V3-001` only after all gates pass.

## Stop conditions

Stop and report rather than expanding scope if implementation requires a provider call, real pricing source, runner/worktree automation, database, credential, prompt content store, production routing mutation, or V2 semantic change. Those belong to separate approved tasks.
