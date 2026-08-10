# OpenHands sandbox evaluation — 2026-08-10

## Decision

OpenHands provides a capable multi-agent control surface and useful Docker process
separation. Its evaluated default `DockerWorkspace` launch profile is `DEGRADED` under
the Runtime V4 definition, not `hard`. It may be integrated only through a hardened,
trusted host driver followed by fresh certification; its default launcher must not be
treated as a substitute for `createDockerProcessSandboxV4`.

This is a bounded interoperability evaluation, not a security audit of OpenHands.

## Pinned subject and host

| Item | Exact value |
| --- | --- |
| Agent Canvas source | `OpenHands/OpenHands` commit `cf2c5685735b8f8c55114d1db6166122978d6b4a` |
| Agent Canvas version | `1.12.0` |
| configured Agent Server | `1.40.1` |
| software-agent-sdk source | tag `v1.40.1`, commit `c1877b44129696cb99535c0e074d22a324cc7312` |
| Agent Server image | `ghcr.io/openhands/agent-server@sha256:f8cbd196606c4c842a8ac993469f9c4e3b6c8d83f5d448c59b318a2c11257479` |
| client host | Windows/amd64 |
| container engine | Docker Desktop `4.85.0`, Engine `29.6.2`, Linux/amd64 |
| Runtime V4 control image | `sha256:2bb33252f36700730c6622899dd7757fd205214e6eee14dd1ae57d9eb1f65728` |

The evaluated source is the version selected by Agent Canvas
`config/defaults.json`, not the unrelated TypeScript client package version.

## Two different OpenHands surfaces

The current `OpenHands/OpenHands` repository is Agent Canvas. Its documented Docker
quickstart runs the Agent Server and agent inside one outer container and bind-mounts
the selected projects directory at `/projects`. The user chooses the breadth of that
host mount.

The separately published `DockerWorkspace` in `software-agent-sdk` launches one Agent
Server container with optional caller-provided volumes. This evaluation exercised that
launcher because it is the closest comparable unit to Runtime V4's process sandbox.
The source-generated command uses `docker run --rm`, a non-root image user and a
`nofile` ulimit, but does not add the Runtime V4 hardening arguments.

Treating Agent Canvas, LocalWorkspace and DockerWorkspace as one security boundary
would produce an invalid comparison. LocalWorkspace intentionally executes with host
filesystem authority.

## Method

1. Clone both official repositories at the pinned revisions and inspect the launch
   implementation and image selection.
2. Pull the exact Agent Server image by immutable digest.
3. Launch it with the effective `DockerWorkspace` arguments, no credentials and no
   project mount.
4. Inspect the resulting Docker object and execute the portable subset of
   `tests/fixtures/sandbox/hostile-child.mjs` inside it.
5. Run direct probes for UID, passwordless privilege escalation, rootfs writes,
   outbound network and descendant limits.
6. Stop and auto-remove the synthetic container. No user repository or provider
   credential was mounted.

Broker-specific checks for authenticated egress, launcher identity, cleanup ownership,
certification cache and TTL were `NOT_COMPARABLE`; they were not recorded as passes.

## Observed evidence

| Effect | Observation | Runtime V4 result |
| --- | --- | --- |
| image identity | exact digest and source build SHA were observable | PASS |
| default user | UID/GID `10001:10001` (`openhands`) | PASS |
| host home and sentinel | not readable without an explicit mount | PASS for tested launch |
| Docker socket | absent and not connectable | PASS |
| inherited provider credentials | none present in process, descendants, argv or scanned files | PASS for tested launch |
| root filesystem | `ReadonlyRootfs=false`; the user wrote its home layer | FAIL |
| privilege escalation | image user belongs to `sudo`; `sudo -n id` returned UID 0 | FAIL |
| no-new-privileges | `/proc/self/status` reported `NoNewPrivs: 0` | FAIL |
| capabilities | effective capabilities were zero before escalation; launcher did not request `cap-drop=ALL` | FAIL closed-policy requirement |
| process limit | `PidsLimit=null`; 100 of 100 hostile descendants started | FAIL |
| memory/CPU limit | both unset in the resulting HostConfig | FAIL |
| network | default bridge; direct TCP connection to `example.com:443` succeeded | FAIL for networkless profiles |
| published API | port mapped to `0.0.0.0` and `::`, not loopback-only | FAIL |
| unauthenticated launch | without forwarded session variables, the server warned it was reachable on all interfaces without authentication | FAIL closed-policy requirement |
| seccomp | Docker default seccomp was active (`Seccomp: 2`) | PASS, but insufficient alone |
| broker gateway and secret lease | no equivalent boundary in the tested launch | NOT_COMPARABLE |
| identity-bound hostile TTL | no equivalent certification mechanism in the tested launch | NOT_COMPARABLE |

The temporary container was named `ao-eval-openhands-1-40-1` and was stopped after
collection. Its `--rm` policy removed it. The downloaded public image remains in the
local Docker cache.

## What is worth adopting

- Preserve OpenHands/ACP as a possible replaceable agent or UI integration, not as a
  policy dependency.
- Keep the explicit distinction between host-local execution and container execution.
- Reuse the exact-image and source-build metadata that the Agent Server publishes.
- Permit a future OpenHands adapter only behind the same closed host-driver interface
  used by other harnesses.

## Required changes before a `hard` adapter

A candidate adapter must, at minimum, bind the published API to loopback or an
authenticated broker-only network; require authentication; pin the image digest; deny
arbitrary volume strings; mount only a broker-built capsule; use a read-only rootfs,
non-escalating user, dropped capabilities and `no-new-privileges`; enforce PID/CPU/
memory/time/output limits; keep credentials in the provider gateway; and pass the full
portable hostile suite plus adapter-specific gateway and lifecycle tests.

Adding those flags to a local command is not enough. The adapter and exact host tuple
must receive fresh identity-bound certification under
[`external-runtime-qualification-v4.md`](../external-runtime-qualification-v4.md).

## Sources

- Agent Canvas source: <https://github.com/OpenHands/OpenHands/tree/cf2c5685735b8f8c55114d1db6166122978d6b4a>
- DockerWorkspace source: <https://github.com/OpenHands/software-agent-sdk/blob/c1877b44129696cb99535c0e074d22a324cc7312/openhands-workspace/openhands/workspace/docker/workspace.py>
- Agent Canvas Docker quickstart: <https://github.com/OpenHands/OpenHands/blob/cf2c5685735b8f8c55114d1db6166122978d6b4a/README.md>
- Agent Server image build source: <https://github.com/OpenHands/software-agent-sdk/tree/c1877b44129696cb99535c0e074d22a324cc7312/openhands-agent-server>

