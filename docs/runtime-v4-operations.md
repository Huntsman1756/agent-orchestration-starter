# Runtime V4 operations

## Current readiness

Runtime V4 is a fail-closed implementation framework, not yet a production-ready unattended service. Its local contracts, routing, capability qualification, worktree/capsule isolation, OpenCode and Codex runners, deterministic validation, fresh review, local Git finalization, MCP surface, telemetry, and orchestration scheduling have automated coverage. No code path pushes, merges, deploys, or changes routing automatically.

Production activation remains blocked until all of these are supplied and certified for the target host:

- a native authenticated broker composition for every MCP control, including repair, finalize, abort, and status;
- an immutable project-local runtime bundle at `.agent-orchestration/runtime/dist/cli/main.js`;
- a credential adapter that keeps saved ChatGPT/Codex authentication and provider API keys outside repository-controlled descendants;
- a provider gateway compatible with each selected harness protocol (the current gateway only permits `/v1/chat/completions` with an API key);
- fresh three-run capability qualification for each exact harness/provider/model/broker/policy identity;
- Docker sandbox certification on the deployment host.

If any item is absent, startup or execution returns a typed failure. There is no direct-write fallback.

## Configuration boundaries

Repository policy owns allowed branches, exact validation argv, routing restrictions, source sensitivity, sandbox profiles, and approved instruction sources. Runtime profiles own replaceable harness/provider/model bindings. The repository registry binds an approved ID to a canonical root and the exact policy/profile locations. Models and providers do not appear in the stable repository policy.

Generated `.codex/config.toml` keeps the primary frontier context read-only, marks `agent_orchestration_v4` required, and enables only `run_coding_task`, `repair_coding_task`, `finalize_coding_task`, `abort_coding_task`, and `get_coding_task_status`. Existing unmanaged or locally modified config is never overwritten.

## Intended lifecycle

```text
agent-orchestration runtime daemon
agent-orchestration runtime doctor --repository-policy policies/repository-policy.yaml --profile profiles/runtime.yaml
agent-orchestration runtime status --run-id run_...
```

The STDIO MCP adapter performs short authenticated control calls only. The durable daemon owns idempotency, model execution, validation, review, repair/escalation, finalization, journal recovery, and locks. Replaying a canonical `request_id` returns its original `run_id`.

## Security and credentials

Executor/reviewer containers receive only the fixed non-secret `PROVIDER_GATEWAY_TOKEN=broker-gateway`. Real credentials must remain in the broker-owned gateway and must never be mounted into a worktree, capsule, validation process, hook, filter, or repository command. Do not point `CODEX_HOME`, `auth.json`, `OPENAI_API_KEY`, or another provider secret at a project-controlled process.

Validation is networkless and credential-free. Review uses a fresh read-only evidence capsule without the worktree. Finalization uses Git plumbing with filters and replacement objects disabled, an empty global config, an empty hooks directory, deterministic identity/time, and compare-and-update of only `refs/heads/codex/auto/<run-id>`.

## Artifacts and telemetry

Artifacts are content-addressed and bounded. Runtime V4 telemetry is append-only, hash-chained, strict, and excludes prompts, responses, reasoning, transcripts, diffs, source, environment, credentials, and credential-shaped values. Telemetry export cannot change a runtime gate. The concrete V3 telemetry adapter is intentionally unavailable; V4 reports `V3_RUNTIME_NOT_INSTALLED` and does not invent V3 evidence.

Retained failed-run worktrees and artifacts require a future explicit cleanup command. Do not delete them automatically because they may be the only failure evidence.

## No-push guarantee

Successful finalization creates a deterministic local commit and updates only the task branch. Runtime V4 does not push, open a pull request, merge, deploy, or publish. Those operations require a separately authorized and reviewed version.

## Typed failures

Failures use the closed V4 catalog, including `CAPABILITY_UNVERIFIED`, `PROCESS_SANDBOX_UNAVAILABLE`, `VALIDATION_FAILED`, `REVIEW_REJECTED`, `REVIEW_ATTESTATION_INVALID`, `EVIDENCE_HASH_MISMATCH`, `FINALIZATION_ISOLATION_FAILED`, `FINALIZATION_FAILED`, and `ABORTED`. Unknown internal details are normalized to `UNKNOWN_FAILURE` at IPC/MCP boundaries.
