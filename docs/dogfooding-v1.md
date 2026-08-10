# Controlled dogfooding protocol V1

This protocol freezes the first real-runtime dogfooding experiment. It is
provider-neutral and repository-independent: a project supplies the exact
hashes and task corpus, while the control rules stay unchanged.

The experiment compares only the two fixed strategies:

```text
orchestrated       ↔       frontier_execution
```

It is an evidence-gathering pilot, not a routing-promotion experiment. A
positive result cannot promote a route, change a profile, or grant publication
authority.

## Scope and non-goals

The pilot proves the narrower claim that the orchestrated route can preserve
accepted-result quality while reducing frontier usage or total operating cost
for a frozen corpus. It does not prove statistical eligibility for automatic
routing, production readiness, or provider/model superiority.

Do not add memory, new agents, adapters, UX, IPC layers, or host authority
during the run. A defect that invalidates the experiment is a reason to stop,
preserve the evidence, fix it in a separate change, and start a new manifest.

## Freeze before the first run

Create a `DogfoodManifestV1` with
`freezeDogfoodManifestV1` from the `dogfood-v1` package export. Commit the
result before executing any scheduled entry. The manifest hash is the identity
of the experiment; it must be present on every run record. Also commit the
exact analysis-policy artifact and put its canonical JSON hash in
`analysis_policy_hash`. The formulas in that artifact are part of the
experiment and cannot be changed after the first run.

The baseline must contain all of these exact identities:

| Field | Meaning |
| --- | --- |
| `runtime_commit_sha` | Full 40-character SHA of the repository base (`main`) |
| `policy_hash` | Frozen repository policy and routing authority |
| `host_driver_hash` | Privileged host-driver identity |
| `host_certification_hash` | Exact host certification evidence |
| `installation_manifest_hash` | Central installation identity |
| `validation_surface_hash` | Commands and validation configuration |

The execution identities that may differ between the two routes are frozen in
each `route_bindings` entry: `profile_hash`, `worker_capability_hash`,
`guidance_bundle_hash`, `harness_parser_hash`, `binding_hash` and
`qualification_hash`. This prevents an orchestrated worker and a frontier
worker from being represented by one misleading global capability hash.

The manifest also freezes `cost_policy`:

- `reporting_currency` is the only currency accepted in run records;
- `human_cost_micro_units_per_second` is the immutable human-intervention rate;
- `conversion_policy_hash` identifies the provider-cost conversion rules;
- `observed_cost_in_reporting_currency: true` means route, repair and escalation
  costs are already converted before recording them.
- `usage_binding_refs` freezes every binding allowed to appear in the provider
  usage ledger, including both route bindings and the reviewer binding.

The verifier recomputes human cost as
`human_intervention_seconds × human_cost_micro_units_per_second` and total cost
as `observed_cost_micro_units + human_intervention_cost_micro_units`.
`conversion_policy_hash` must equal the self-hash of the V3 pricing snapshot in
each run's `provider_cost_evidence`. That evidence retains the pricing snapshot,
binding registry and usage ledger; the verifier reuses V3 `aggregateUsage`/
`priceUsage` logic to reproduce observed cost and frontier usage calls.

Changing any one of these starts a new experiment. Do not edit a frozen
manifest in place and do not reinterpret a record under a later binding.

## Corpus and pairing

Use 20–30 real, representative tasks selected before the first run. Historical
tasks reconstructed from earlier commits are preferred when their correct
outcome can be known without exposing the solution to the worker. New real
tasks are allowed when the evaluator has a separately controlled acceptance
oracle.

Each case records hashes for its contract, base SHA, fixtures, validation
surface and reproducible `case_fingerprint`. The worker projection contains
only the contract and fixtures. Solution diffs, reference commits and oracle
outcomes remain evaluator-only.

Every case is executed exactly twice from the same case record:

