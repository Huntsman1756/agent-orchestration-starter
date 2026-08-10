# Central host installation and portable repository activation V4

Runtime V4 is installed once per trusted machine and activated by reference in any number of Git repositories. A repository never receives a copy of the broker, provider credentials, GitHub credentials, daemon state, or host adapter.

## Ownership boundary

| Location | Owner | Contents |
| --- | --- | --- |
| central host root | machine operator | immutable runtime installations, repository registry and broker state |
| trusted host release path | machine operator | thin root, strict component manifest and eight independently certified host modules |
| repository | repository owner | policy, replaceable model profile and `.agent-orchestration/activation-v4.json` |
| `.codex/config.toml` | repository owner | read-only frontier context and one required MCP binding to the central runtime |

The stable policy names roles, capabilities, source sensitivity and permissions. Model/provider identifiers and their dated guidance stay in the replaceable profile. Host code is installed once per machine and must not contain repository routing rules. The privileged boundary is modular even when one release artifact distributes it; see [`modular-host-components-v4.md`](modular-host-components-v4.md).

The checked-in [reference host fixture](../examples/reference-host-driver/README.md)
is deliberately non-authoritative. It demonstrates the loader and durable
lifecycle without credentials or network access; it does not satisfy a
production activation gate.

## Build and install once

`npm run build` emits `dist/host/agent-orchestration.mjs`, an ESM bundle containing JavaScript dependencies. Runtime schemas remain in `contracts/`; certified native helpers remain in `dist/native/`. The installer copies that closed set into a content-addressed installation, rejects symlinks and non-regular entries, and records every byte with SHA-256.

```powershell
node dist/host/agent-orchestration.mjs runtime install `
  --source-root G:\_Proyectos\agent-orchestration-starter `
  --host-root C:\ProgramData\agent-orchestration `
  --host-driver C:\ProgramData\agent-orchestration-drivers\production-v4\root.mjs `
  --host-components C:\ProgramData\agent-orchestration-drivers\production-v4\host-components-v4.json
```

`--host-driver` and `--host-components` must be supplied together. Omitting both is allowed for analysis-only installation; supplying only one is rejected. Isolated execution remains fail-closed without the complete pair. The resulting manifest is at `HOST_ROOT/installations/<version>-<content-and-certification-hash>/installation-v4.json`. Repeating the exact installation is idempotent. Changing any installed byte, component certification, aggregate evidence or root makes a new installation identity; modifying an existing installation makes verification fail:

```powershell
node <entrypoint> runtime verify-installation --manifest <installation-v4.json>
```

The root and components are trusted broker code, not model plugins. Every component is a self-contained ESM file exporting only `createRuntimeHostComponentV4(context)` and one fixed narrow port. The root exports only `createRuntimeHostDriverV4(context)` and returns `daemon`, `mcpStdio`, `doctor`, and `status`. The runtime verifies all component bytes and dependency certifications before it imports the root. The root receives the verified component set and should contain composition only. Original source paths are never used after installation.

The activation records `hostCompositionHash` in addition to the installation hash. This makes the exact aggregate certificate visible and prevents a repository activation from drifting to another root/component combination even when paths are reused.

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

- Change a model or provider by adding a new profile revision and guidance pack; do not change stable repository policy unless authority or project risk rules changed.
- Reactivate the repository and requalify the exact harness/provider/model/component/policy binding with three clean runs. A profile-only change does not require a new central installation when the existing component protocol and code remain valid.
- If adapter, gateway, sandbox, root or other host bytes/configuration change, replace and recertify only the affected components plus declared dependents, renew complete composition evidence and create a new installation.
- Never mutate a pinned installation or silently carry qualification evidence across a changed binding.

Future adapters should implement the same component ports. The thin root may compose `createRuntimeHostCompositionV4`, but credentials stay in the broker-owned gateway, platform verifiers/coordinators remain certified and accepted, failed and aborted lifecycle transitions are persisted before controls are acknowledged.

An adapter for OpenHands, another agent framework or a different sandbox backend follows
the same rule. Before installation, pin and qualify its source, image, launcher, host,
credential boundary and policy with
[`external-runtime-qualification-v4.md`](external-runtime-qualification-v4.md). A
vendor's default sandbox status does not transfer into the activation manifest.

## Known deployment work

The repository now supplies native composition factories, complete lifecycle persistence, an immutable installer, portable activation and a component-aware loader. It intentionally does not ship universal production host components: saved subscriptions, API credentials, Docker, native cross-process coordination and provider protocols differ by host. Each supported host/provider combination still needs certification and evidence; each target repository does not need custom orchestrator code.

The modular format replaces the unpublished pre-release single-driver host format while the package remains pre-1.0. Existing installation and activation manifests must be rebuilt and repositories explicitly reactivated; they must not be edited in place. After a stable host-format release, breaking changes require a new schema version and migration notes.
