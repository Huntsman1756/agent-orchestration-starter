# Agent Orchestration Starter

Provider-neutral agent orchestration runtime and control plane for bounded,
evidence-driven repository work. A frontier-capable planner/reviewer can
delegate small implementation stories to a cheaper qualified worker while the
broker retains policy, sandbox, validation, review and publication authority.

```text
authorized task source
        │
        ▼
planner/frontier ── typed contract + capability snapshot ──► economy/frontier worker
        │                                                       │
        └────────────── broker-owned validation ◄───────────────┘
                              │
                        independent review
                              │
               local commit → exact-SHA PR/merge (optional)
```

The stable policy describes roles, capabilities, repository boundaries and
acceptance criteria. Provider, model, harness, tool parser, guidance and
skill bundles are replaceable profile data. A model response is never an
authority to widen the contract, choose a route, approve its own output or
publish a commit.

## Status

This repository is pre-1.0. Runtime V4 is a fail-closed framework with a
portable installer, not a universal unattended production service. The
production host driver, credential gateway, native coordinator, provider
gateway, sandbox and exact binding qualification are deployment obligations.
The current native broker evidence is for Linux x64; Windows and macOS need
separate host evidence. See the [compatibility matrix](docs/compatibility-matrix-v4.md).

## Quick start

Requires Node.js 20 or newer.

```powershell
npm ci
npm run validate
npm run build
node dist/cli/main.js init `
  --target G:\_Proyectos\my-project `
  --policy orchestration.yaml `
  --profile profiles/runtime.example.yaml `
  --harnesses codex,opencode
```

Inspect first with `--dry-run`. Use `check` to detect local drift and `doctor`
to verify selected harnesses. The CLI does not write credentials or global
tool configuration.

```powershell
node dist/cli/main.js check --target G:\_Proyectos\my-project --policy orchestration.yaml --profile profiles/runtime.example.yaml
node dist/cli/main.js doctor --harnesses codex,opencode --policy orchestration.yaml --profile profiles/runtime.example.yaml
```

## Autonomous lifecycle

The intended autonomous loop is bounded and durable:

1. A privileged task source admits an allowlisted candidate under a lease.
2. A frontier planner turns it into a complete typed contract and sizes
   stories for the active worker capability.
3. The broker creates an isolated worktree/capsule and starts one story in a
   fresh coding context.
4. The qualified worker edits only contract-authorized paths and runs the
   declared deterministic validations.
5. The broker re-inspects paths, records evidence and sends a clean bounded
   review packet to an independent reviewer.
6. Failures become verified repair packets; repeated normalized failures
   escalate or stop instead of looping forever.
7. Finalization creates a local commit. Publication, if policy allows it, is a
   broker-owned exact push, PR, required-check and head-bound merge sequence.

The [iterative executor](docs/iterative-executor-v4.md) is inspired by Ralph:
one dependency-ready story per context, explicit budgets and retry from the
last accepted tree. It is not a free-running shell loop. The model cannot mark
its own story complete, read prior hidden reasoning, grant itself tools or
publish changes.

The outer [autonomous dispatcher](docs/autonomous-dispatcher-v4.md) starts in
`PAUSED`, requires a durable transition to `RUNNING`, recovers leases and
rechecks the exact merge SHA after publication. Circuit recovery also requires
an explicit paused/reactivation sequence.

## Routing and evidence

The supported strategies are:

- `economy_only`: localized mechanical work with a qualified economical worker;
- `orchestrated`: frontier planning/review around a bounded economical worker;
- `frontier_execution`: frontier worker for security, architecture, ambiguity,
  migrations or other high-risk work.

The routing gate is advisory and does not change routing automatically. V2
requires at least 30 comparable pairs per `taskClass × candidate ×
frontier_execution`, matched by `taskId + caseFingerprint`. It protects both
first-pass and final acceptance; no cheaper candidate may reduce final
acceptance under the conservative initial policy. Escalations, repairs and
rescues remain part of real cost. See [routing gate](routing-gate.yaml), the
[benchmark examples](examples/benchmark-observations.jsonl), and the V3
[pilot design](docs/superpowers/plans/2026-08-08-telemetry-routing-schema-v3.md).

```powershell
node dist/cli/main.js benchmark `
  --observations examples/benchmark-observations.jsonl `
  --routing-policy routing-gate.yaml
```

The offline V3 pilot separates append-only observations from later evaluation,
preserves incomplete usage as incomplete, and never invents missing evidence.
It does not invoke a provider, merge code or promote a route.

