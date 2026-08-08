# Telemetry and Routing Schema V3 Design

**Task:** `TASK-AGENT-ORCHESTRATION-TELEMETRY-ROUTING-SCHEMA-V3-001`

**Status:** Specification candidate after required amendments

## 1. Objective

Version 3 turns the offline routing evaluator into a reproducible experimental system. It must prove which execution route was assigned, which attempts occurred, what an independent reviewer observed, how much evidence-backed work and cost each role consumed, and whether a candidate route qualifies for bounded promotion.

This task does not execute providers, choose concrete models, modify production routing, merge code, or deploy anything. It defines provider-neutral contracts, pure state transitions, deterministic reduction, and evaluation of pre-recorded pilot evidence.

## 2. Scope

V3 includes:

- a frozen pilot manifest;
- deterministic stratified arm assignment;
- append-only attempt, review, validation, usage, rework, acceptance, and defect events;
- explicit A/B/C state machines with hard attempt ceilings;
- a canonical block observation derived from events;
- observed-versus-estimated token and cost provenance;
- evidence of reviewer session independence and incremental review boundaries;
- parent-rework accounting;
- a bounded post-acceptance quality window;
- sequential 10/20/30-per-arm gates;
- decisions limited to the populations and strata actually tested.

V3 explicitly excludes:

- provider SDKs, network calls, prompt execution, shell adapters, queues, daemons, databases, and credentials;
- live pricing lookup or mutable price aliases;
- concrete model names in stable contracts;
- automatic runtime routing, merge, deployment, publication, or promotion;
- real pilot blocks or production observations;
- automatic conversion of v2 observations into v3 evidence.

## 3. Compatibility and version boundary

The current v2 JSONL reader, evaluator, CLI, schemas, fixtures, and reports remain supported as historical contracts. V3 uses separate schema identifiers, types, loaders, reducer, evaluator, examples, and CLI surface.

There is no implicit v2-to-v3 migration. In particular, V3 must not infer:

- attempt order from `repairCount`;
- executor transitions from `escalated`;
- observed cost from `totalCostUsd`;
- review independence from role or model labels;
- event timestamps or post-acceptance windows from aggregate observations.

The v2 `caseFingerprint` remains the comparison foundation. A V3 block carries a frozen `case_fingerprint` over the work contract, base revision, fixtures/inputs, and relevant policy. Comparable evidence requires the same logical case and fingerprint.

## 4. Stable vocabulary

Stable contracts use capabilities and bindings, never provider or model names.

```text
capability_class:
  cheap
  strong

pilot_arm:
  A_STRONG_BASELINE
  B_CHEAP_NO_EARLY_ESCALATION
  C_ADAPTIVE_EARLY_ESCALATION

complexity_class:
  mechanical
  localized
  cross_file_bounded
  systemic

risk_class:
  low
  medium
  high
  restricted
```

Concrete providers, models, reasoning efforts, and credentials remain in versioned profiles outside the stable schemas. Events record immutable binding references and policy versions sufficient to retrieve the historical profile; they do not make model aliases part of routing semantics.

## 5. Frozen pilot manifest

The manifest is finalized before arm assignment outcomes or execution results are known. Its canonical hash is persisted with every event and observation.

```text
pilot_id
pilot_schema_version = 3
manifest_hash
created_at

blocks[]:
  block_id
  task_id
  matching_stratum
  pair_or_triplet_id
  case_fingerprint
  contract_hash
  base_revision
  fixtures_hash
  complexity_class
  risk_class
  changed_line_band
  validation_surface[]
  cheap_eligible
  comparative_eligible
  routing_selection_reason
  selected_executor_capability_initial
  selected_executor_capability_final_expected
  exclusion_reason | null

assignment_seed
assignment_algorithm_version
arm_assignments[]:
  block_id
  pilot_arm

binding_policy_version
binding_registry[]:
  binding_ref
  capability_class
  profile_hash
routing_reviewer_binding_ref
routing_reviewer_capability
review_mode = incremental_diff
routing_policy_version
review_policy_version
state_machine_version
reducer_version
isolation_policy_version

stage_thresholds
post_acceptance_window
pricing_snapshot
```

### 5.1 Classification and assignment invariants

