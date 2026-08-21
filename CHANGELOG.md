# Changelog

## Unreleased

### Added

- Established a repository-wide Prettier baseline and replaced the limited
  critical-file check with deterministic `format:check` and `format:write`
  commands covering every non-ignored source, test, script, profile and guide.
- Added a documentation authority index and recorded segmented, checkpointed
  durable evidence as an explicit pre-1.0 requirement instead of treating
  streaming parsing as a sufficient memory-bound fix.
- Added a NaN GLM 5.2 premium/OpenCode example with a distinct writable
  frontier executor, while retaining the standard NaN example's explicit
  same-model degradation for accounts without that tier.
- Added a built-in, provider-neutral `runtime doctor` delegation preflight that
  exposes route collapse, exact role/model identities, qualified task traits
  and same-model frontier fallbacks without requiring a host driver.
- Added explicit `frontier`/`economy` responsibility tiers to Runtime V4
  bindings and a readiness topology check.
- Added a durable worktree ownership lifecycle with exact local task branches,
  terminal evidence retention, bounded quotas, safe automatic reconciliation,
  cleanup tombstones and a hash-bound `runtime worktree-gc` operator command.
- Added binding/task-trait health quarantine with hash-bound admission evidence,
  cooldown and broker-owned canary recovery.
- Added bounded MCP HTTP session capacity and idle expiry, macOS framework CI,
  and an automated Linux native-package boundary check.

### Fixed

- Bounded the fake Docker executor used by container-transaction recovery
  tests so a failed platform-specific process-tree cancellation cannot retain
  the test runner until the outer CI job timeout, and made repeated blocked
  identity-command probes prove and clean every descendant they create.
- Preserved shared repository locks until every active run releases ownership
  and removed partially written orphan locks after failed acquisition. macOS
  now derives fail-closed boot and process-start identities for those locks.
- Made lost dispatcher leases durably terminal, required merged publication for
  autonomous dispatch, and replaced timestamp-only temporary names with random
  collision-resistant identities.
- Derived pilot wall time from contractual event chronology and counted every
  escaped material defect instead of only affected blocks.
- Serialized concurrent audit appends, rejected corrupt installation registries,
  locked registry updates, and encoded generated Codex instructions safely in
  TOML strings.

### Changed

- Writable Runtime V4 bindings now require an explicit qualified execution
  envelope; the runtime no longer accepts profiles that infer write capability
  limits from generic model guidance. Existing V4 profiles must add `tier` to
  every binding and `execution` to every `contract-write` binding before
  reactivation and fresh qualification.
- Renamed the deliberately scoped Prettier gate to
  `format:critical:check`, removed incompatible legacy examples, and made the
  packaged audit verifier use the built CLI.

## 0.3.1 - 2026-08-16

### Fixed

- Stabilized the Shift-Left static AST security test under CI by resolving its
  fixture from the test module URL, rejecting ignored or mismatched paths
  explicitly, and priming the typed ESLint flat configuration before asserting
  that `eval` is reported.
- `v0.3.0` was not published because release validation was blocked by a
  nondeterministic Shift-Left test involving CI path/configuration resolution;
  `v0.3.1` contains the patch-only correction and leaves `v0.3.0` immutable.

## 0.3.0 - 2026-08-16

### Added

- Added the authenticated MCP broker surface with STDIO and Streamable HTTP
  adapters, seven bounded tools, hash-bound review packets and durable verdict
  handling. `APPROVED` remains evidence only; `REJECTED` reuses repair flow.
- Added strict SDD contract matrices for Planner-authored `acceptance_tests`
  and Economy-owned `implementation_targets`, including a fail-closed diff
  interceptor that emits `ECONOMY_POLICY_VIOLATION`.
- Added static TypeScript AST capability snapshots with bounded dependency
  traversal, dynamic-import exclusion, signature fallback and content hashes.
- Added shift-left lint/format security gates that emit bounded Repair Packets
  before independent Frontier review.
- Added the append-only, hash-chained audit ledger with secret redaction,
  durable broker projection and `npm run audit:verify`.
- Added the master MCP/SDD architecture guide, Mermaid lifecycle diagram and
  explicit Planner/Executor/Reviewer rules in `AGENTS.md`.

### Changed

- Added opt-in, provider-neutral delegation provenance enforcement. A trusted
  host signs the exact finalized commit, policy/profile, worker capability,
  accepted story receipts, validation and independent review with Ed25519;
  broker publication rejects missing, forged or stale evidence before push.
  Explicit frontier-only exemptions require separate authority evidence.
