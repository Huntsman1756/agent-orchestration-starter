# Changelog

## Unreleased

### Added

- Broker-owned host composition that starts the authenticated IPC daemon, schedules one pipeline flight per run and persists accepted, failed and aborted terminal evidence.
- A self-contained host bundle and content-addressed central installer with per-file SHA-256 verification.
- Portable, hash-bound repository activation and a central repository registry.
- A trusted host-driver contract pinned by absolute path and SHA-256, allowing providers, models and host implementations to change without changing repository policy.
- Runtime CLI commands `install`, `verify-installation` and `activate`; daemon, MCP, doctor and status can load an activation-bound host driver.

### Changed

- Generated Codex MCP configuration can point to a central immutable entrypoint and exact activation manifest while retaining the legacy project-local rendering API for compatibility.
- Run state now records candidate acceptance and explicit abort durably. Terminal completion releases the repository lock.
- Runtime deployment documentation now distinguishes one-time machine composition from per-repository policy/profile activation.

### Migration

- Existing generated project-local runtime paths remain supported but are not a certified production deployment.
- Build a new host bundle, install it centrally, then activate each repository explicitly. Existing unmanaged Codex configuration is never overwritten.
- A model/profile or host-driver change produces new hashes and requires requalification; it is not applied automatically to existing activations.