- Complexity, risk, changed-line band, validation surface, and `cheap_eligible` are frozen before the arm is revealed.
- `comparative_eligible` is true only when `cheap_eligible=true` and the block is not `restricted` or otherwise excluded by predeclared policy.
- A/B/C assignments are randomized deterministically within declared strata using the frozen seed and algorithm version.
- Assignment balances the declared strata; the reducer never reassigns a block after observing an outcome.
- Direct-to-strong blocks may emit descriptive routing telemetry, but never enter the comparative A/B/C denominators.
- Every comparative `pair_or_triplet_id` identifies exactly three equivalent block instances in the same `matching_stratum`: one assigned to A, one to B, and one to C. Equivalence requires the frozen contract, base revision, fixtures, validation surface, complexity, risk, and changed-line band to match under the declared matching algorithm.
- A comparative observation is admitted only as part of a complete valid triplet. An incomplete triplet remains visible but contributes to no arm denominator.
- The manifest must fail validation if one block appears in more than one arm or if a comparative block lacks an assignment.
- Changes produce a new manifest hash and a new pilot version; an existing manifest is never edited in place after execution begins.
- `manifest_hash` is the canonical SHA-256 of the manifest with `manifest_hash` itself omitted. Canonicalization and hash algorithm are versioned.
- The binding registry freezes capability and profile identity. Events may reference only a registered binding, and its capability must match the assigned arm transition.
- One reviewer binding, capability, review policy, and incremental review mode are frozen for the comparative pilot. Every A/B/C member of every triplet uses them; a mismatched reviewer invalidates the triplet. Reviewer session IDs still remain distinct per review execution.
- Every comparative block instance declares an isolated workspace/checkout identity and must later provide a hash-only isolation attestation under the frozen isolation policy. Absence or cross-arm contamination invalidates the complete triplet.

## 6. Experimental arms

The comparative population contains only blocks classified as cheap-eligible before assignment.

```text
A_STRONG_BASELINE
  implementation: strong
  repair_1: strong
  final execution if needed: strong

B_CHEAP_NO_EARLY_ESCALATION
  implementation: cheap
  repair_1: cheap
  final execution if needed: cheap

C_ADAPTIVE_EARLY_ESCALATION
  implementation: cheap
  repair_1: cheap
  escalated execution after second rejection: strong
```

The comparison therefore isolates the value of early escalation for work that could reasonably start on a cheap executor. It does not combine that experiment with direct-to-strong pre-routing.

## 7. Append-only event log

Events are immutable JSONL records. Corrections are new superseding or invalidating events; prior records remain intact. Every event carries:

```text
schema_version = 3
event_id
event_type
pilot_id
manifest_hash
task_id
block_id
matching_stratum
pair_or_triplet_id
case_fingerprint
pilot_arm | null
sequence_number
occurred_at
recorded_at
producer_id
payload: event-type-specific strict payload
```

`PilotEventV3` is a discriminated union on `event_type`. Every payload schema is closed (`additionalProperties: false` / strict runtime equivalent) and permits only the hashes, IDs, enums, counters, durations, timestamps, and bounded finding metadata named in this specification. Raw prompts, model responses, reasoning transcripts, source files, complete diffs, credentials, environment values, and unbounded arbitrary metadata are forbidden. A recursive guard rejects secret-bearing keys such as token, password, credential, authorization, cookie, environment, prompt, response, transcript, and raw diff; permitted strings are length-bounded and rejected when they match the versioned credential-pattern policy. Values intended as evidence are content-addressed outside the event and represented only by a hash plus an approved evidence kind.

Finding records contain only `finding_id`, severity, material flag, category code, status, and evidence hashes. Human prose belongs in the external evidence object, never the event log.

### 7.1 Ordering and identity

- `event_id` is globally unique.
- `(pilot_id, block_id, sequence_number)` is unique and strictly increasing.
- Reduction orders by `sequence_number`; timestamps are evidence, not the ordering authority.
- Duplicate `event_id`, gaps where the transition requires a predecessor, mismatched manifest hashes, or conflicting terminal events fail closed.
- An event cannot silently replace an earlier event.
- `recorded_at` may be later than `occurred_at`, including after a quality window closes, but does not change window membership. Regressive `occurred_at` values are rejected when they contradict state order; late recording is reported as telemetry lag.

### 7.2 Event types

The minimum event set is:

```text
BLOCK_PLANNED
ARM_ASSIGNED
ISOLATION_ATTESTED
EXECUTION_STARTED
EXECUTION_COMPLETED
REVIEW_STARTED
REVIEW_COMPLETED
VALIDATION_RECORDED
USAGE_RECORDED
PARENT_REWORK_RECORDED
BLOCK_ACCEPTED
BLOCK_FAILED
BLOCK_BLOCKED
ESCALATION_DECIDED
POST_ACCEPT_DEFECT_RECORDED
EVENT_INVALIDATED
```

Each execution event identifies:

```text
attempt_id
attempt_number
attempt_kind: IMPLEMENTATION | REPAIR_1 | FINAL_EXECUTION
executor_capability: cheap | strong
executor_binding_ref
executor_session_id
input_revision
output_revision
output_tree_hash
output_diff_hash
changed_lines_production
changed_lines_tests
changed_lines_docs
outcome
started_monotonic_ms
finished_monotonic_ms
duration_ms
```

