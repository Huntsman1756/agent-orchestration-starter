# Adaptive, provider-neutral execution

Runtime V4 selects an execution lane from qualified capabilities, not from a provider or model name. The planner records explicit task traits in `execution_requirements`; legacy `task_class` values are classified conservatively until consumers migrate.

The three lanes are:

- `MECHANICAL_ECONOMY`: small, localized and mechanically checkable work;
- `REASONING_ECONOMY`: debugging and cross-file reasoning handled by a separately qualified economical worker;
- `FRONTIER_EXECUTION`: architecture, security-sensitive, migrations, long-horizon work, explicit frontier requests, or any task for which no economical binding is qualified.

Each writable profile binding must declare an `execution` envelope: supported task traits, step/tool/time limits, mutation-latency limit and failed-candidate repair support. Changing provider, model, harness, parser, guidance or policy invalidates the exact qualification; copying an envelope to a new model does not certify it.

Every binding also declares a provider-neutral `tier`. The schema enforces the
topology rather than trusting role names: orchestrator/reviewer are read-only
`frontier`; primary, reasoning and escalation workers are writable `economy`;
the direct fallback is writable `frontier`. Every writable binding must provide
an explicit `execution` envelope. There are no inferred write capabilities.

`tier` describes responsibility in this profile, not a vendor ranking. Reusing
the same provider/model as both an economy worker and `frontierExecutor` can
still provide a separately qualified budget or supervised retry, but it is not
a stronger-model escalation. `runtime doctor` reports that topology as
`DEGRADED` so operators can distinguish the two cases.

The broker derives and hashes `execution_policy` into the work contract. OpenCode receives that exact budget and fails closed when it exceeds steps, tool uses, time, attempts or the allowed pre-mutation exploration. A reasoning task never falls back to an unqualified mechanical worker: it uses `reasoningExecutor` or elevates to frontier.

## Repair behaviour

Deterministic validation failures can produce content-addressed finding hashes. The broker may grant one bounded economical repair before review. A repeated validation failure or repeated reviewer rejection escalates with persisted failure evidence; evidence-free failure terminates instead of inventing a repair.

`supportsFailedCandidateRepair` is only a capability declaration. Keep it `false` until the host can materialize a rejected candidate in a fresh isolated attempt and has qualified that exact behaviour. The accepted tree remains the promotion authority.

## Measuring efficiency

Use `aggregateRuntimeExecutionEfficiencyV4` over every scheduled run. It counts failed attempts, repairs, escalations, all worker tokens, all frontier tokens (planner, reviewer and frontier execution), provider cost and human intervention. The primary economic metric is total operating cost per accepted result, never the advertised price of the worker alone.

Low API consumption is not itself proof of a defect: policy may be routing work to frontier, source sensitivity may make the economical binding ineligible, or the host may not be invoking the generated route. Diagnose with the contract's lane, executor role, reasons and policy hash before changing limits.

## Self-regulation from failures

`RuntimeBindingHealthV4` closes the admission-time feedback loop for the exact
`bindingHash x taskTrait` pair. The trusted host records bounded, self-hashed
outcomes such as invalid output, validation/review failure, budget exhaustion,
provider unavailability, authority violation and false acceptance. It reduces
those observations into a hash-bound health snapshot and supplies the snapshot
to the broker when the next task is admitted.

The default policy quarantines an exact pair after two consecutive failures,
after more than 40% failures in a 20-observation window with at least five
observations, or immediately after authority violation/false acceptance. A
quarantined mechanical worker is skipped in favour of an already-qualified
reasoning worker or frontier; a quarantined reasoning worker elevates to
frontier. If frontier is quarantined for that trait, admission fails closed.

Recovery is deliberately asymmetric. Cooldown only makes the pair eligible for
an explicit synthetic canary. Three clean canaries are required before normal
routing resumes. Ordinary successful tasks cannot erase quarantine evidence.
The model cannot write observations, change thresholds, classify its own run as
a canary or promote itself. Automatic adaptation may only contract routing;
expanding traits, permissions, limits or authority still requires a changed
profile, fresh qualification and human-controlled evidence review.

The host health store should contain only identifiers, timestamps, outcomes and
hashes. Do not retain prompts, reasoning, source, diffs, responses or secrets.
Keep health per exact binding and task trait: failure on mechanical formatting
must not silently disqualify an otherwise independent semantic binding, and a
model/provider/harness/guidance change creates a new binding identity.

This loop is automatic only when the privileged host does both sides of the
port: record a terminal observation from validation/review evidence and return
the current snapshots through `loadBindingHealth` at admission. A host that
does not implement that port remains safely static; it must not claim adaptive
routing. Persist observations durably and append-only, derive canary identity
from broker-owned scheduling, and alert on quarantine, canary failure and
frontier fail-closed decisions. These records show where delegation needs
better decomposition, guidance or qualification; they are not model training
data and never justify silent expansion of a capability envelope.

## Model replacement checklist

1. Add or replace only profile bindings; do not add model names to repository policy or core routing.
2. Declare the smallest plausible trait envelope and conservative budgets.
3. Qualify the exact model, provider, harness/parser, driver, guidance bundle and policy combination.
4. Start report-only and inspect validation repairs, escalation rate, frontier tokens and total operating cost.
5. Expand traits or limits only from reproducible evidence. Never let a model promote itself.
