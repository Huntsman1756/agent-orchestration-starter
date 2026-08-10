# Changelog

## 0.2.0 - 2026-08-10

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

### Migration

- Consumers importing low-level Runtime V4 modules from the default
  `runtime-v4` entry point must move those imports to `runtime-v4/contracts`,
  `runtime-v4/host` or `runtime-v4/experimental` as appropriate.
- The package version is now `0.2.0`; host/profile changes still require exact
  fresh qualification and do not become production-certified by this release.

## Unreleased

### Added

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

### Fixed

- Hostile Docker certification tests no longer resolve a Docker executable during module import when no certification image is configured. Clean hosts without Docker now skip the opt-in integration suite instead of failing test discovery; configured certification still fails closed when Docker is unavailable.

### Migration

- Existing iterative story plans and persisted iteration events predate the required worker, budget, repair and failure-signature bindings and must start a new run. Host adapters must now provide the active worker snapshot, measured changed lines, normalized failure signatures and hash-verified repair-packet loading.
- Existing dispatcher state keeps its persisted mode. Before upgrading a host whose state is `RUNNING`, explicitly switch it to `PAUSED` if the deployment must remain inactive after restart; only newly created state adopts the new paused default.
- Existing generated project-local runtime paths remain supported but are not a certified production deployment.
- Build a new host bundle, install it centrally, then activate each repository explicitly. Existing unmanaged Codex configuration is never overwritten.
- A model/profile, component or root change produces new hashes and requires dependency-aware requalification plus new aggregate evidence; it is not applied automatically to existing activations.
- The unpublished pre-release single-file host-driver format is no longer executable. Split host code behind the eight fixed ports, generate a manifest conforming to `runtime-host-components-v4.schema.json` with retained qualification evidence, reinstall with both `--host-driver` and `--host-components`, and reactivate each repository. Do not edit old installation or activation manifests in place.