`input_revision` and `output_revision` are immutable content-addressed workspace revision IDs. `output_tree_hash` is calculated by the versioned canonical tree algorithm over the allowed workspace, excluding declared volatile paths. A completion is invalid when its revision/tree proof does not reproduce.

Monotonic values are relative to a named process clock and must satisfy `finished >= started` and `duration = finished - started`. Cross-process wall time uses the minimum recorded UTC start and maximum UTC finish, reports clock provenance, and is null if it cannot be proven. It is never reconstructed from mutable log arrival time.

Each review event identifies:

```text
review_id
review_round
reviewer_binding_ref
reviewer_session_id
reviewed_attempt_id
executor_session_id_reviewed
review_input_diff_hash
previous_review_boundary_hash | null
review_boundary_hash
review_boundary_from_revision
review_boundary_to_revision
unresolved_finding_ids[]
validation_evidence_hashes[]
bounded_context_hashes[]
additional_context_requests[]
material_findings[]
non_material_findings[]
decision: ACCEPT | REJECT
started_monotonic_ms
finished_monotonic_ms
duration_ms
```

`review_boundary_hash` is the canonical SHA-256 of `(pilot_id, block_id, review_id, reviewed_attempt_id, review_boundary_from_revision, review_boundary_to_revision, review_input_diff_hash, unresolved_finding_ids, validation_evidence_hashes)` using the versioned canonical JSON algorithm. REVIEW_1 starts at the frozen base revision. Every review's `review_boundary_to_revision` must equal the `output_revision` of its `reviewed_attempt_id`, whose canonical tree matches `output_tree_hash`. Each later boundary starts at the immediately preceding `review_boundary_to_revision`, and `previous_review_boundary_hash` references the immediately preceding emitted boundary hash.

Findings have stable IDs and severity. A later review must explicitly resolve or retain every unresolved material finding; it cannot make findings disappear by omission.

`ESCALATION_DECIDED` records the rejected review event, `escalation_reason`, target registered binding, target capability, and decision policy version. It must precede C's final strong execution. The reducer never infers an auditable escalation decision solely from attempt count.

`ISOLATION_ATTESTED` records `workspace_instance_id`, `base_revision`, `clean_tree_hash`, `isolation_policy_version`, `attestor_id`, and a hash of the bounded attestation evidence. A workspace instance is unique to one block/arm execution and may not appear in another arm. Each instance must begin from the frozen base revision and clean-tree hash; a later event may attest contamination and invalidate the triplet. The event stores no filesystem contents.

`USAGE_RECORDED` requires `usage_id` and exactly one owning `attempt_id` or `review_id` (or a typed orchestrator operation ID). `VALIDATION_RECORDED` requires a validation ID and the `attempt_id` whose output was validated. Findings and parent rework similarly reference the exact review, attempt, or accepted revision they concern; orphan evidence is reducer-invalid.

`BLOCK_BLOCKED` records a typed external or environmental cause which is neither a quality failure nor invalid telemetry. Blocked work remains visible, retains consumed resources, and is excluded from comparative quality and promotion denominators together with its entire triplet.

`EVENT_INVALIDATED` contains `invalidated_event_id`, expected event content hash, and a reason code. A correcting event may carry `supersedes_event_id` plus the expected prior content hash. Appending a byte-identical event with an existing `event_id` is an idempotent no-op; reusing an `event_id` for different content fails closed. Invalidating or superseding an unknown or hash-mismatched event fails closed.

## 8. State machines and attempt ceilings

The reducer, not prose, enforces the route assigned in the manifest.

```text
PLANNED
→ EXECUTING_1
→ REVIEW_1
   ├─ ACCEPTED
   ├─ BLOCKED
   └─ EXECUTING_2_REPAIR
      → REVIEW_2
         ├─ ACCEPTED
         ├─ BLOCKED
         └─ EXECUTING_3_FINAL
            → FINAL_REVIEW
               ├─ ACCEPTED
               ├─ BLOCKED
               └─ FAILED
```

Hard invariants:

- At most three execution attempts exist for any arm.
- There is at most one repair attempt before the terminal execution.
- A fourth execution attempt is schema-valid as an event shape but reducer-invalid for the block history.
- A rejected second review moves C to a strong final execution; the cheap executor cannot run again.
- C's final execution is legal only after a valid `ESCALATION_DECIDED` event targeting a registered strong binding.
- A and B keep their arm capability for the third execution.
- B never receives an unrecorded strong rescue. A strong B attempt makes the block invalid for comparative evaluation.
- `first_pass_accept` means REVIEW_1 accepted.
- `accept_after_one_repair` is cumulative: REVIEW_1 accepted, or REVIEW_2 accepted after exactly one repair.
- `accepted_on_repair_1` is derived as `accept_after_one_repair && !first_pass_accept`; it is not persisted.
- `repair_rounds` is derived from accepted execution events, not supplied by a caller.
- Parent/orchestrator edits are orthogonal evidence and never masquerade as another executor attempt.
- A blocked block has terminal state `BLOCKED`; it is not coerced to `FAILED` or `INVALID`.

