# Autonomous dispatcher V4

## Purpose

The autonomous dispatcher is the provider- and model-neutral supervisor around Runtime V4. It repeatedly admits explicitly authorized work, delegates execution to the existing daemon, observes durable results, verifies the exact merged commit, and then closes or reopens the source task. It does not grant repository authority, choose concrete models, hold provider credentials, or let a coding model approve its own output.

```text
privileged source adapter -> autonomous dispatcher -> Runtime V4 daemon
          ^                         |                       |
          |                         v                       v
 close/reopen/fail <- exact-main post-merge verifier <- publication broker
```

The public API is exported from `agent-orchestration-starter/runtime-v4`:

- `createAutonomousDispatcherV4` creates the durable supervisor.
- `runCycle` performs one bounded, non-overlapping reconciliation pass.
- `runAutonomousDispatcherLoopV4` repeats serial passes until an `AbortSignal` is set.
- `setMode('RUNNING' | 'DRAINING' | 'PAUSED')` changes durable admission behavior.
- `resetCircuit()` explicitly rearms admission after an operator or trusted control-plane decision.
- `status()` returns bounded metadata and hashes, never task prompts, code, credentials, or lease IDs.

## Durable behavior

The dispatcher stores one canonical, hash-bound, atomically replaced and fsynced state file in an absolute broker-owned directory. It stores source identity, immutable revision, request hash, daemon request/run IDs, lease metadata, terminal status, and evidence hashes. The task objective and full request are reloaded from the privileged source adapter after a crash and must match the durable identity and request hash exactly.

Source claims and daemon `request_id` idempotency form separate duplicate-execution barriers. A crash after claiming but before submission reloads the exact candidate; a crash after submission renews the lease and resumes the existing run. Cursor advancement happens only after the complete listed page has been handled.

`RUNNING` processes active work and admits new work. `DRAINING` continues lease renewal, recovery, finalization, and post-merge verification but admits nothing new. `PAUSED` performs no source or runtime calls. An open circuit prevents new admission but deliberately does not abandon active leases.

## Required host adapters

This module intentionally does not ship a universal GitHub task adapter. The trusted host installation must implement:

1. `AutonomousTaskSourceV4`: list only allowlisted sources/repositories, expose immutable revisions, claim with a server-side lease, and perform idempotent close/reopen/fail mutations.
2. A task planner before admission: convert issue/CI/scheduled metadata into a complete `RuntimeTaskRequestV4` bounded by repository policy. Free-form issue text is not authority.
3. `AutonomousRuntimePortV4`: call the authenticated Runtime V4 daemon; never provide a direct-write fallback.
4. `AutonomousPostMergeVerifierV4`: check the exact merge SHA on the protected branch using repository-owned deterministic commands and return content-addressed evidence.
5. One certified service owner or a native cross-process coordinator for each state directory. The in-process busy guard prevents overlapping calls in one process; it is not a distributed lock.

GitHub tokens, provider credentials, and production secrets stay in those privileged adapters and are never passed to models or persisted by the dispatcher. Windows, Linux, and macOS hosts require separate certification of the exact driver, coordinator, sandbox, filesystem semantics, and policy binding.

## Authorization and recovery rules

- Candidate source, repository, and all required labels must match the frozen dispatcher policy.
- `candidate_id + revision` is the immutable source identity; changed content requires a new revision.
- Completion requires `FINALIZED`, a verified 40-character merge commit SHA, and a post-merge `PASS` evidence hash.
- A post-merge regression reopens the source task and counts toward the circuit breaker.
- Runtime `FAILED` or `ABORTED` states are reported once with typed evidence and remain terminal.
- Resetting the circuit clears the global consecutive-failure counter; it does not erase task records.

## Generic shakedown

Run the deterministic cross-platform fixture before connecting a real repository:

```bash
npm ci
npm run test:autonomous
npm run validate
```

The fixture proves authorization, source leasing, idempotent crash recovery before and after daemon submission, cursor durability, exact-merge completion, regression reopen, terminal failure reporting, pause/drain operation, circuit reset, and cancelable serial looping. It uses no network, provider, model, Docker, GitHub token, or project-specific behavior.

For a real pilot, pin the installation commit and host-driver hash, disable deployment and production data mutation, start in `PAUSED`, verify status, switch to `RUNNING` for one low-risk synthetic issue, then use `DRAINING` before maintenance. Do not call the deployment production-ready until the exact source adapter, host, OS, model/harness/driver/policy binding, credential isolation, and post-merge verifier have current qualification evidence.