- the same task and task class;
- the same base SHA, fixtures, policy and validations;
- a fresh worktree for each run;
- no cross-run workspace reuse;
- one `orchestrated` run and one `frontier_execution` run.

The manifest's `hash-interleave-v1` schedule deterministically ranks cases and
varies which route runs first within each pair. It contains every case/route
combination exactly once and bounds consecutive runs of the same strategy to
two. `run_policy.execution_mode` is `STRICT_SERIAL`: the next ordinal may not
start before the previous ordinal has completed. The run-set verifier checks
the recorded timestamps, so assigning ordinals after running all of one route
cannot make a non-interleaved execution valid. Do not replace it with “all
orchestrated, then all frontier”.

The 20–30 cases are the first operational sample only. Do not use them to
promote routing or to change thresholds. Future promotion evidence must still
be collected and evaluated per task class with the existing paired gate rules.

## Reviewer and authority

The reviewer binding and review policy are frozen in the manifest. Each run
uses a fresh reviewer session, the same evidence-packet shape, and an
evidence-only scope. The reviewer receives neither executor narrative nor the
other route's result.

The authority section is deliberately fixed to:

- `routing_decision: REPORT_ONLY`;
- `publication_mode: MANUAL_ONLY`;
- runtime may reach `READY_FOR_PUBLICATION`, but does not push, merge or deploy;
- no automatic route promotion;
- no automatic mutation of the manifest after the first run.

An authorised human may inspect a ready commit and decide whether to publish
it. That human decision is part of the evidence and must not be silently
treated as a model success.

## Run records and metrics

Emit one hash-bound `DogfoodRunRecordV1` per scheduled execution. Records are
sanitized metrics, hashes and structured provider-usage evidence, not prompts,
source code, raw model output, credentials or secrets. At minimum record:

- first-pass acceptance and final acceptance;
- reviewer rejection;
- repairs, escalations and total attempts;
- duration;
- observed cost;
- changed files and changed lines;
- validation failures;
- false acceptance;
- post-acceptance defects and severity;
- evidence reconstructibility;
- cross-run contamination;
- human interventions and intervention time;
- total cost to an accepted result;
- total cost across every scheduled run, including failed/unaccepted runs;
- reproducible frontier usage calls.

`total_cost_to_accepted_result_micro_units` must equal the verifier's frozen
calculation: reproduced provider route cost (including repairs and escalations)
plus the declared human-intervention cost. Report token/provider cost separately
from operational human cost so a cheap worker cannot appear cheaper merely
because intervention is omitted. A record with a manipulated currency, pricing
snapshot, usage ledger, human rate or total is invalid.

`first_pass_accepted` is a one-way claim: when true, `final_accepted` must also be
true, `attempts` must equal one, and both `repairs` and `escalations` must be zero.
An accepted result after repair or escalation is therefore final-accepted but not
first-pass-accepted. `human_intervention_seconds > 0` requires
`human_interventions > 0`; otherwise the human-intervention rate would be
silently understated. `reviewer_rejected` means that at least one reviewer
rejection occurred during the run, not necessarily that the final reviewer
decision was rejection. A run may therefore be rejected, repaired and accepted,
but an accepted run with a reviewer rejection must show a repair or escalation.

The manifest freezes `post_acceptance_window_seconds`. A final run record is
valid only when `started_at ≤ completed_at ≤ recorded_at`, `duration_ms` equals
the timestamp difference, and `recorded_at` is at least
`completed_at + post_acceptance_window_seconds`. Defects are then classified
against the same window for both routes.

Do not build the report by checking records one at a time. For a completed
pilot, call `verifyDogfoodRunSetV1(manifest, records)` and require exactly one
valid record for every schedule ordinal, with both routes present for every
case. A missing, duplicated or extra record invalidates the experiment rather
than silently changing its denominator.