Invalid histories are preserved for audit but excluded from promotion denominators with deterministic reason codes.

### 8.1 Normative transition table

The following table is authoritative; the diagram is explanatory. `attempt_id` and `review_id` are unique per block, and every completion references its corresponding start ID.

| Current state | Event | Next state | Required guards |
|---|---|---|---|
| none | `BLOCK_PLANNED` | `PLANNED` | block and manifest hashes match |
| `PLANNED` | `ARM_ASSIGNED` | `ASSIGNED` | assignment equals frozen manifest |
| `ASSIGNED` | `ISOLATION_ATTESTED` | `READY_1` | unique workspace, frozen base and clean-tree hashes |
| `READY_1` | `EXECUTION_STARTED` | `EXECUTING_1` | attempt 1, kind implementation, arm capability, input is frozen base revision |
| `EXECUTING_1` | `EXECUTION_COMPLETED` | `READY_REVIEW_1` | same attempt ID/session; monotonic duration valid |
| `READY_REVIEW_1` | `REVIEW_STARTED` | `REVIEWING_1` | review 1, frozen reviewer, distinct session, references attempt 1 and its output revision/tree |
| `REVIEWING_1` | `REVIEW_COMPLETED(ACCEPT)` | `READY_ACCEPT` | same review ID; boundary valid; no unresolved material finding |
| `REVIEWING_1` | `REVIEW_COMPLETED(REJECT)` | `READY_2` | same review ID; boundary valid; findings explicit |
| `READY_2` | `EXECUTION_STARTED` | `EXECUTING_2` | attempt 2, kind repair 1, arm capability, input equals REVIEW_1 boundary target |
| `EXECUTING_2` | `EXECUTION_COMPLETED` | `READY_REVIEW_2` | same attempt ID/session; monotonic duration valid |
| `READY_REVIEW_2` | `REVIEW_STARTED` | `REVIEWING_2` | review 2, frozen reviewer, distinct session, references attempt 2 output revision/tree, boundary chain valid |
| `REVIEWING_2` | `REVIEW_COMPLETED(ACCEPT)` | `READY_ACCEPT` | same review ID; no unresolved material finding |
| `REVIEWING_2` | `REVIEW_COMPLETED(REJECT)` | `ESCALATION_REQUIRED` | arm C only |
| `REVIEWING_2` | `REVIEW_COMPLETED(REJECT)` | `READY_3` | arm A or B only |
| `ESCALATION_REQUIRED` | `ESCALATION_DECIDED` | `READY_3` | arm C; target is registered strong binding; rejected review referenced |
| `READY_3` | `EXECUTION_STARTED` | `EXECUTING_3` | attempt 3, kind final execution; A strong, B cheap, C strong; input equals REVIEW_2 boundary target |
| `EXECUTING_3` | `EXECUTION_COMPLETED` | `READY_FINAL_REVIEW` | same attempt ID/session; monotonic duration valid |
| `READY_FINAL_REVIEW` | `REVIEW_STARTED` | `FINAL_REVIEWING` | review 3, frozen reviewer, distinct session, references attempt 3 output revision/tree, boundary chain valid |
| `FINAL_REVIEWING` | `REVIEW_COMPLETED(ACCEPT)` | `READY_ACCEPT` | same review ID; no unresolved material finding |
| `FINAL_REVIEWING` | `REVIEW_COMPLETED(REJECT)` | `READY_FAIL` | same review ID; findings explicit |
| `READY_ACCEPT` | `BLOCK_ACCEPTED` | `ACCEPTED` | accepted revision and tree hash equal the accepted review boundary target and reviewed attempt output |
| `READY_FAIL` | `BLOCK_FAILED` | `FAILED` | terminal failure reason code present |
| any non-terminal state | `BLOCK_BLOCKED` | `BLOCKED` | typed external/environment reason and evidence hash |
| `ACCEPTED` | `POST_ACCEPT_DEFECT_RECORDED` | `ACCEPTED` | accepted revision and window timestamps referenced |

`USAGE_RECORDED`, `VALIDATION_RECORDED`, and `PARENT_REWORK_RECORDED` do not change control state, but are accepted only when their referenced operation exists and their sequence position is compatible with it. `EVENT_INVALIDATED` causes deterministic replay without the invalidated event; an impossible replay yields `INVALID`. No other event/state pair is legal.

## 9. Independent incremental review

