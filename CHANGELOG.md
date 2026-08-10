# Changelog

## Unreleased

### Added

- Provider-neutral worker capability snapshots that bind plans to exact model, endpoint, harness, parser, tool, instruction/skill and qualification identities plus qualified story limits.
- Hash-verified structured repair packets and normalized no-progress detection for bounded iterative execution.
- Broker-owned host composition that starts the authenticated IPC daemon, schedules one pipeline flight per run and persists accepted, failed and aborted terminal evidence.
- A self-contained host bundle and content-addressed central installer with per-file SHA-256 verification.
- Portable, hash-bound repository activation and a central repository registry.
- A trusted host-driver contract pinned by absolute path and SHA-256, allowing providers, models and host implementations to change without changing repository policy.
- Runtime CLI commands `install`, `verify-installation` and `activate`; daemon, MCP, doctor and status can load an activation-bound host driver.

### Changed

- Iterative stories now declare required capabilities and explicit file, line, context, step, dependency and attempt budgets; worker drift or an oversized story fails before execution.
- Fresh autonomous dispatcher state now starts in `PAUSED`; admission requires an explicit durable transition to `RUNNING`. Circuit reset requires `PAUSED` and cannot resume admission by itself.
- Generated Codex MCP configuration can point to a central immutable entrypoint and exact activation manifest while retaining the legacy project-local rendering API for compatibility.
- Run state now records candidate acceptance and explicit abort durably. Terminal completion releases the repository lock.
- Runtime deployment documentation now distinguishes one-time machine composition from per-repository policy/profile activation.

### Fixed

- Hostile Docker certification tests no longer resolve a Docker executable during module import when no certification image is configured. Clean hosts without Docker now skip the opt-in integration suite instead of failing test discovery; configured certification still fails closed when Docker is unavailable.

### Migration

- Existing iterative story plans and persisted iteration events predate the required worker, budget, repair and failure-signature bindings and must start a new run. Host adapters must now provide the active worker snapshot, measured changed lines, normalized failure signatures and hash-verified repair-packet loading.
- Existing dispatcher state keeps its persisted mode. Before upgrading a host whose state is `RUNNING`, explicitly switch it to `PAUSED` if the deployment must remain inactive after restart; only newly created state adopts the new paused default.
- Existing generated project-local runtime paths remain supported but are not a certified production deployment.
- Build a new host bundle, install it centrally, then activate each repository explicitly. Existing unmanaged Codex configuration is never overwritten.
- A model/profile or host-driver change produces new hashes and requires requalification; it is not applied automatically to existing activations.
