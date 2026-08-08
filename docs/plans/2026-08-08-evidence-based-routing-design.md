# Evidence-Based Routing Design

## Scope

Version 2 turns the fixed frontier-to-economy path into three explicit strategies without adding a provider runner:

- `economy_only`: economy executor followed by deterministic validation.
- `orchestrated`: frontier planning, economy execution, deterministic validation, and clean-context frontier review.
- `frontier_execution`: a frontier-backed executor writes the change, deterministic validation runs, and a clean-context frontier reviewer checks the result.

The compiler emits the agents needed for all three paths. Route selection remains evidence-driven and external to provider execution. The stable policy describes allowed strategies and isolation requirements; concrete model mappings remain in replaceable profiles.

## Isolation contract

`writeIsolation` is an explicit harness capability with values `hard` and `degraded`. Codex and OpenCode compile with hard role-level write isolation. Hermes reports degraded isolation because delegated children inherit the parent's enabled toolsets. A policy that requires hard isolation rejects Hermes unless the caller supplies an explicit, harness-scoped acceptance. Generated manifests record both required and effective isolation so a consumer cannot silently mistake instruction enforcement for a sandbox boundary.

## Independent review

Review uses a fresh review envelope containing only the original work contract, complete diff, deterministic command results, and files requested on demand. Planner rationale, executor reasoning, and prior verdicts are excluded. The same frontier model may serve as orchestrator and reviewer, but the generated reviewer instructions require a new context and prevent the orchestration transcript from becoming evidence.

## Offline benchmark and routing gate

The benchmark ingests JSONL observations produced by any harness. Each observation records task class, attempted route, first-pass and final acceptance, total route cost in USD, latency, repairs, escalation, post-acceptance defects, and frontier/economy token totals. An escalated task remains a failed first pass for its attempted route even when the final result is accepted.

For each task class and candidate route, the gate compares evidence with `frontier_execution`. It returns `promote`, `reject`, or `insufficient_evidence` plus machine-readable reasons. Promotion requires the configured sample minimum, accepted-task cost savings, no unacceptable first-pass acceptance regression, bounded escalation, and bounded post-acceptance defects. Cost per accepted task is total route cost divided by finally accepted tasks, so repairs, rereads, and escalation are included rather than hidden.

## Non-goals

Version 2 does not authenticate providers, execute prompts, estimate prices from token counts, or automatically rewrite project routing. It produces portable evidence and recommendations that a harness or human can consume.
