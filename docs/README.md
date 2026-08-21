# Documentation index and authority

Use this page to decide which documents define current behavior and which only
record design history or experimental evidence. Code, schemas and tests remain
the executable source of truth. When prose conflicts with them, treat that as a
documentation defect rather than silently weakening a runtime gate.

## Current normative architecture and operations

These documents describe the supported Runtime V4 contracts, trust boundaries
and operator procedures:

- [Runtime operations](runtime-v4-operations.md)
- [Control plane](control-plane-v4.md)
- [MCP, strict SDD and context culling](architecture-mcp-sdd.md)
- [Threat model](threat-model-v4.md)
- [Runtime public API](runtime-public-api-v4.md)
- [Compatibility matrix](compatibility-matrix-v4.md)
- [Host installation](host-installation-v4.md)
- [Modular host components](modular-host-components-v4.md)
- [Publication](publication-v4.md)
- [Worktree lifecycle](worktree-lifecycle-v4.md)

## Adoption and configuration guides

These guides explain how to apply the contracts without granting new authority:

- [Consumer adoption and handoff](consumer-adoption-v4.md)
- [Profile selection](profile-selection-v4.md)
- [Operator golden path](operator-golden-path-v4.md)
- [Adaptive execution](adaptive-execution-v4.md)
- [Harness adapters](harness-adapters-v4.md)
- [Model guidance](model-guidance-v4.md)
- [Delegation practice packs](delegation-practice-packs-v4.md)
- [Delegation provenance](delegation-provenance-v4.md)
- [External runtime qualification](external-runtime-qualification-v4.md)
- [Activation readiness](activation-readiness-v4.md)

Example profiles and policies are templates. They do not certify a provider,
model, harness, driver or machine and must be qualified as an exact binding.

## Evidence protocols and operational reports

These documents define or report evidence; they do not automatically change
routing, publication or execution authority:

- [Controlled dogfooding protocol V1](dogfooding-v1.md)
- [Portable runtime inspection](portable-runtime-inspection-v4.md)
- [Broker quarantine remediation](runtime-broker-quarantine-remediation.md)
- [Optional A2A projection](a2a-adapter-v1.md)

## Historical plans and research

Files below `plans/`, `research/` and `decisions/` preserve rationale,
comparisons and deferred work. They are non-normative unless a current document
explicitly incorporates one of their requirements. Dates and external-product
observations describe the point-in-time review, not current certification.

- [Runtime consolidation roadmap](plans/2026-08-10-runtime-consolidation-roadmap.md)
- [Architecture review](research/architecture-review.md)
- [External agentic binding qualification decision](decisions/2026-08-09-external-agentic-binding-qualification.md)

Before relying on any historical statement, verify it against the current
runtime contracts, compatibility matrix and automated tests.
