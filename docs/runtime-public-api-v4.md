# Runtime V4 public API

Runtime V4 is published with an intentionally small default entry point. The
default `agent-orchestration-starter/runtime-v4` surface contains the stable
provider-neutral contracts, model guidance, routing/readiness reports,
iterative execution, autonomous dispatch, worker capability, installation and
iterative execution, autonomous dispatch and worker capability APIs.

Boundary-specific APIs are explicit subpaths:

- `agent-orchestration-starter/runtime-v4/contracts` exposes canonical JSON,
  contract schemas, runtime types and contract loaders.
- `agent-orchestration-starter/runtime-v4/host` exposes the privileged host
  composition, component certification, installation and driver-loading
  boundary.
- `agent-orchestration-starter/runtime-v4/experimental` preserves lower-level
  telemetry, publication, broker, review and interoperability building blocks
  while they continue to evolve.

The default entry point is the compatibility promise. Adding a new runtime
module requires an explicit decision, a documentation entry and an update to
`tests/runtime-public-api.test.ts`. Internal modules remain importable inside
the repository but are not package API merely because TypeScript emits them.

The project remains pre-1.0. A change to the default entry point, contract
schemas or host subpath requires a changelog migration note and fresh
qualification evidence for the affected runtime/profile/host binding.