Every review runs in a session distinct from the executor session being reviewed:

```text
reviewer_session_id != executor_session_id_reviewed
```

This invariant applies even if bindings resolve to the same underlying provider or model. Binding inequality is not required; context independence is.

The reducer also requires:

- non-empty executor and reviewer session IDs;
- `executor_session_id_reviewed` equals the session of the immediately preceding completed execution;
- a reviewer session is stable for one review round and cannot be reused as that block's executor session;
- REVIEW_1 has a null previous boundary;
- each later review's `previous_review_boundary_hash` equals the canonical boundary hash emitted by the immediately preceding review;
- `review_input_diff_hash` identifies only changes after that boundary;
- a broken boundary chain invalidates the block history.

The reviewer receives only the evidence envelope for that round:

- frozen work contract and hashes;
- current diff since the previous review boundary;
- unresolved findings;
- new deterministic validation evidence;
- explicitly requested bounded context.

Executor reasoning, hidden transcript, and earlier reviewer chain-of-thought are not review inputs. `previous_review_boundary_hash` and `review_input_diff_hash` make incremental review reproducible without forcing the reviewer to reread the whole task.

The reviewer is read-only. If the orchestrator or reviewer modifies code, the change is recorded as parent rework.

## 10. Usage and reproducible cost

Usage is recorded per provider call or other independently billable operation. Observed and estimated dimensions are never merged.

The manifest embeds an immutable pricing snapshot. V3 does not permit an unresolved external pricing reference, so the offline reducer always receives the exact tariff content through the verified manifest:

```text
pricing_snapshot:
  pricing_snapshot_id
  pricing_snapshot_hash
  currency
  unit_scale: integer micro-units per currency unit
  effective_at
  tariffs[]:
    binding_ref
    input_token_micro_units_per_token
    output_token_micro_units_per_token
    cached_input_token_micro_units_per_token | null
    reasoning_token_micro_units_per_token | null
    authoritative_charge_supported
```

Every tariff references a frozen binding registry entry. Integer micro-units avoid binary floating-point ambiguity. The snapshot hash covers canonical snapshot content excluding its own hash.

```text
usage_id
attempt_number
role: orchestrator | executor | reviewer
binding_ref
provider_usage_id | null

input_tokens_observed | null
output_tokens_observed | null
cached_input_tokens_observed | null
reasoning_tokens_observed | null

input_tokens_estimated | null
output_tokens_estimated | null
cached_input_tokens_estimated | null
reasoning_tokens_estimated | null

token_estimator_id | null
token_estimator_version | null
pricing_snapshot_id
cost_observed | null
cost_estimated | null
currency
cost_provenance
```

Rules:

- Zero means the provider authoritatively reported zero; unavailable means `null`.
- An observed dimension is never filled from an estimator.
- `cost_observed` is non-null only when the frozen pricing snapshot and all dimensions required by that tariff reproduce the charge, or an authoritative billed amount is linked by provenance.
- If a provider exposes only total tokens and that is insufficient for its tariff, `cost_observed=null`.
- `cost_estimated` uses only estimated dimensions and a named estimator/pricing snapshot.
- Aggregates keep observed and estimated costs separate. They never substitute one for the other to improve completeness.
- Completeness ratios are reported for every economic comparison.
- A pricing snapshot is immutable content addressed data; mutable aliases and live lookup are out of scope.
- An authoritative billed amount may set `cost_observed` only when `provider_usage_id`, currency, amount, and provenance are present and the tariff permits authoritative charges; otherwise observed cost is recomputed dimensionally.
- Strong-token aggregation is split into `strong_tokens_observed` and `strong_tokens_estimated`, each by input/output/cached/reasoning dimension with its own completeness ratio. Observed and estimated strong tokens are never added together or substituted.

## 11. Parent rework

Parent rework records direct code changes by the orchestrator/reviewer or a human acting in that corrective role after executor output:

```text
files_production[]
files_tests[]
files_docs[]
lines_production
lines_tests
lines_docs
diff_hash
actor_role
reason_code
```

Derived arm metrics:

```text
parent_rework_block_rate =
  blocks_with_parent_rework / comparable_blocks

parent_rework_production_line_share =
  sum(parent_rework_lines_production)
  / sum(all_changed_lines_production)
```

The production-line metric is a ratio of sums, never the mean of per-block ratios. If an arm has zero production lines, the share is `null`, not zero and not a division error.

## 12. Post-acceptance quality window

The manifest freezes a post-acceptance observation window using an explicit duration and closing rule. A block is not quality-complete until the window closes or the pilot records a terminal material defect.

```text
accepted_at
window_opens_at = accepted_at
window_closes_at
window_policy_version

defect_id
severity: low | medium | high | critical
material
discovered_at
evidence_id
affected_revision
category_code
```

