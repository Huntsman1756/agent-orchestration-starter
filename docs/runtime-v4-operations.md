# Runtime V4 operations

## Current readiness

Runtime V4 is a fail-closed implementation framework with a portable host bootstrap, not a universal pre-certified unattended service. Its local contracts, routing, capability qualification, worktree/capsule isolation, OpenCode and Codex runners, deterministic validation, fresh review, local Git finalization, broker-owned GitHub publication, MCP surface, lifecycle persistence, telemetry, orchestration scheduling, immutable installation and repository activation have automated coverage. No code path deploys or changes routing automatically.

Production activation remains blocked until all of these are supplied and certified for the target host:

- a trusted host driver which uses the supplied native composition factory and provides exact pipeline, repair, finalize and abort operations plus certified platform verifiers/coordinators;
- installation and verification of the supplied immutable central runtime bundle;
- a credential adapter that keeps saved ChatGPT/Codex authentication and provider API keys outside repository-controlled descendants;
- a trusted GitHub credential lease plus certified empty Git hooks and global-config paths for the publication adapter;
- a provider gateway compatible with each selected harness protocol (the current gateway only permits `/v1/chat/completions` with an API key);
- fresh three-run capability qualification for each exact harness/provider/model/broker/policy identity;
- Docker sandbox certification on the deployment host.

Use `assessRuntimeActivationV4` to produce a strict machine-readable assessment for `ANALYSIS_ONLY`, `ISOLATED_EXECUTION`, or `AUTONOMOUS_PUBLICATION`. It reports route collapse and missing evidence without weakening private-source policy. See [`activation-readiness-v4.md`](activation-readiness-v4.md).

Install once per machine and activate each repository by reference. Installation, activation, driver migration and future provider changes are documented in [`host-installation-v4.md`](host-installation-v4.md). Activation records intended authority but does not manufacture host certification.

Third-party runtimes are qualified as exact host-driver candidates, never trusted by
product name or by the presence of a container. Use
[`external-runtime-qualification-v4.md`](external-runtime-qualification-v4.md) for the
portable evidence procedure. The pinned OpenHands comparison in
[`research/openhands-sandbox-evaluation-2026-08-10.md`](research/openhands-sandbox-evaluation-2026-08-10.md)
shows how omitted controls and non-comparable tests remain explicit instead of silently
becoming `hard` evidence.

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

The STDIO MCP adapter performs short authenticated control calls only. `createRuntimeHostCompositionV4` binds it to the durable daemon and exact host operations. The daemon owns idempotency, one scheduled pipeline flight, model execution, validation, review, repair/escalation, finalization, journal recovery, failures, aborts and locks. Replaying a canonical `request_id` returns its original `run_id` without scheduling duplicate work.

The IPC wire contract now carries all five MCP operations and binds replies back to authoritative daemon status. Mutating retries reuse deterministic command IDs. See [`control-plane-v4.md`](control-plane-v4.md). This protocol completion does not by itself certify a production host.

## Security and credentials

Executor/reviewer containers receive only the fixed non-secret `PROVIDER_GATEWAY_TOKEN=broker-gateway`. Real credentials must remain in the broker-owned gateway and must never be mounted into a worktree, capsule, validation process, hook, filter, or repository command. Do not point `CODEX_HOME`, `auth.json`, `OPENAI_API_KEY`, or another provider secret at a project-controlled process.

Validation is networkless and credential-free. Review uses a fresh read-only evidence capsule without the worktree. Finalization uses Git plumbing with filters and replacement objects disabled, an empty global config, an empty hooks directory, deterministic identity/time, and compare-and-update of only `refs/heads/codex/auto/<run-id>`. Publication remains in the broker: models never receive GitHub credentials or choose a remote, base, merge method, check gate or timeout.

## Artifacts and telemetry

Artifacts are content-addressed and bounded. Runtime V4 telemetry is append-only, hash-chained, strict, and excludes prompts, responses, reasoning, transcripts, diffs, source, environment, credentials, and credential-shaped values. Telemetry export cannot change a runtime gate. The concrete V3 telemetry adapter is intentionally unavailable; V4 reports `V3_RUNTIME_NOT_INSTALLED` and does not invent V3 evidence.

Retained failed-run worktrees and artifacts require a future explicit cleanup command. Do not delete them automatically because they may be the only failure evidence.

## Broker-owned publication

Successful finalization creates a deterministic local commit and updates only the task branch. That commit now enters `READY_FOR_PUBLICATION`; it is not terminal. When the hashed repository policy enables publication, `publishFinalizedRunV4` durably records the exact push, pull request, required checks and head-bound merge before reaching `FINALIZED`. The operation is idempotent at every publication boundary and after a remote merge. It never force-pushes, runs repository hooks, lets the model choose publication settings, deletes branches, deploys or changes routing. See `docs/publication-v4.md`.

## Typed failures

Failures use the closed V4 catalog, including `CAPABILITY_UNVERIFIED`, `PROCESS_SANDBOX_UNAVAILABLE`, `VALIDATION_FAILED`, `REVIEW_REJECTED`, `REVIEW_ATTESTATION_INVALID`, `EVIDENCE_HASH_MISMATCH`, `FINALIZATION_ISOLATION_FAILED`, `FINALIZATION_FAILED`, `PUBLICATION_POLICY_DENIED`, `PUBLICATION_FAILED`, and `ABORTED`. Unknown internal details are normalized to `UNKNOWN_FAILURE` at IPC/MCP boundaries.
