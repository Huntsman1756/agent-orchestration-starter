# Runtime V4 threat model

## Overview

Agent Orchestration Starter is a TypeScript library, CLI and runtime control
plane for provider- and model-neutral repository automation. A trusted broker
turns an explicitly authorized task into a bounded work contract, prepares an
isolated execution context, delegates code generation to a replaceable model
binding, validates and reviews the result independently, finalizes a local
commit, and may publish it through a broker-owned GitHub adapter.

The default product is a framework, not a universal production service. A
real unattended deployment additionally needs a host driver, certified native
coordination, credential gateway, provider gateway, sandbox and exact
qualification evidence. Examples and test authorities are not production
authorities.

Primary runtime surfaces include:

- task admission, routing and policy binding in `src/runtime/broker-daemon.ts`,
  `routing.ts`, `repository-policy.ts` and `contracts.ts`;
- authenticated local control in `broker-ipc.ts`, `host-composition.ts` and
  the native coordination boundary;
- worktree, path, process and container isolation in `worktree.ts`,
  `path-policy.ts`, `process-sandbox.ts` and `docker-sandbox.ts`;
- model and provider execution in the Codex/OpenCode runners and the provider
  egress gateway;
- host installation and modular trusted authority in `host-installation.ts`,
  `host-driver.ts`, `host-component-loader.ts` and the host component ports;
- validation, independent review, evidence and durable recovery; and
- exact-SHA publication and post-merge verification in `publication.ts`,
  `github-publication.ts` and the autonomous dispatcher.

## Threat Model, Trust Boundaries, and Assumptions

### Assets and privileges

The assets that matter are:

1. Repository source, history, worktrees, branches and generated artifacts.
2. Provider credentials, GitHub credentials, broker gateway tokens and their
   lease metadata.
3. Repository policy, model/profile bindings, capability evidence and host
   component certifications.
4. Durable broker state, journals, locks, event hashes and validation/review
   evidence.
5. Publication authority: exact push, pull request, required-check and merge
   operations.
6. Operator decisions about activation, qualification, routing promotion and
   release artifacts.

### Actors and trust boundaries

| Boundary | Trusted side | Untrusted or separately qualified side |
| --- | --- | --- |
| Repository intake | allowlisted task source and broker | issue text, CI output, schedules and repository content |
| Policy/profile binding | repository policy and broker validation | model/provider identifiers, guidance text and mutable config |
| Model execution | broker capability and sandbox | model response, tool calls, generated code and harness process |
| Provider egress | credential gateway and provider adapter | external provider, network response and provider protocol |
| Host authority | certified root, components and native coordinator | host-driver source until hash/certification verification |
| IPC | authenticated broker server and native ownership proof | local client process, stale socket, malformed frame |
| Publication | broker-owned Git adapter and repository policy | model request, generated branch content, remote responses |
| Release supply chain | pinned CI workflow and release artifact | dependencies, package contents and workflow inputs |

The host driver is privileged code, not configuration. Its root, each
component, each declared port, dependency certificate, native coordinator,
credential gateway and post-merge verifier must be qualified independently.
Operating systems count as separate hosts: evidence for Linux x64 does not
transfer to Windows or macOS.

### Attacker capabilities

The primary attacker stories assume one or more of the following:

- a malicious repository or issue author supplies paths, fixtures, validation
  commands, instructions or task text;
- a model emits hostile code, malformed tool calls, textual pseudo-tool calls,
  credential-seeking commands, network attempts or publication requests;
- a provider or harness returns malformed, truncated, replayed or adversarial
  output;
- a local process races files, sockets, locks, mounts, symlinks or native
  installation artifacts;
- an unqualified or compromised host driver/component is offered for
  installation; or
- a GitHub/provider response is stale, ambiguous or inconsistent with the
  exact commit and policy the broker authorized.

The model is never trusted to grant itself tools, widen a contract, choose
publication settings, approve its own output or persist authority. An operator
is trusted to install and qualify the host, but accidental operator policy
mistakes are treated as a safety concern rather than as model authority.

Out of scope for the library threat model are compromise of the operating
system kernel, a fully compromised GitHub organization, a provider account
already controlled by the attacker, and deliberate operator approval of a
known malicious host binary. Those cases still require operational response;
they are not evidence that a model should receive more authority.

### Security invariants

The following properties must hold across all supported providers and models:

- No model, issue, repository or provider response can create or alter
  repository publication authority.
- Every execution is bound to an immutable contract, policy/profile hash,
  exact base revision, capability snapshot and sandbox evidence.
- Generated paths are normalized, root-confined and re-inspected before an
  accepted candidate; lexical ambiguity is rejected independently of host OS
  where it affects contract reproducibility.
- Provider and GitHub credentials remain behind short-lived broker leases and
  are never passed to models, persisted in telemetry or mounted from the
  repository.
- Validation and review are independent gates. A successful first pass cannot
  bypass fresh validation, review, evidence binding or publication policy.
- Publication is exact-SHA, idempotent, policy-bound and verifiable after the
  remote merge. There is no model-controlled force push, branch deletion or
  deploy path.
