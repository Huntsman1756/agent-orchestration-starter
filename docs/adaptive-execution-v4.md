# Adaptive, provider-neutral execution

Runtime V4 selects an execution lane from qualified capabilities, not from a provider or model name. The planner records explicit task traits in `execution_requirements`; legacy `task_class` values are classified conservatively until consumers migrate.

The three lanes are:

- `MECHANICAL_ECONOMY`: small, localized and mechanically checkable work;
- `REASONING_ECONOMY`: debugging and cross-file reasoning handled by a separately qualified economical worker;
- `FRONTIER_EXECUTION`: architecture, security-sensitive, migrations, long-horizon work, explicit frontier requests, or any task for which no economical binding is qualified.

Each writable profile binding may declare an `execution` envelope: supported task traits, step/tool/time limits, mutation-latency limit and failed-candidate repair support. Changing provider, model, harness, parser, guidance or policy invalidates the exact qualification; copying an envelope to a new model does not certify it.

The broker derives and hashes `execution_policy` into the work contract. OpenCode receives that exact budget and fails closed when it exceeds steps, tool uses, time, attempts or the allowed pre-mutation exploration. A reasoning task never falls back to an unqualified mechanical worker: it uses `reasoningExecutor` or elevates to frontier.

## Repair behaviour

Deterministic validation failures can produce content-addressed finding hashes. The broker may grant one bounded economical repair before review. A repeated validation failure or repeated reviewer rejection escalates with persisted failure evidence; evidence-free failure terminates instead of inventing a repair.

`supportsFailedCandidateRepair` is only a capability declaration. Keep it `false` until the host can materialize a rejected candidate in a fresh isolated attempt and has qualified that exact behaviour. The accepted tree remains the promotion authority.

## Measuring efficiency

Use `aggregateRuntimeExecutionEfficiencyV4` over every scheduled run. It counts failed attempts, repairs, escalations, all worker tokens, all frontier tokens (planner, reviewer and frontier execution), provider cost and human intervention. The primary economic metric is total operating cost per accepted result, never the advertised price of the worker alone.

Low API consumption is not itself proof of a defect: policy may be routing work to frontier, source sensitivity may make the economical binding ineligible, or the host may not be invoking the generated route. Diagnose with the contract's lane, executor role, reasons and policy hash before changing limits.

## Model replacement checklist

1. Add or replace only profile bindings; do not add model names to repository policy or core routing.
2. Declare the smallest plausible trait envelope and conservative budgets.
3. Qualify the exact model, provider, harness/parser, driver, guidance bundle and policy combination.
4. Start report-only and inspect validation repairs, escalation rate, frontier tokens and total operating cost.
5. Expand traits or limits only from reproducible evidence. Never let a model promote itself.
