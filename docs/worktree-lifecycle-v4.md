# Worktree lifecycle and bounded garbage collection V4

Runtime V4 owns only worktrees that its privileged host creates through
`createWorktreeManagerV4`, exported from `agent-orchestration-starter/runtime-v4/host`.
Creation is atomic at the Git boundary: the exact local branch
`codex/auto/<run-id>` is checked out directly in the new worktree. The active
checkout is never cleaned, reset, switched or used as an execution directory.

## Durable ownership

Each created worktree has a canonical, self-hashed ownership record under:

```text
<worktree-parent>/.agent-orchestration-worktrees-v4/records/<run-id>.json
```

The record is outside both the consumer repository and the managed worktree. It
binds the physical repository root, worktree parent, exact path, exact local
branch, base SHA, creation identity, terminal evidence and cleanup tombstone.
The JSON contract is
[`runtime-worktree-record-v4.schema.json`](../contracts/runtime-worktree-record-v4.schema.json).
Records are replaced atomically and synchronized before the operation returns.

A missing, unreadable, altered or path-mismatched record is `INDETERMINATE`.
The manager never repairs it by guessing and never deletes its path. A directory
without a valid record is `UNOWNED` and is report-only, even when its name looks
like a runtime run ID.

## Retention and cleanup

The default policy is:

| Terminal state | Retention | Default disposition                                                  |
| -------------- | --------: | -------------------------------------------------------------------- |
| `FINALIZED`    | immediate | caller supplies `MERGED`, `KEEP_BRANCH`, or the explicit disposition |
| `ABORTED`      |  24 hours | caller supplies the evidence-bound disposition                       |
| `FAILED`       |    7 days | caller supplies the evidence-bound disposition                       |

`markTerminal()` durably records the terminal evidence before attempting
cleanup. A finalized clean worktree can therefore be reclaimed immediately.
Failed and aborted runs retain their diagnostic files until expiry. After
expiry, an exact owned dirty worktree may be removed with Git's force option;
the force applies only to the manifest-bound path. `KEEP_BRANCH` never deletes
the local branch. Other dispositions may delete only the exact local
`refs/heads/codex/auto/<run-id>` ref. Remote branches are never deleted.

Cleanup leaves the ownership record as an `OWNED_CLEANED` tombstone. If the
process crashes after Git removes the worktree but before writing the
tombstone, reconciliation can finish the exact manifest-bound branch/tombstone
operation without scanning or deleting unrelated directories.

## Capacity and automatic reconciliation

Before creation, the manager reconciles already-expired owned terminal records
and enforces three independent defaults:

- at most 8 active worktrees;
- at most 32 non-cleaned managed worktrees;
- at most 20 GiB measured across managed worktrees.

Certified hosts may lower or raise those limits deliberately when constructing
the manager. Directory measurement does not follow symbolic links and becomes
indeterminate instead of traversing an unbounded tree.

The trusted host driver must use one manager for the repository lifecycle and
call `markTerminal()` from durable terminal transitions. Configuration or model
instructions alone do not activate cleanup. Models have no cleanup authority.

## Operator reconciliation

Inspection is always safe and non-mutating:

```powershell
agent-orchestration runtime worktree-gc `
  --repository-root G:\_Proyectos\consumer `
  --worktree-parent G:\_Worktrees\consumer `
  --mode REPORT
```

`APPLY` requires the exact hash emitted by a fresh report:

```powershell
agent-orchestration runtime worktree-gc `
  --repository-root G:\_Proyectos\consumer `
  --worktree-parent G:\_Worktrees\consumer `
  --mode APPLY `
  --expected-report-hash <sha256>
```

If any actionable classification changes, `APPLY` rejects the stale report.
It ignores `UNOWNED`, `INDETERMINATE`, active and retained entries. Never use a
broad filesystem cleanup command as a substitute for this ownership protocol.

## Host certification obligations

The worktree manager is privileged host code. Certify its exact source and
platform together with the sandbox coordinator, and keep one mutation owner per
repository/worktree-parent pair. A host must prove terminal-state mapping,
retention values, quotas, restart reconciliation and failure evidence retention.
Windows, Linux and macOS are separate host qualifications.