Defects are appended after acceptance and retained even if later repaired. High or critical escaped defects in C prohibit promotion. Lower severity defects remain in incidence and quality comparisons.

Window membership uses `discovered_at`, not `recorded_at`: `window_opens_at <= discovered_at <= window_closes_at`. A defect recorded late but discovered inside the window counts. A defect discovered after closure is retained as late quality telemetry, triggers a stale-decision warning if a decision already exists, and does not rewrite the historical decision without a new evaluation version.

For this pilot, promotion requires `escaped_material_defects(C)=0` regardless of severity. The separate high/critical zero gates remain explicit because they also cause immediate Stage 1 rejection and preserve severity-specific governance.

Blocks whose quality window remains open can appear in operational dashboards but do not count as promotion-ready samples. A manifest declares the duration, allowed clock skew, closure rule, and late-evidence policy; a bare boolean cannot close a window without the timestamps.

## 13. Canonical block observation V3

The deterministic reducer derives one observation per `(pilot_id, block_id, manifest_hash)`:

```text
schema_version = 3
pilot_id
manifest_hash
task_id
block_id
matching_stratum
pair_or_triplet_id
case_fingerprint
pilot_arm
complexity_class
risk_class
changed_line_band
cheap_eligible
comparative_eligible

state
valid_history
invalid_reason_codes[]
executor_binding_initial
executor_binding_final
reviewer_binding_refs[]
execution_attempts
repair_rounds
escalated
escalation_reason | null
first_pass_accept
accept_after_one_repair
final_accepted

tests_initially_failing
tests_finally_passing
review_findings_material
review_findings_non_material

parent_rework_files
parent_rework_lines_production
parent_rework_lines_tests
parent_rework_lines_docs

changed_lines_production
changed_lines_tests
changed_lines_docs

orchestrator_usage
executor_usage
reviewer_usage
total_usage
cost_observed | null
cost_estimated | null
cost_completeness

wall_time_seconds
executor_time_seconds
review_time_seconds

post_acceptance_window_closed
accepted_at | null
window_opens_at | null
window_closes_at | null
post_accept_defects[]
post_accept_defects_count
post_accept_max_severity | null
late_quality_evidence_count
quality_warnings[]
final_outcome: ACCEPTED | FAILED | BLOCKED | INVALID
```

The reducer output is deterministic: the same manifest, event set, reducer version, and pricing snapshot produce byte-stable canonical JSON.

## 14. Metrics

Metrics always expose numerator, denominator, completeness, and interval where meaningful.

Primary quality metrics:

```text
final_acceptance_rate
escaped_material_defect_rate
escaped_high_defects
escaped_critical_defects
```

Efficiency metrics:

```text
wall_time_per_accepted_block
observed_cost_per_accepted_block
estimated_cost_per_accepted_block
strong_tokens_observed_per_accepted_block
strong_tokens_estimated_per_accepted_block
total_tokens_per_accepted_block
```

Routing diagnostics:

```text
first_pass_accept_rate
accept_after_one_repair_rate
escalation_rate
parent_rework_block_rate
parent_rework_production_line_share
```

`first_pass_accept_rate` is diagnostic, not a hard promotion gate. A route with lower first-pass acceptance may still win if bounded escalation preserves final quality while improving cost or strong-model use.

Rejected, failed, and escalated attempts retain their time, tokens, and cost in arm totals. Cost per accepted block divides all arm cost by finally accepted comparable blocks; failed work never disappears from the numerator.

## 15. Sequential benchmark gates

The frozen threshold contract is typed:

```text
stage_thresholds:
  stage_1_blocks_per_arm = 10
  stage_2_blocks_per_arm = 20
  stage_3_max_blocks_per_arm = 30
  material_improvement_rate = 0.15
  economic_rejection_rate = 0.10
  max_parent_rework_block_rate = 0.10
  max_parent_rework_production_line_share = 0.10
  max_escaped_material_defects = 0
  max_escaped_high_defects = 0
  max_escaped_critical_defects = 0
  min_observed_cost_completeness
  min_observed_strong_token_completeness
  min_stratum_triplets_for_promotion
  confidence_level
  interval_algorithm_version
  resampling_iterations
```

The last six values are required, range-validated, and frozen before results. Neither observed completeness threshold can be zero; `min_stratum_triplets_for_promotion` cannot exceed the current stage size. The canonical pilot profile supplies concrete values, while the stable contract remains reusable.

Only complete triplets of comparable, valid-history, quality-window-closed blocks count. If any A/B/C member is `BLOCKED`, `INVALID`, missing, or has an open quality window, the entire triplet is excluded from every arm's decision denominator and reported by exclusion reason. Consumed resources remain visible in operational totals.

The paired quality rule is pre-registered and deterministic:

