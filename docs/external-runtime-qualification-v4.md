# External runtime qualification V4

An external agent runtime is an implementation candidate, not an inherited security
guarantee. Its name, popularity, use of containers, or support for multiple models
does not make it equivalent to a Runtime V4 `ProcessSandboxBackend`.

This procedure evaluates external runtimes without coupling repository policy to a
vendor. It applies equally to a third-party coding agent, an internal container
launcher, or a future replacement for Docker.

## Qualification identity

Record and pin the exact tuple before executing a repository:

| Component | Required identity |
| --- | --- |
| runtime source | repository URL and commit SHA or immutable release artifact hash |
| execution image | content digest, not a mutable tag |
| launcher | audited source hash and exact effective arguments |
| host | OS, architecture, container-engine identity and relevant kernel features |
| policy | canonical sandbox-profile hash and allowed mount/network authority |
| credentials | adapter/gateway identity and proof that descendants cannot read secrets |

Changing any member invalidates prior evidence. A new model alone may only require
capability requalification; changing its harness, launcher, credential mechanism,
driver, image, or policy also requires runtime requalification.

## Evidence classes

- `NOT_EVALUATED`: documentation or architecture comparison only.
- `DEGRADED`: useful process separation exists, but one or more required effects are
  absent, configurable by untrusted input, or not proven on the target host.
- `HARD_CANDIDATE`: static launch policy contains every required control, but fresh
  hostile evidence for the exact identity is incomplete.
- `HARD_CERTIFIED`: all required effects are blocked by the host boundary in a fresh,
  bounded hostile transcript bound to the exact identity.

Only `HARD_CERTIFIED` satisfies a repository policy that requires `hard`. There is no
documentation-only promotion and no automatic downgrade from `hard` to `degraded`.

## Required hostile effects

The candidate must prove, through attempted effects rather than configuration labels:

1. no host home, active worktree, broker state, credential store, or Docker socket is
   visible unless an exact approved mount requires it;
2. only approved mount targets are writable, while the container root is read-only;
3. descendants receive neither provider/GitHub credentials nor credential-bearing
   arguments or files;
4. privilege escalation is unavailable, capabilities are dropped, and
   `no-new-privileges` is active;
5. PID, memory, CPU, output and wall-time limits take effect, including cleanup of
   surviving descendants;
6. networkless profiles cannot reach loopback, sibling containers, the host or the
   Internet;
7. networked profiles can reach only the authenticated broker gateway, which retains
   the real provider credential;
8. mount path identity, image digest, launcher bytes, engine identity, policy hash and
   certification TTL are bound into the evidence;
9. replacement containers, networks or launchers cannot inherit cleanup or
   certification authority.

Tests that depend on Runtime V4 internals, such as the broker gateway protocol or
launcher-registration cache, are not automatically portable. Mark them
`NOT_COMPARABLE` until an adapter supplies the same boundary. Never count an omitted
test as a pass.

## Adoption rule

An external runtime can be integrated behind the trusted host-driver boundary. The
adapter must translate a broker-owned request into a closed launch profile; it must not
let repository content, a model, or an external runtime select mounts, credentials,
network mode, publication authority, validation commands or routing. The existing
daemon, work contract, deterministic validation, independent review and broker-owned
publication remain authoritative.

Qualification evidence belongs to the central machine installation. A repository
activation references that evidence but cannot create, relax or override it.

