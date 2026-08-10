# Security policy

Agent Orchestration Starter is a provider-neutral runtime and control plane for
delegating bounded repository work to untrusted model-driven processes. It can
eventually sit next to repository credentials and publication authority, but
the repository does not ship a universally certified unattended host driver.
Treat every host driver, provider gateway, sandbox backend and repository
activation as a separately qualified trust boundary.

The repository-wide threat model is [docs/threat-model-v4.md](docs/threat-model-v4.md).
It defines the assets, attacker capabilities, trust boundaries, invariants and
severity calibration used for security reports.

## Reporting a vulnerability

Please use GitHub's private security advisory workflow for this repository when
available. Do not open a public issue containing credentials, exploit payloads,
private source, provider responses, or unpublished host-driver details. If the
private workflow is unavailable, contact the repository maintainer privately
through the verified GitHub profile and include `agent-orchestration-security`
in the subject.

Reports should include:

- the affected commit, package version or host-component certification;
- the exact host platform, runtime, harness, policy and activation target;
- a minimal reproduction that contains no real credentials or private source;
- the violated invariant and the impact on repository, credential or
  publication authority; and
- whether the issue requires a malicious repository, model output, provider,
  host driver or operator configuration.

Do not test against repositories, provider accounts or production hosts that
you do not own. The maintainers may request a sanitized reproduction or a
content-addressed evidence hash instead of raw prompts, diffs or logs.

## Security scope

The highest-priority surfaces are the broker state machine, authenticated IPC,
path and worktree authorization, process/container sandboxing, credential
leases, host installation and component loading, model/provider egress, and
GitHub publication. A model is an untrusted code generator; its output is not
authority. Repository content and issue/CI text are also untrusted input.

The project remains pre-1.0. A host-specific qualification does not transfer
to another operating system, native driver, harness, model binding or policy.