```text
final_acceptance_quality(block) = final_accepted

final_quality_success(block) =
  final_accepted
  AND escaped_material_defects_in_window = 0

final acceptance C >= A iff
  sum_C(final_acceptance_quality) >= sum_A(final_acceptance_quality)
  over the same admitted triplets

final quality C >= A iff
  sum_C(final_quality_success) >= sum_A(final_quality_success)
  over the same admitted triplets
```

Equality passes these two non-inferiority point gates. High/critical and parent-rework gates remain independent. Every report includes paired discordant counts, raw numerators/denominators, and exclusions.

Uncertainty is computed by deterministic triplet-level resampling using the frozen seed, algorithm version, iteration count, and confidence level. All three arms of a sampled triplet move together. At Stage 2, if point gates pass but the confidence interval for the selected efficiency improvement crosses 15%, or the interval for either paired quality difference crosses zero, the result is `CONTINUE` to Stage 3 rather than promotion. At Stage 3 the same ambiguity yields terminal `INCONCLUSIVE`.

### 15.1 Stage 1: 10 blocks per arm

Purpose: validate instrumentation and allow early rejection. Promotion is impossible at Stage 1.

Stop/reject C early when any hard condition is met:

- one escaped high or critical material defect;
- any escaped material defect in C;
- final quality is below A under the predeclared quality rule;
- parent rework exceeds either 10% ceiling;
- sufficiently complete observed cost per accepted block is at least 1.10 times A;
- event integrity, session independence, or route conformance is materially invalid.

If hard gates pass, continue to Stage 2. Passing Stage 1 means `CONTINUE`, never `PROMOTE`.

### 15.2 Stage 2: at least 20 blocks per arm

Bounded promotion is permitted only when every hard gate passes and C demonstrates at least one material efficiency improvement:

```text
observed_cost_per_accepted_block(C) <= 0.85 × A
OR
strong_tokens_observed_per_accepted_block(C) <= 0.85 × A
```

The observed-cost branch is usable only when the manifest's completeness threshold is satisfied. The strong-token branch is usable only when its observed dimensional completeness threshold is satisfied. Estimated cost and estimated strong tokens are reported separately but cannot silently satisfy an observed gate.

All promotion conditions:

- escaped material defects in C = 0;
- escaped high defects in C = 0;
- escaped critical defects in C = 0;
- final quality C >= A;
- final acceptance C >= A under the paired quality rule;
- parent rework block rate C <= 10%;
- parent rework production line share C <= 10% when defined;
- wall time C <= A;
- material efficiency improvement >=15% in observed cost or observed strong-token consumption;
- no invalid route histories or reviewer-session violations in the promotion population.

Economic rejection as the global cost-saving default occurs when sufficiently complete observed cost per accepted block C is at least 1.10 times A. C may remain a named speed/quality route only through a separate future policy decision; this pilot does not promote it economically.

Values between the 15% improvement boundary and the 10% regression boundary are economically inconclusive.

### 15.3 Stage 3: up to 30 blocks per arm

Stage 3 is used only when Stage 2 is inconclusive or intervals remain too wide under the frozen decision rule. It adds blocks without changing strata, thresholds, pricing snapshot, or assignment algorithm. At 30 per arm the evaluator returns `PROMOTE_BOUNDED`, `REJECT`, or `INCONCLUSIVE`; it does not continue indefinitely.

## 16. Bounded promotion

Promotion applies only to adequately sampled strata inside the comparative population, for example:

```text
PROMOTED_FOR:
  mechanical / low-medium
  localized / low-medium
  cross_file_bounded / sufficiently sampled strata

NOT_VALIDATED:
  systemic
  high
  restricted
  security-sensitive
  irreversible-data
```

The evaluator emits exact promoted strata and unsupported strata. It never converts a win on cheap-eligible blocks into a global default. Direct-to-strong telemetry is descriptive and cannot expand the promotion population.

## 17. Deterministic decisions and reason codes

The evaluator returns:

```text
evaluation_id
evaluation_version
evaluated_at
supersedes_evaluation_id | null
stage: 1 | 2 | 3
decision:
  CONTINUE
  PROMOTE_BOUNDED
  REJECT
  INCONCLUSIVE
  INSUFFICIENT_EVIDENCE
promoted_strata[]
not_validated_strata[]
reasons[]
metrics
denominators
completeness
warnings[]
```

Evaluation reports form a separate append-only history. `(pilot_id, evaluation_version)` and `evaluation_id` are unique. A new report may supersede exactly one hash-verified prior report; the prior report remains byte-identical. Late quality evidence adds a stale-decision warning to the next observation/evaluation but cannot mutate a stored report. Reusing an evaluation ID/version with different content fails closed.

