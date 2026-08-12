# Runtime V4 operations

## Current readiness

Runtime V4 is a fail-closed implementation framework with a portable host bootstrap, not a universal pre-certified unattended service. Its local contracts, routing, capability qualification, worktree/capsule isolation, OpenCode and Codex runners, deterministic validation, fresh review, local Git finalization, broker-owned GitHub publication, MCP surface, lifecycle persistence, telemetry, orchestration scheduling, immutable installation and repository activation have automated coverage. No code path deploys or changes routing automatically.

The package default API is intentionally smaller than the implementation. Use
`agent-orchestration-starter/runtime-v4/contracts` for contract loaders,
`runtime-v4/host` for the privileged host boundary, and
`runtime-v4/experimental` for lower-level evolving surfaces. Release `0.2.x`
is pre-1.0; consult the [compatibility matrix](compatibility-matrix-v4.md)
before reusing evidence across a host, model, harness or policy change.

The iterative worker primitive now binds each plan to an exact `WorkerCapabilityV4`, including the model deployment, harness/parser, tool and instruction/skill bundles, qualification evidence and story-size limits. It verifies repair packets against persisted findings and escalates repeated normalized failures before exhausting retries. These controls remain host obligations at composition time: the qualified practice-pack resolver and capability issuer must derive the snapshot, while the thin root enforces context/step limits; a model profile cannot certify itself.

Production activation remains blocked until all of these are supplied and certified for the target host:

- a thin trusted root plus the eight separately certified host components defined in [`modular-host-components-v4.md`](modular-host-components-v4.md), using the supplied native composition factory and certified platform verifiers/coordinators;
- installation and verification of the supplied immutable central runtime bundle;
- a credential gateway that issues separate bounded provider and GitHub internal-gateway leases while keeping saved ChatGPT/Codex authentication, API keys and GitHub credentials outside repository-controlled descendants;
- a trusted GitHub publication lease plus certified empty Git hooks and global-config paths for the publication adapter;
- a provider gateway compatible with each selected harness protocol (the current gateway only permits `/v1/chat/completions` with an API key);
- fresh three-run capability qualification for each exact harness/provider/model/broker/policy identity;
- Docker sandbox certification on the deployment host.

Use `assessRuntimeActivationV4` to produce a strict machine-readable assessment for `ANALYSIS_ONLY`, `ISOLATED_EXECUTION`, or `AUTONOMOUS_PUBLICATION`. It reports route collapse and missing evidence without weakening private-source policy. See [`activation-readiness-v4.md`](activation-readiness-v4.md).

Install once per machine and activate each repository by reference. Installation, activation, component migration and future provider changes are documented in [`host-installation-v4.md`](host-installation-v4.md). Activation binds the exact aggregate host-composition certificate and intended authority but does not manufacture qualification evidence.

Third-party runtimes are qualified as exact host-component candidates, never trusted by
product name or by the presence of a container. Use
[`external-runtime-qualification-v4.md`](external-runtime-qualification-v4.md) for the
portable evidence procedure. The pinned OpenHands comparison in
[`research/openhands-sandbox-evaluation-2026-08-10.md`](research/openhands-sandbox-evaluation-2026-08-10.md)
shows how omitted controls and non-comparable tests remain explicit instead of silently
becoming `hard` evidence.

If any item is absent, startup or execution returns a typed failure. There is no direct-write fallback.

## Configuration boundaries

Repository policy owns allowed branches, exact validation argv, routing restrictions, source sensitivity, sandbox profiles, and approved instruction sources. Runtime profiles own replaceable harness/provider/model bindings. The repository registry binds an approved ID to a canonical root and the exact policy/profile locations. Models and providers do not appear in the stable repository policy.

Generated rules and profiles do not invoke a worker. Use the route, launch,
native-event and provider-usage evidence described in
[`harness-adapters-v4.md`](harness-adapters-v4.md) to distinguish real
delegation from a passive project convention or a frontier fallback.

Generated `.codex/config.toml` keeps the primary frontier context read-only, marks `agent_orchestration_v4` required, and enables only `run_coding_task`, `repair_coding_task`, `finalize_coding_task`, `abort_coding_task`, and `get_coding_task_status`. Existing unmanaged or locally modified config is never overwritten.

## Intended lifecycle

Every privileged standalone command loads the same hash-bound repository
activation. Embedded hosts may inject equivalent verified operations, but the
operator-facing CLI never infers authority from ambient repository files.

```powershell
agent-orchestration runtime daemon --activation <activation-v4.json>
agent-orchestration runtime doctor --activation <activation-v4.json>
agent-orchestration runtime status --run-id run_... --activation <activation-v4.json>
```

The STDIO MCP adapter performs short authenticated control calls only. `createRuntimeHostCompositionV4` binds it to the durable daemon and exact host operations. Before the root can do that, the loader independently verifies task intake, issue planning, practice-pack resolution, credential gateway, sandbox coordination, capability issuance, GitHub publication and post-merge verification ports. The daemon owns idempotency, one scheduled pipeline flight, model execution, validation, review, repair/escalation, finalization, journal recovery, failures, aborts and locks. Replaying a canonical `request_id` returns its original `run_id` without scheduling duplicate work.

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
