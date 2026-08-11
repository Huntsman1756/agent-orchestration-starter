# External agentic binding qualification decision

Status: closed for the current runner design

## Decision

The default runner does not use an external networked model binding for
`agentic_tool_execution`. The capability is opt-in and fail-closed: a profile
may declare it only with a qualification record proving three consecutive
clean runs under one immutable harness/provider/model configuration.

Textual tool markup such as `<tool_call>` is invalid output. The runner must
not parse or repair that markup into a synthetic tool invocation, because doing
so would hide a capability failure and make qualification incomparable.

Patch generation is a separate capability. A model that can produce a useful
patch but cannot reliably execute tools may be considered for
`patch_generation` in a future, separately frozen pilot. It is not an
`agentic_tool_execution` qualification.

## Evidence retained from the rejected qualification path

The following external bindings were exercised through the real OpenCode
tool path and did not meet the clean-run gate:

| Binding | Result | Interpretation |
| --- | --- | --- |
| MiMo-V2.5 | NOT QUALIFIED | Tool execution was not reliable on the real repository path. |
| GLM-4.7 | NOT QUALIFIED | It reached the tools in some runs, but the clean consecutive-run gate was not met; textual tool output and shell-contract failures remained. |
| GLM-4.6-Derestricted-v5 | NOT QUALIFIED | A later tool-call failure produced textual markup instead of an executed call. |

These runs are `PRE_PILOT_BINDING_QUALIFICATION` only. They are excluded from
all A/B/C routing-pilot denominators and cannot promote a route. Their token
and wall-time use remains part of total adoption cost reporting.

The qualification attempts did not demonstrate a reduction in strong-model
tokens, total tokens, wall time, or cost per accepted block. A cheap provider
subscription is not treated as zero operational cost: failed tool rounds,
retries, review, and discarded work remain measurable adoption overhead.

The frozen pilot manifest, seed, assignment, and order are not changed by
this decision. No Stage 1 block is admitted until a qualified executor
binding exists.

That Stage 1 pilot was never executed and produced no run records. Its
provider-specific frozen fixture was removed from the active tree during the
post-0.2 repository cleanup so consumers do not mistake it for a supported
example or current qualification evidence. The original manifest, gate and
work contracts remain recoverable from Git commit `3cc4a1f`; any future pilot
must create a new manifest and qualification identity rather than revive it.

## Required qualification record

An executor that declares `agentic_tool_execution` must carry profile-local
qualification metadata:

```yaml
qualification:
  policyVersion: agentic-tool-qualification-v1
  status: VERIFIED
  cleanRuns: 3
  requiredCleanRuns: 3
  evidenceHash: <sha256-of-the-qualification-record>
```

All three runs must use the same profile hash, harness version, provider/model
binding, shell policy, repository baseline, and tool protocol. Each run must
prove read, write, validation, diff, tool round-trip, and clean exit with zero
textual tool-call leakage. Changing any of those inputs starts a new
qualification series at zero.

## Consequence for the starter

The stable policy remains provider- and model-agnostic. Concrete provider and
model identifiers remain profile data. No external provider is enabled by
default, and no provider-specific parser or fallback is added to the core.