If a frozen stop condition occurs, persist a hash-bound
`DogfoodStopEventV1` and call `verifyDogfoodRunSetV1(manifest, records,
stopEvent)`. The result is then `STOPPED_OPERATIONAL_FAILURE`, not `COMPLETE`:
records must be exactly the prefix `1..N`, the triggering run must be ordinal
`N`, and no record after `N` is allowed. A stopped prefix does not need to
contain both routes for every case. Without a stop event, the only valid result
is `COMPLETE` with the full schedule. A system stop detected before the first run
may use ordinal `0` and `triggering_run_id: null`; run-derived stop conditions
must include the triggering record hash in `evidence_hashes`. The verifier also
checks causal compatibility: critical false acceptance requires both
`false_acceptance: true` and a critical post-acceptance defect, cross-run
contamination requires `cross_run_contamination: true`, and unreconstructable
evidence requires `evidence_reconstructible: false`. Authority escapes and
durable-state inconsistencies remain externally evidenced by their hash-bound
system evidence.

The aggregate `human_intervention_rate` is the proportion of runs requiring at
least one human action. The aggregate `total_cost_to_accepted_result` is the
sum of route, recovery and human costs for runs that reach an accepted result;
unaccepted work remains visible in a separate failure population. The report
also computes mean/total cost over all scheduled runs and frontier usage calls;
it must not describe cost reduction using only successful runs.

## Frozen stop conditions

Stop the entire pilot on the first occurrence of any of these conditions:

1. `AUTHORITY_ESCAPE` — a model or route obtains an authority outside the
   manifest, including push, merge, deploy or credential-scope expansion.
2. `DURABLE_STATE_INCONSISTENCY` — journal, cache, dispatcher or run state
   cannot be reconstructed consistently.
3. `CRITICAL_FALSE_ACCEPTANCE` — a critical defect is accepted as a valid
   result.
4. `CROSS_RUN_CONTAMINATION` — one run sees or mutates another run's worktree,
   fixtures, credentials or evidence.
5. `UNRECONSTRUCTABLE_EVIDENCE` — a run cannot be replayed or audited from its
   frozen manifest, record hashes and retained evidence.

On a stop, preserve the manifest, the triggering run and all prefix records,
then persist `dogfood-stop-event-v1` in an external append-only log. Do not
retry the failed case under changed conditions. A fix requires a new commit,
new exact binding qualification and new manifest hash. `operational_failure`
has precedence over `insufficient_evidence`; a stopped pilot is never relabeled
as ordinary sample insufficiency.

## Analysis boundary

After the corpus is complete, publish a report containing the paired matrix
`task_class × strategy` and the operational metrics. Use the frozen
`contracts/dogfood-analysis-policy-v1.json` identified by `analysis_policy_hash`.
The first question is:

> Does `orchestrated` preserve quality while reducing frontier usage or total
> operating cost without introducing new operational failures?

The record verifier also enforces semantic invariants: `outcome: ACCEPTED` is
equivalent to `final_accepted`, first-pass acceptance has the one-attempt/no-
repair/no-escalation constraints above, `false_acceptance` requires final
acceptance, and a critical post-acceptance defect is a critical false
acceptance. Do not modify thresholds, omit difficult cases, collapse human
intervention, or count a frontier rescue as an orchestrated first-pass success
after seeing the results. Record `insufficient_evidence` only for a complete run
set whose denominators are insufficient; an operationally stopped run set is
always `operational_failure`.

The manifest and record contracts are published as
[`dogfood-manifest-v1.schema.json`](../contracts/dogfood-manifest-v1.schema.json)
and [`dogfood-run-record-v1.schema.json`](../contracts/dogfood-run-record-v1.schema.json).
The operational stop event is defined by
[`dogfood-stop-event-v1.schema.json`](../contracts/dogfood-stop-event-v1.schema.json).
The report formulas are frozen in
[`dogfood-analysis-policy-v1.json`](../contracts/dogfood-analysis-policy-v1.json).
