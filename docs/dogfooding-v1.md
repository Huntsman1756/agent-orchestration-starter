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
of the experiment; it must be present on every run record.

The baseline must contain all of these exact identities:

| Field | Meaning |
| --- | --- |
| `runtime_commit_sha` | Full 40-character SHA of the repository base (`main`) |
| `policy_hash` | Frozen repository policy and routing authority |
| `profile_hash` | Project/model binding profile |
| `worker_capability_hash` | Exact worker deployment, tools, limits and qualification |
| `guidance_bundle_hash` | Orchestrator/executor/reviewer guidance and instruction bundle |
| `harness_parser_hash` | Harness and parser implementation identity |
| `host_driver_hash` | Privileged host-driver identity |
| `host_certification_hash` | Exact host certification evidence |
| `installation_manifest_hash` | Central installation identity |
| `validation_surface_hash` | Commands and validation configuration |

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
two. Do not replace it with “all orchestrated, then all frontier”.

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
sanitized metrics and hashes, not prompts, source code, raw model output,
credentials or secrets. At minimum record:

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
- total cost to an accepted result.

`total_cost_to_accepted_result_micro_units` must include the observed route
cost, repairs, escalations and the declared human-intervention cost. Report
token/provider cost separately from operational human cost so a cheap worker
cannot appear cheaper merely because intervention is omitted.

The manifest freezes `post_acceptance_window_seconds`. A final run record is
valid only after that window is closed; defects are then classified against the
same window for both routes.

The aggregate `human_intervention_rate` is the proportion of runs requiring at
least one human action. The aggregate `total_cost_to_accepted_result` is the
sum of route, recovery and human costs for runs that reach an accepted result;
unaccepted work remains visible in a separate failure population.

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

On a stop, preserve the manifest and all records, mark the pilot stopped in an
external append-only log, and do not retry the failed case under changed
conditions. A fix requires a new commit, new exact binding qualification and
new manifest hash.

## Analysis boundary

After the corpus is complete, publish a report containing the paired matrix
`task_class × strategy` and the operational metrics. The first question is:

> Does `orchestrated` preserve quality while reducing frontier usage or total
> operating cost without introducing new operational failures?

Do not modify thresholds, omit difficult cases, collapse human intervention,
or count a frontier rescue as an orchestrated first-pass success after seeing
the results. If the pilot is inconclusive, record `insufficient_evidence` and
design the next evidence phase separately.

The manifest and record contracts are published as
[`dogfood-manifest-v1.schema.json`](../contracts/dogfood-manifest-v1.schema.json)
and [`dogfood-run-record-v1.schema.json`](../contracts/dogfood-run-record-v1.schema.json).
