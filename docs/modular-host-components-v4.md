# Modular trusted host components V4

## Purpose and status

The production host boundary is privileged code. Runtime V4 therefore does not treat a large host driver as ordinary configuration or certify it under one opaque hash. A deployable host is one thin composition root plus eight independently identified, hash-pinned and qualified components. The root can still be distributed in one release artifact, but installation materializes each component as a separate self-contained ESM module and verifies its own certification chain before import.

This repository defines and enforces the contracts, installation format, dependency graph and loader. It intentionally does not ship universal production implementations or manufacture qualification evidence. The machine operator or certification service owns those artifacts and evidence.

## Fixed components and narrow ports

| Component ID | Exact public port | Certified dependencies | Responsibility |
| --- | --- | --- | --- |
| `credential_gateway` | `leaseProvider`, `leaseGitHub`, `revoke` | none | Keep real provider and GitHub credentials behind broker-owned internal gateways |
| `task_source` | `listCandidates`, `loadCandidate`, `claim`, `renew`, `complete`, `reopen`, `fail` | `credential_gateway` | GitHub/CI/scheduled intake, immutable revisions, leases and source-state mutations |
| `issue_planner` | `plan` | `task_source` | Convert an authorized candidate into a bounded `RuntimeTaskRequestV4` |
| `practice_pack_resolver` | `resolve` | `issue_planner` | Resolve allowlisted stack evidence and immutable practice/instruction packs |
| `sandbox_coordinator` | `id`, `probe`, `run`, `terminate` | `credential_gateway` | Certified process/container isolation and native coordination |
| `capability_issuer` | `issue` | `practice_pack_resolver`, `credential_gateway`, `sandbox_coordinator` | Issue evidence for the exact model/harness/parser/tool/policy binding |
| `github_publisher` | `pushExact`, `findPullRequest`, `createPullRequest`, `waitForRequiredChecks`, `mergePullRequest` | `credential_gateway` | Broker-owned exact-SHA push, PR, checks and merge |
| `post_merge_verifier` | `verify` | `credential_gateway`, `github_publisher`, `sandbox_coordinator` | Verify the exact merged commit before completing or reopening a source task |

Task intake and GitHub publication are deliberately separate. Read/list/lease authority does not imply push/merge authority. Both request a purpose- and operation-bounded GitHub gateway lease; the returned component-visible token is the fixed non-secret broker token, not the real GitHub credential. Provider/model leases use a separate method and endpoint. Likewise, the practice-pack resolver cannot issue a model capability, and the capability issuer cannot create new credentials or bypass the sandbox.

The TypeScript ports are exported from `agent-orchestration-starter/runtime-v4`. `runtimeHostComponentInterfaceHashV4(id)` derives the fixed V4 interface hash from the named V4 type contract and exact member surface. Extra members, missing members, the wrong member type or an empty sandbox ID fail with `CAPABILITY_UNVERIFIED`.

## Source manifest and certification chain

The strict source format is [`runtime-host-components-v4.schema.json`](../contracts/runtime-host-components-v4.schema.json). It contains:

- the exact root-driver SHA-256;
- one canonical entry for every component, in the order shown above;
- an immutable implementation revision: a full 40/64-character Git object ID or `sha256:<64 hex>` artifact identity;
- a normalized relative `.mjs` path and its SHA-256;
- the core-derived interface hash;
- the hash of external qualification evidence;
- exact dependency component IDs and certification hashes;
- the component certification hash;
- independent end-to-end integration evidence and the aggregate composition certification hash.

The public helpers `runtimeHostComponentCertificationHashV4` and `runtimeHostCompositionCertificationHashV4` create the canonical hashes. The chain is conceptually:

```text
component certification = H(
  component ID,
  immutable revision,
  module SHA-256,
  interface hash,
  qualification-evidence hash,
  exact dependency certification hashes
)

composition certification = H(
  root-driver SHA-256,
  end-to-end integration-evidence hash,
  all eight component certification hashes
)
```

The runtime can prove that the installed bytes, declarations and dependency chain match those hashes. It cannot prove that an external evidence artifact was honestly produced merely from its digest. The trusted qualification authority must retain the evidence, bind it to the exact certification subject and refuse reuse after any subject change.

## Installation and loading