- Added the provider-neutral `runFrontierSupervisorV4` control loop for real
  frontier-led delegation: persisted rejection evidence is converted into a
  bounded `RETRY` or `ESCALATE`, repair attempts use fresh worker sessions, and
  malformed decisions, crashes and exhausted decision budgets fail closed.
- Aligned the OpenCode runner with the native JSONL protocol emitted by the
  pinned 1.18.15 harness and verified 1.18.16 (`step_start`, `text`,
  `tool_use`, `step_finish`). Launches now pin pure/auto JSON execution and the
  capsule directory; malformed sequences, mixed sessions and unapproved tools
  fail closed. Added a provider-neutral checklist that distinguishes actual
  worker delegation from passive repository instructions or frontier fallback.
- Corrected the README compiler Quick start and privileged Runtime V4 command
  examples, marked superseded V1/V2 plans as historical, and generalized
  consumer-derived architecture notes. Executable documentation contracts now
  protect the Quick start, activation binding and historical-status boundary.
- Centralized the Runtime V4 broker qualification identity and aligned it with
  package `0.2.0` as `0.2.0-v4`. Package-version parity is now a release test;
  existing Docker sandbox evidence bound to `0.1.0-v4` requires fresh
  certification.
- Documented provider-neutral context-engineering invariants: deterministic
  prompt prefixes, immutable per-attempt tool surfaces, progressive disclosure,
  restorable failure evidence, explicit cache telemetry and serial
  contract-write authority with optional read-only discovery fan-out.
- Docker CLI subprocesses use an explicit launcher directory instead of the
  caller's process-wide working directory. Recovery tests no longer mutate
  shared `process.cwd()`, and their outer watchdog leaves margin above the
  unchanged internal recovery deadlines.
- Frontier-led retries now persist a canonical, authority-bound decision before
  worker launch and bind its hash into the next iteration. Crash replay rejects
  absent, altered, duplicate, stale and cross-mode decision evidence.

### Removed

- Completed tool-specific `docs/superpowers/` implementation plans from the
  active documentation and npm package. Git history remains the archive.
- The frozen, unexecuted ArliAI pilot fixture. It produced no run evidence and
  its retired-provider assumptions must not be mistaken for a current example.

## 0.2.0 - 2026-08-11

This is the first formal 0.x release after the Runtime V4 host-boundary
consolidation. It remains pre-1.0 and does not imply a universal production
host qualification.

### Added

- Package-integrity validation based on the real `npm pack` file list and all
  local links in the published README/documentation set.
- Explicit `runtime-v4/contracts`, `runtime-v4/host` and
  `runtime-v4/experimental` package subpaths plus a guarded default API.
- Repository threat model, security policy, contribution contract,
  compatibility matrix, platform CI and a manually invoked hostile Docker
  certification workflow.
- Release workflow that validates the tag, emits an npm tarball, checksum,
  SBOM and build provenance.
- Portable test discovery and Windows path canonicalization that preserves
  rejection of symbolic links/reparse points while accepting equivalent 8.3
  path spellings on the supported platform matrix.
- Consumer adoption and handoff guidance that distinguishes pattern-only,
  bounded-local, analysis-only, isolated-execution and autonomous-publication
  evidence levels, with a clone-to-analysis walkthrough.

### Package migration

- Consumers importing low-level Runtime V4 modules from the default
  `runtime-v4` entry point must move those imports to `runtime-v4/contracts`,
  `runtime-v4/host` or `runtime-v4/experimental` as appropriate.
- The package version is now `0.2.0`; host/profile changes still require exact
  fresh qualification and do not become production-certified by this release.

### Runtime and deployment changes

- Platform CI and manual host certification now exercise Ubuntu and Windows on
  Node 20, 22 and 24, matching the supported `>=20` engine range more closely.

### Runtime and evidence additions

- A bounded, seeded dispatcher state-machine model test covering pause, run,
  admission, crash/recovery, drain and abort invariants with replayable
  counterexamples.
- A hash-bound `dogfood-v1` manifest and run-record contract that freezes exact
  bindings, a 20–30 case paired/interleaved corpus, independent review,
  report-only authority, required operational metrics and hard pilot stop
  conditions. The contract also verifies the real post-acceptance window,
  recalculates human and total cost from a frozen policy, validates complete
  run sets, binds execution identities per route, and freezes the report
  formulas through an analysis-policy hash.
- Dogfood evidence hardening with verified `STRICT_SERIAL` execution, a
  hash-bound `DogfoodStopEventV1` for operationally stopped prefixes, explicit
  run-record semantic invariants, and V3 pricing/usage reproduction for
  provider cost and frontier-usage metrics, including all scheduled runs.
