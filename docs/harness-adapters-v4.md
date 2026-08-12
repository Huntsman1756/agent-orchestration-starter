# Harness adapters and delegation proof

Runtime V4 delegates through a qualified harness adapter. A repository rule,
`AGENTS.md`, generated agent file or model profile describes intent; none of
them launches a worker. Execution exists only when the activated daemon admits
a contract, selects a compatible route and invokes the exact qualified adapter.

## Evidence that delegation happened

Do not infer economy-worker use from the final diff or from an instruction that
says "delegate". Preserve a chain that proves all of the following:

1. the routing result selected `ECONOMY`/`orchestrated`, including every route
   reason and the effective source sensitivity;
2. the dispatcher admitted the request while `RUNNING` and created one run;
3. the worker receipt identifies the exact harness, version, provider, model,
   parser revision, capability hash and attempt;
4. the harness produced at least one valid native event with one consistent
   session identity and a successful terminal event;
5. provider usage and cost are attributed to that run and role;
6. the broker independently checked the diff, validation and review evidence.

If provider usage is unexpectedly zero, inspect those boundaries in order. The
usual causes are route collapse (private source, protected path, risk or task
class), an incompatible or stale binding, a paused/unstarted dispatcher, a
project-local launcher that was never called, provider/model resolution failure,
or harness/parser protocol drift. Do not silently take over with frontier and
report the attempt as economical execution.

## OpenCode adapter

The pinned OpenCode adapter runs non-interactively with broker-owned arguments:

```text
opencode run --pure --auto --format=json --dir=/capsule \
  --model=<provider>/<model> --agent=<role> -- <bounded prompt>
```

`--auto` approves only permission requests that are not explicitly denied. The
broker config still defaults every permission to `deny`, allows only scoped
read/search/edit operations and exposes no shell, subagent, skill or publication
permission. `--pure` disables external plugins and `/capsule` prevents a
repository from selecting the execution root.

OpenCode 1.18.15 and 1.18.16 emit JSONL envelopes named `step_start`, `text`,
`tool_use` and `step_finish`, with `sessionID` at the event level and a final
`step_finish` whose reason is `stop`. Runtime V4 validates that native envelope,
the step sequence, session consistency and the allowlisted tool names. Unknown
events, textual pseudo-calls, shell/subagent tools, mixed sessions and malformed
terminal steps fail closed. A harness version or parser change invalidates prior
qualification and requires three new clean probes before repository work.

Sources: [OpenCode CLI](https://opencode.ai/docs/cli/) and
[OpenCode permissions](https://opencode.ai/docs/permissions/).

## Pi and Orca

Pi is a plausible future worker harness because it has a programmable CLI and a
provider-neutral API. It is not a drop-in security replacement: Pi explicitly
runs with the launching process's permissions and recommends an external
container or sandbox for stronger boundaries. A Pi adapter therefore needs its
own pinned argv, native-event parser, broker config, hostile tests and exact
qualification behind the existing sandbox port.

Orca is an agent development environment and control surface for worktrees,
terminals and multiple CLI agents. It can host OpenCode or Pi, but it does not
replace their worker protocol or Runtime V4's broker, policy, credentials,
validation and publication authority. Treat an Orca integration as a separate
task-source/operations adapter, not as evidence that worker delegation is safe.

Sources: [Pi Agent Harness](https://github.com/earendil-works/pi) and
[Orca CLI](https://www.onorca.dev/docs/cli/overview).