Reason codes are stable machine-readable identifiers. Minimum codes include:

```text
stage_1_cannot_promote
insufficient_comparable_samples
quality_window_open
invalid_event_history
route_capability_violation
reviewer_session_not_independent
review_boundary_chain_invalid
comparative_workspace_not_isolated
high_post_accept_defect
critical_post_accept_defect
material_post_accept_defect
final_quality_below_baseline
final_acceptance_below_baseline
parent_rework_block_rate_above_maximum
parent_rework_line_share_above_maximum
wall_time_above_baseline
observed_cost_incomplete
economic_regression_above_rejection_threshold
material_cost_improvement
material_strong_token_improvement
decision_remains_ambiguous
```

Deterministic failures are authoritative and cannot be overridden by reviewer or orchestrator judgment.

## 18. Public contracts and implementation boundaries

The implementation plan should introduce separate V3 modules and public schemas, approximately:

```text
src/pilot/contracts.ts
src/pilot/manifest.ts
src/pilot/state-machine.ts
src/pilot/event-store.ts
src/pilot/review-packet.ts
src/pilot/usage-cost.ts
src/pilot/reducer.ts
src/pilot/metrics.ts
src/pilot/evaluate.ts

contracts/pilot-manifest-v3.schema.json
contracts/pilot-event-v3.schema.json
contracts/pilot-block-observation-v3.schema.json
contracts/pilot-routing-gate-v3.schema.json
contracts/pilot-evaluation-report-v3.schema.json
```

JSON Schema and runtime loader invariants must have parity tests. Pure functions should expose at least:

```text
freezeManifest(input) -> FrozenPilotManifest
assignArms(manifestInput) -> ArmAssignment[]
transition(state, event) -> PilotBlockState
appendEvent(log, event) -> EventLog
reduceEvents(manifest, events) -> PilotBlockObservationV3[]
evaluatePilot(manifest, observations, gatePolicy, evaluationContext) -> PilotEvaluationReportV3
appendEvaluation(history, report) -> PilotEvaluationHistoryV3
```

An append-only in-memory/file-backed test store is sufficient. No database or remote event service belongs in this task.

The existing `benchmark` command remains the unchanged V2 surface. V3 is exposed through a separate command or explicit `--schema-version 3` entry point that cannot reinterpret V2 input. Compatibility tests must prove the existing V2 CLI output is unchanged.

## 19. Acceptance criteria

The future implementation is acceptable only when tests prove:

- frozen classification precedes arm visibility and assignment is deterministic;
- only preclassified cheap-eligible blocks enter A/B/C comparisons;
- comparative evidence forms complete exact A/B/C triplets within a frozen matching stratum;
- every comparative block has a unique clean isolation attestation and no arm can observe another arm's workspace;
- manifest mutation changes its hash and cannot rewrite existing evidence;
- all three arms enforce exact capability sequences and a three-attempt maximum;
- C cannot perform a second cheap repair after REVIEW_2 rejection;
- C requires an explicit escalation decision before its final strong execution;
- B cannot hide a strong rescue;
- every arm uses the frozen common reviewer capability/policy; reviewer and immediately preceding executor session IDs must differ and review boundary hashes must form a valid chain;
- incremental review packets contain only allowed evidence;
- observed and estimated token dimensions remain distinct;
- observed cost is null when tariff reproduction lacks a required dimension;
- pricing snapshots make cost reduction reproducible;
- observed and estimated strong-token gates remain separate and completeness-bounded;
- parent rework uses rate and ratio-of-sums definitions;
- post-acceptance high/critical defects prevent promotion;
- every escaped material defect in C prevents promotion;
- late quality evidence emits a warning and requires a new append-only evaluation version rather than rewriting history;
- `accept_after_one_repair` is cumulative and derived correctly;
- Stage 1 can reject or continue but never promote;
- Stage 2 can promote only with all hard gates and >=15% material improvement;
- >=10% observed economic regression rejects cost-default promotion;
- Stage 3 is terminal at 30 blocks per arm;
- promotion lists only sufficiently sampled tested strata;
- V2 continues to read and evaluate historical fixtures unchanged;
- malformed, duplicated, reordered, or conflicting event histories fail closed;
- blocked blocks and their complete triplets are visible but excluded symmetrically from decision denominators;
- event correction/invalidation is explicit, content-hash checked, and idempotent;
- public JSON schemas and runtime loaders reject the same contract violations;
- canonical reduction is byte-stable for identical inputs;
- `npm run validate` passes on Node 20+.

## 20. Deferred work

After V3 contracts and pure evaluation are implemented and independently reviewed, a separate pilot-runner task may execute frozen blocks in isolated worktrees, append events, and call the reducer. That runner remains distinct from an automatic production orchestrator and receives no merge, deployment, or global-routing authority.
