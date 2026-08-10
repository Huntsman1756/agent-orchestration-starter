# Central host installation and portable repository activation V4

Runtime V4 is installed once per trusted machine and activated by reference in any number of Git repositories. A repository never receives a copy of the broker, provider credentials, GitHub credentials, daemon state, or host adapter.

## Ownership boundary

| Location | Owner | Contents |
| --- | --- | --- |
| central host root | machine operator | immutable runtime installations, repository registry and broker state |
| trusted host-driver path | machine operator | native coordinator/verifier and provider/harness composition |
| repository | repository owner | policy, replaceable model profile and `.agent-orchestration/activation-v4.json` |
| `.codex/config.toml` | repository owner | read-only frontier context and one required MCP binding to the central runtime |

The stable policy names roles, capabilities, source sensitivity and permissions. Model/provider identifiers and their dated guidance stay in the replaceable profile. The host driver is configured once per machine and must not contain repository routing rules.

## Build and install once

`npm run build` emits `dist/host/agent-orchestration.mjs`, an ESM bundle containing JavaScript dependencies. Runtime schemas remain in `contracts/`; certified native helpers remain in `dist/native/`. The installer copies that closed set into a content-addressed installation, rejects symlinks and non-regular entries, and records every byte with SHA-256.

```powershell
node dist/host/agent-orchestration.mjs runtime install `
  --source-root G:\_Proyectos\agent-orchestration-starter `
  --host-root C:\ProgramData\agent-orchestration `
  --host-driver C:\ProgramData\agent-orchestration-drivers\production-v4.mjs
```

`--host-driver` is optional for analysis-only installation. Isolated execution remains fail-closed without it. The resulting manifest is at `HOST_ROOT/installations/<version>-<content-hash>/installation-v4.json`. Repeating the exact installation is idempotent. Changing any installed byte or the driver makes verification fail:

```powershell
node <entrypoint> runtime verify-installation --manifest <installation-v4.json>
```

The host driver is trusted broker code, not a model plugin. Supply it as a self-contained ESM file. The installer copies it into the immutable installation, and the original source path is no longer used. It exports exactly `createRuntimeHostDriverV4(context)` and returns four bounded operations: `daemon`, `mcpStdio`, `doctor`, and `status`. Its installed path and SHA-256 are pinned and verified before dynamic import. Updating a driver or provider adapter therefore creates a new installation identity and requires new host evidence; it never silently changes existing activations.

## Activate each repository

Activation supplies only repository-owned inputs and references the central installation:

```powershell
node <entrypoint> runtime activate `
  --repository-root G:\_Proyectos\my-project `
  --policy G:\_Proyectos\my-project\policies\repository-policy.yaml `
  --profile G:\_Proyectos\my-project\profiles\runtime.yaml `
  --worktree-parent G:\_Worktrees\my-project `
  --installation-manifest <installation-v4.json> `
  --host-root C:\ProgramData\agent-orchestration `
  --target ANALYSIS_ONLY
```

The command verifies the Git root, canonical paths, policy/profile contracts, repository ID, immutable installation and an external worktree parent. It derives the Codex frontier model and reasoning effort from the orchestrator binding rather than accepting a second, drifting model flag. It writes a hash-bound activation manifest, registers the repository centrally and creates the required Codex MCP binding. It never overwrites an existing different activation or unmanaged `.codex/config.toml`; in that case merge the generated MCP block deliberately and rerun.

Activation is registration, not certification. `ANALYSIS_ONLY`, `ISOLATED_EXECUTION`, and `AUTONOMOUS_PUBLICATION` express intended authority. Before either execution target, `runtime doctor --activation <path>` and `assessRuntimeActivationV4` must report verified native composition, credential isolation, gateway compatibility, exact capability qualification and Docker certification. Autonomous publication additionally requires a GitHub credential lease. Missing evidence or a missing driver yields `CAPABILITY_UNVERIFIED`; there is no direct-write fallback.

## Provider and model changes

- Change a model or provider by adding a new profile revision and guidance pack.
- Requalify the exact harness/provider/model/driver/policy identity with three clean runs.
- Keep repository policy unchanged unless authority or project risk rules changed.
- Replace the central host driver only when a protocol, credential mechanism, coordinator or host adapter changes.
- Create a new installation and reactivate deliberately; do not mutate a pinned installation.

Future adapters should implement the same driver boundary. They may compose `createRuntimeHostCompositionV4`, but must keep credentials in a broker-owned gateway, use certified platform verifiers/coordinators and persist accepted, failed and aborted lifecycle transitions before acknowledging controls.

## Known deployment work

The repository now supplies native composition factories, complete lifecycle persistence, an immutable installer, portable activation and a hash-pinned driver loader. It intentionally does not ship a universal production host driver: saved subscriptions, API credentials, Docker, native cross-process coordination and provider protocols differ by host. Each supported host/provider combination still needs certification and evidence; each target repository does not need custom orchestrator code.

Contract changes are additive under schema version 4. Breaking changes require a new schema version, migration notes, a new installation identity and explicit repository reactivation.
