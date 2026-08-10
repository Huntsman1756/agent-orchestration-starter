# Runtime consolidation roadmap — 2026-08-10

This plan records what was consolidated after the Runtime V4 host-component
split and what remains deliberately incremental. It is repository-wide and
does not specialize the runtime for EduAyudas, ESData, Qwen, OpenAI or any
other single project/provider.

## Completed in this consolidation

- npm package integrity now runs the real `npm pack --dry-run` and resolves all
  local links from the published README and documentation.
- Public runtime exports are intentional: stable default API, contracts/host
  subpaths and an explicitly experimental surface.
- A deterministic reference host fixture covers activation, typed admission,
  execution, reinspection, validation, independent-review evidence,
  commit-shaped finalization and publication dry-run without network or
  secrets.
- Fast CI covers Ubuntu and Windows on Node 20/22/24. Manual certification is
  a separate workflow; Docker certification requires an immutable pullable
  image reference and fails if the integration suite cannot run.
- A bounded dispatcher-only state-machine model test exercises seeded
  `PAUSE`, `RUN`, `ADMIT`, `CRASH`, `RECOVER`, `DRAIN` and `ABORT` sequences.
  It checks durable lifecycle, lease, idempotency, publication-order and
  fail-closed authority invariants and reports seed plus commands for replay.
- Security scope is centralized in `SECURITY.md` and the repository threat
  model. Releases have pinned actions, checksums, SBOM and provenance.
- Dependabot, dependency review, CodeQL, CODEOWNERS and contribution guidance
  are present for repository operations.

## Next evidence phase

The framework-building phase is intentionally paused after this consolidation
and the first dispatcher model slice. The next substantial evidence step is
dogfooding the runtime on its own repository with a real, exactly qualified
binding. The first pilot should keep publication manual, use 20--30
representative tasks, and record first and final acceptance, independent-review
rejection, repairs, escalations, duration, cost, false acceptance and
post-acceptance defects. These results are evidence for future policy
decisions, not permission for the model to promote routes or publish
autonomously.

## Intentionally deferred

### Incremental strict TypeScript hardening

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` were evaluated on
the current tree. They expose broad historical work across pilot reducers,
state-machine unions, CLI option parsing and tests. They should be enabled by
subsystem in small changes, starting with runtime contracts/state and then the
pilot surface. `noImplicitReturns` and `noFallthroughCasesInSwitch` can be
enabled earlier after a baseline check.

### Subsequent property/state-machine layers

The first bounded dispatcher model is implemented in
`tests/runtime-autonomous-dispatcher-model.test.ts`. The directed suite and
this dispatcher model remain the release gates. Later property layers for
canonical JSON, IPC frames, hash-bound installation/activation and broader
crash/recovery remain deferred. Each generated counterexample must be reduced
to a deterministic fixture before it enters the normal suite. Do not replace
safety assertions with statistical confidence.

### Production reference host

The checked-in reference driver is intentionally non-authoritative. A real
host implementation must be supplied and certified separately for each
machine family. Certify the task source/CI adapter, issue planner, practice
pack resolver, credential gateway, sandbox coordinator, capability issuer,
GitHub publisher and post-merge verifier independently, then certify their
aggregate composition. The driver must never become a monolith that silently
owns all eight responsibilities.

### Release policy

`0.2.0` formalizes release artifacts but does not publish npm packages or
claim production eligibility automatically. Before a stable `1.0`, define the
support window, schema compatibility policy, host-driver attestation format,
revocation procedure and exact provider/harness qualification registry.