- Durable state is append-only and recoverable; ambiguous locks, IPC identity,
  host artifacts, evidence hashes or external process state fail closed.
- Changing a model, provider, harness, guidance, sandbox, host component,
  native driver or policy invalidates the relevant qualification binding.

## Attack Surface, Mitigations, and Attacker Stories

### Task and repository input

Issue text, CI logs and repository files can attempt prompt injection, path
escape, policy override or hidden publication instructions. The broker should
derive a typed task request, allowlist repositories and paths, freeze policy,
and treat free-form text as data. `repository-registry.ts`, `contract-schemas.ts`,
`path-policy.ts` and the dispatcher lease/idempotency rules are the relevant
controls.

A successful attack would require untrusted task text to become an accepted
contract or to change the repository policy hash. Such a bypass is critical;
an isolated rejected task or a benign prompt injection that never crosses the
typed boundary is not a security failure.

### Model and harness execution

Generated code can attempt to read credentials, escape the worktree, modify
unmanaged files, invoke a different tool, emit `<tool_call>` text, access the
network or declare completion without evidence. Runners, capability snapshots,
instruction bundles, process policy, diff policy, sandbox certification and
independent review are intended to contain this class.

The important failure is authority confusion: a model response or textual
protocol fragment must never be interpreted as a broker command. A sandbox
escape or credential read is high/critical depending on the reachable asset;
an invalid response that is rejected before launch is low operational noise.

### Credential and provider boundaries

Credential leases must expose only the internal gateway token, endpoint and
bounded network identity needed for one operation. Provider adapters must not
receive repository credentials, and provider output must remain data until
validated by the harness and broker. `credential-adapter.ts`, the host
credential port and `provider-egress-gateway.ts` encode these assumptions.

Credential disclosure, provider-gateway impersonation or cross-repository lease
reuse is critical. A provider timeout, rate limit or malformed response that is
contained and recorded as a typed failure is medium operational impact.

### Host driver, components and installation

The host driver and component modules execute with the most authority. The
installer therefore checks regular non-symlink files, content hashes, immutable
revisions, dependency order, exact ports, component certificates and aggregate
composition identity. Activation binds the installation and composition to a
repository policy/profile without manufacturing qualification evidence.

A compromised driver, dependency substitution or failure to detect installed
byte drift can grant arbitrary host authority and is critical. A missing
qualification record or unsupported platform must remain a fail-closed
activation error, not degrade silently into an in-process test authority.

### IPC, state and recovery

Malformed frames, replayed command IDs, stale sockets, lock races, process
identity confusion and partial writes attack the broker's state machine. The
authenticated IPC layer, native endpoint ownership proof, bounded frames,
canonical command hashes, append-only journal, idempotency and lock
reclamation controls are the intended mitigations.

An attacker who can make the broker accept a forged command, replay a
publication mutation or release another repository's lock has high/critical
impact. A crash that leaves a run paused or marked failed with no privilege
gain is medium availability impact.

### Publication and post-merge verification

Remote responses and model requests must not select a different base branch,
commit, merge method or required-check policy. Publication must push the exact
finalized SHA, record the PR and checks, merge only the authorized head, and
verify the exact merge commit before terminal state. The GitHub adapter and
post-merge component are the relevant controls.

Merging an unreviewed or different commit is critical. A stale PR lookup that
fails closed is low/medium availability impact; silently treating a skipped
publication as merged is high integrity impact.

### Package and release supply chain

The npm tarball, native helper, host bundle, schemas, workflow actions and
dependencies are part of the trust boundary. `npm pack` integrity tests verify
that public documentation links resolve inside the published artifact. Release
workflows must pin actions, produce checksums/SBOM/provenance and bind a tag to
the exact validated commit.

A release that omits required host/security code, ships a substituted helper
or accepts mutable action/dependency code is high/critical depending on the
authority of the artifact. A missing optional document is low until it causes
operators to activate an unsafe path.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

Use critical when a remotely or repository-controlled input can obtain or use
provider/GitHub credentials, bypass exact publication authorization, execute
arbitrary host authority outside the certified boundary, or make the broker
accept attacker-controlled state as a verified merge. Examples include a
host-driver hash bypass, credential lease exposure to the model, or merge of a
different commit than the reviewed contract.

### High

Use high when an attacker can escape the intended sandbox into another
repository, alter durable evidence or routing/policy binding, bypass an
independent validation/review gate, or cause an unauthorized repository write
without directly obtaining global credentials. A cross-platform path race
that is exploitable on a certified host belongs here when it changes the
accepted tree or publication input.

### Medium

Use medium for contained cross-run confusion, replay, denial of service,
availability loss, stale recovery or evidence loss that does not grant
publication or credential authority. A provider outage, stuck lock or
rejected malformed frame is usually medium when the broker remains fail-closed
and no other repository is affected.

### Low

Use low for documentation/package discoverability mistakes, bounded diagnostic
leaks without secrets, or unsupported-platform behavior that fails closed.
Raise severity when the omission causes operators to bypass a gate or when
the same issue crosses a trust boundary in a deployed host.

Repository: agent-orchestration-starter
Version: dbeba910d8de76aedb1895bd1ed1564644f9dac5