- A packaged delegation-practice runbook covering deterministic frontend/backend stack guidance, full-stack story decomposition, validation evidence and fail-closed escalation without provider-specific core policy.
- Provider-neutral worker capability snapshots that bind plans to exact model, endpoint, harness, parser, tool, instruction/skill and qualification identities plus qualified story limits.
- Hash-verified structured repair packets and normalized no-progress detection for bounded iterative execution.
- Broker-owned host composition that starts the authenticated IPC daemon, schedules one pipeline flight per run and persists accepted, failed and aborted terminal evidence.
- A self-contained host bundle and content-addressed central installer with per-file SHA-256 verification.
- Portable, hash-bound repository activation and a central repository registry.
- A thin trusted-root contract plus independently certified host-component ports, allowing providers, models and host implementations to change without changing repository policy.
- A strict eight-component host manifest with per-module/interface/evidence certification, dependency-bound recertification, aggregate integration evidence and narrow runtime ports.
- Runtime CLI commands `install`, `verify-installation` and `activate`; daemon, MCP, doctor and status load only an activation-bound certified host composition.

### Changed

- Iterative stories now declare required capabilities and explicit file, line, context, step, dependency and attempt budgets; worker drift or an oversized story fails before execution.
- Fresh autonomous dispatcher state now starts in `PAUSED`; admission requires an explicit durable transition to `RUNNING`. Circuit reset requires `PAUSED` and cannot resume admission by itself.
- Generated Codex MCP configuration can point to a central immutable entrypoint and exact activation manifest while retaining the legacy project-local rendering API for compatibility.
- Run state now records candidate acceptance and explicit abort durably. Terminal completion releases the repository lock.
- Runtime deployment documentation now distinguishes one-time machine composition from per-repository policy/profile activation.
- Host loading now verifies task intake, issue planning, practice-pack resolution, credential gateway, sandbox coordination, capability issuance, GitHub publication and post-merge verification before importing the thin root.
- Installation identity now includes aggregate host certification as well as installed bytes, and repository activation binds the exact `hostCompositionHash`.
- Dogfood run-set verification now derives the first observable hard stop from
  run evidence, rejects a `COMPLETE` result without its hash-bound stop event,
  and freezes the provider usage registry, role-to-binding topology, required
  usage roles per strategy and run/event identity references. Frontier usage
  now counts all strong-capability planner, executor and reviewer calls rather
  than only strong executor calls.

### Fixed

- Relaxed the Windows Docker termination timing assertion to match the bounded `taskkill` and process-absence cleanup contract instead of relying on a sub-second runner timing.
- Stabilized the stale-lock reclamation regression test with an explicit queue
  barrier so Node-version scheduling cannot release the first contender before
  the second contender has entered the certified reclamation queue.
- Serialized test-file execution in the cross-platform validation runner so
  Windows and Node-version scheduling cannot introduce nondeterministic
  inter-file races during the full suite.
- Hardened dogfood semantic evidence so first-pass acceptance, human
  intervention time and reviewer rejection history cannot be misreported;
  stop events now prove derived failure causes against the triggering run and
  support pre-run system stops at ordinal zero.

- Hostile Docker certification tests no longer resolve a Docker executable during module import when no certification image is configured. Clean hosts without Docker now skip the opt-in integration suite instead of failing test discovery; configured certification still fails closed when Docker is unavailable.

### Runtime migration

- Existing iterative story plans and persisted iteration events predate the required worker, budget, repair and failure-signature bindings and must start a new run. Host adapters must now provide the active worker snapshot, measured changed lines, normalized failure signatures and hash-verified repair-packet loading.
- Existing dispatcher state keeps its persisted mode. Before upgrading a host whose state is `RUNNING`, explicitly switch it to `PAUSED` if the deployment must remain inactive after restart; only newly created state adopts the new paused default.
- Existing generated project-local runtime paths remain supported but are not a certified production deployment.
- Build a new host bundle, install it centrally, then activate each repository explicitly. Existing unmanaged Codex configuration is never overwritten.
- A model/profile, component or root change produces new hashes and requires dependency-aware requalification plus new aggregate evidence; it is not applied automatically to existing activations.
- The unpublished pre-release single-file host-driver format is no longer executable. Split host code behind the eight fixed ports, generate a manifest conforming to `runtime-host-components-v4.schema.json` with retained qualification evidence, reinstall with both `--host-driver` and `--host-components`, and reactivate each repository. Do not edit old installation or activation manifests in place.