## Provider and model neutrality

The orchestrator selects roles and capabilities, not permanent vendor names.
Each binding carries a versioned guidance pack, inference controls, tool/parser
identity and qualification evidence. Changing a model or provider profile does
not require changing repository contracts, but it does require fresh exact
qualification of the new binding. A model name alone is never evidence.

`profiles/runtime.example.yaml` is intentionally provider-neutral.
`profiles/nan-opencode.example.yaml` and
`profiles/runtime.chatgpt-subscription.example.yaml` are dated examples, not
credentials or live-certification claims. An economical worker may be Qwen,
Gemma, a future provider or a local model; the frontier planner sizes stories
from the worker's declared capability and limits rather than assuming a fixed
model.

The runtime rejects malformed native tool protocols and textual pseudo-calls
such as `<tool_call>`; it does not convert them into executable authority.
External agent runtimes and sandbox launchers must pass the
[qualification procedure](docs/external-runtime-qualification-v4.md) before
they can back a trusted component. Container use alone does not imply hard
isolation.

## Runtime V4 and the host boundary

Runtime V4 provides strict contracts, capability gates, isolated executor and
reviewer building blocks, deterministic validation, bounded telemetry,
durable broker state, a daemon/IPC composition factory, a content-addressed
installer and hash-bound repository activation.

The privileged host is split into eight separately certified ports: task
source, issue planner, practice-pack resolver, credential gateway, sandbox
coordinator, capability issuer, GitHub publisher and post-merge verifier. The
thin root verifies each module, dependency certificate, interface and
aggregate composition before importing it. See [modular host components](docs/modular-host-components-v4.md)
and [host installation](docs/host-installation-v4.md).

The project deliberately does not ship saved ChatGPT/Codex authentication,
provider API keys or a universal production host implementation. Missing or
unqualified host evidence fails closed with `CAPABILITY_UNVERIFIED`; there is
no direct-edit fallback. The same central installation can serve unrelated
repositories, but each repository supplies its own policy, profile, activation
and publication decision.

The Linux native broker helper is built for the target architecture and is
never compiled at runtime. Windows and macOS may run the portable JavaScript
surfaces where their exact host/coordinator/sandbox evidence supports them;
Linux evidence must not be reused implicitly.

## Package API

The default `agent-orchestration-starter/runtime-v4` entry point is deliberately
small. Low-level boundaries are explicit:

- `agent-orchestration-starter/runtime-v4/contracts`
- `agent-orchestration-starter/runtime-v4/host`
- `agent-orchestration-starter/runtime-v4/experimental`

See the [public API contract](docs/runtime-public-api-v4.md). Internal emitted
modules are not package API merely because they exist in `dist/`.

## Installation, publication and release

Install Runtime V4 once on a trusted machine, then activate each repository
against a content-hashed installation. The activation binds policy, profile,
target and aggregate host composition. Profile-only changes need fresh
binding qualification; host bytes, components, native helpers or composition
changes need dependency-aware recertification and a new installation.

Publication is optional and repository-owned. It never force-pushes, deletes
branches, deploys or lets a model choose the PR/merge settings. A formal `0.x`
release emits a validated npm tarball, checksum, SBOM and build provenance;
the release workflow is tag-driven and its GitHub Actions are pinned by SHA.
The native tarball is intentionally produced on certified Linux x64 only;
local `npm pack` on Windows/macOS fails closed instead of emitting a package
that falsely claims to contain a Linux broker helper.

## Security and contribution

Read the [repository threat model](docs/threat-model-v4.md) and
[security policy](SECURITY.md) before changing sandboxing, credentials, IPC,
host installation, publication or model qualification. The [contribution
contract](CONTRIBUTING.md) explains required validation, evidence and migration
notes.

## Documentation map

- [Runtime operations](docs/runtime-v4-operations.md)
- [Control plane](docs/control-plane-v4.md)
- [Frontend/backend practice packs](docs/delegation-practice-packs-v4.md)
- [Model guidance](docs/model-guidance-v4.md)
- [Publication](docs/publication-v4.md)
- [Portable runtime inspection](docs/portable-runtime-inspection-v4.md)
- [Optional A2A projection](docs/a2a-adapter-v1.md)
- [Activation readiness](docs/activation-readiness-v4.md)
- [Controlled dogfooding protocol V1](docs/dogfooding-v1.md)
- [Architecture review](docs/research/architecture-review.md)
- [Consolidation roadmap](docs/plans/2026-08-10-runtime-consolidation-roadmap.md)

MIT license.