The executable host requires both inputs:

```powershell
node dist/host/agent-orchestration.mjs runtime install `
  --source-root G:\_Proyectos\agent-orchestration-starter `
  --host-root C:\ProgramData\agent-orchestration `
  --host-driver C:\ProgramData\agent-orchestration-drivers\production-v4\root.mjs `
  --host-components C:\ProgramData\agent-orchestration-drivers\production-v4\host-components-v4.json
```

Supplying only one is rejected. Omitting both creates an analysis-only installation with no executable host authority.

The installer rejects source symlinks, non-regular files, path escape, case-fold ambiguity, unknown fields, mutable revisions, artifact drift, interface drift, missing components, dependency drift and aggregate-certificate drift. It copies modules to `host-components/<component-id>.mjs`, verifies copied bytes, and includes both installed bytes and the aggregate certification in the immutable installation identity. Renewing evidence over unchanged binaries therefore creates a different installation instead of rewriting an existing one.

At startup the loader:

1. verifies the repository activation, complete installation and explicit composition hash binding;
2. loads components in dependency order and rechecks each installed SHA-256;
3. requires each module to export only `createRuntimeHostComponentV4(context)`;
4. gives the factory repository identity/root/state/target plus only its declared dependency ports;
5. validates and freezes the exact returned port;
6. imports the root only after all eight components pass;
7. calls `createRuntimeHostDriverV4({ activation, installation, components })` and accepts only `daemon`, `mcpStdio`, `doctor` and `status`.

Component modules and the root must be self-contained ESM. The core does not follow or certify hidden relative imports. A release build may package shared implementation code beforehand, but every installed module must contain the closed bytes covered by its own hash.

## Thin composition-root rule

The root driver wires verified ports into `createRuntimeHostCompositionV4`; it should not reimplement task intake, planning, credential access, sandboxing, publication or post-merge verification. It remains privileged because it can coordinate all ports, so its own SHA and end-to-end composition evidence are mandatory. Per-component tests do not replace an end-to-end test of the exact root plus all exact component certifications.

Language-level module separation is not an operating-system security boundary. Credentials must still remain behind the gateway, model work must still run in a certified sandbox, and production native coordination is currently certified only for the exact supported `linux-x64` deployment. Windows, Linux and macOS require separate host evidence.

## Recertification matrix

| Change | Minimum required action |
| --- | --- |
| Component bytes, immutable revision or port contract | Requalify that component, every dependent component and the complete composition |
| `credential_gateway` | Requalify every component and the complete composition because task intake, execution and publication all depend on it directly or transitively |
| `task_source` | Requalify task source, issue planner, practice-pack resolver, capability issuer and composition |
| Practice packs or resolver behavior | Requalify resolver, capability issuer, affected model/harness bindings and composition |
| Provider/model/profile only, with unchanged compatible host code | Keep stable repository policy; reactivate the repository and issue fresh exact binding capability evidence; retain the installation |
| Harness/parser/tool/protocol or host adapter bytes/configuration | Requalify affected components and dependents, renew aggregate composition evidence, create a new installation and reactivate |
| Root composition code | Requalify the full composition even when all component files are unchanged |
| Repository policy or authority target | Reactivate that repository and requalify every exact policy-bound capability; do not mutate the central installation |
| OS, architecture, Docker engine, native helper or credential mechanism | Treat it as a different host and run target-specific certification |

The dependency graph is a minimum recertification graph, not permission inheritance. A host operator may require broader recertification.

## Migration from the legacy single driver

The pre-release single-file `--host-driver` format is no longer executable. Before a pilot:

1. split the implementation behind the eight fixed ports;
2. remove GitHub write operations from the task-source adapter;
3. ensure the root only composes verified ports;
4. qualify each exact component and retain its evidence;
5. generate the strict source manifest and end-to-end evidence;
6. install with both flags;
7. reactivate every repository so `hostCompositionHash` binds the new composition;
8. start the autonomous dispatcher in `PAUSED`, run doctor/status, and admit one synthetic low-risk task deliberately.

This is a pre-1.0 host-deployment migration. Existing installation and activation manifests must be rebuilt rather than edited in place. Pin the exact resulting commit and installation hash for a pilot; do not track mutable `main`.
