# Runtime V4 operator golden path

This guide is the shortest safe path for adopting the orchestrator in an
unrelated frontend, backend or full-stack repository. It separates what the
package verifies from what a deployment must still provide.

## The invariant

The frontier planner creates small contracts and acceptance criteria. A
qualified economical worker edits only implementation targets. Deterministic
validation runs outside the model. A fresh read-only frontier context reviews
the evidence. Only the broker may commit or publish.

The runtime profile must preserve this topology:

| Role                 | Tier     | Authority                                   |
| -------------------- | -------- | ------------------------------------------- |
| `orchestrator`       | frontier | read-only planning                          |
| `executor`           | economy  | localized contract-write                    |
| `reasoningExecutor`  | economy  | optional semantic/cross-file contract-write |
| `escalationExecutor` | economy  | bounded repair/escalation contract-write    |
| `frontierExecutor`   | frontier | protected direct execution fallback         |
| `reviewer`           | frontier | fresh read-only review                      |

Models and providers may change. The role, authority and evidence rules do not.
A `tier` value is a deployment claim that requires qualification; changing a
model, provider, harness, parser, guidance, driver or policy invalidates prior
qualification.

## Adoption sequence

1. Pin a released package or exact commit. Do not consume a moving `main` in an
   unattended host.
2. Copy and narrow `policies/repository-policy.example.yaml`. Keep publication
   disabled for the first runs and classify source as `PRIVATE` unless it is
   genuinely public.
3. Select a dated profile and edit only that repository's project
   configuration. Never modify personal/global OpenCode or Codex settings.
4. Run `npm run validate`, then the delegation preflight:

   ```powershell
   node dist/cli/main.js runtime doctor `
     --repository-policy <repository-policy.yaml> `
     --profile <runtime-profile.yaml>
   ```

5. Resolve every `BLOCKED` finding. Review every `DEGRADED` finding rather than
   increasing budgets blindly.
6. Install and certify the privileged host driver and each of its independently
   versioned components. Activation is registration, not certification.
7. Qualify the exact binding for the smallest task-trait envelope. Start with
   mechanical/localized work in report-only or manual-publication mode.
8. Inspect contract lane, route reasons, attempts, repairs, frontier usage,
   validation and review evidence. Expand traits only from reproducible runs.

## Frontend and backend work

The core remains framework-neutral. The planner should split work along public
contracts and repository architecture, not send a whole feature as one prompt.

- Frontend stories should bind nearby accepted patterns, public types, design
  tokens and relevant tests; validate typecheck, unit/build and approved
  browser/accessibility checks where applicable.
- Backend stories should bind schemas, authorization and persistence
  interfaces; validate unit/integration and public contract behavior.
- Full-stack work should normally proceed as shared contract, backend,
  frontend, then end-to-end validation, with a fresh worker context per story.
- Database, authentication, authorization, deployment, infrastructure and
  security work remain frontier unless an exact narrower capability is
  explicitly authorized and freshly qualified.

Practice packs are resolved by the separately certified host component. They
are not magic skills inferred by a coding model. Missing or ambiguous stack
evidence must split/elevate the task rather than letting the worker guess.

## Diagnosing low economy-provider usage

Low API usage is not enough to identify a fault. Check, in this order:

1. `runtime doctor`: `PRIVATE` source often makes a public-only economy binding
   ineligible; a missing reasoning worker elevates cross-file tasks.
2. The persisted work contract: inspect `execution_policy.lane`,
   `executorRole`, task traits and route reasons.
3. Host composition: confirm it invokes the selected runner instead of merely
   generating repository instructions.
4. Binding health: a quarantined model/trait pair contracts routing to another
   qualified worker or frontier.
5. Task decomposition: oversized, architectural, security-sensitive,
   migration or long-horizon work correctly avoids the mechanical worker.
6. Provider evidence: verify the binding hash, usage events and credential
   gateway attribution instead of relying on a dashboard total alone.

If `frontierExecutor` reuses the same provider/model as an economy role, the
preflight reports `FRONTIER_EXECUTOR_REUSES_ECONOMY_MODEL`. Frontier planning
may still improve the retry, but no stronger model executed the code. Configure
and qualify a genuinely stronger writable binding if that distinction matters.
For NaN, use `nan-opencode.example.yaml` when only the standard models are
available and accept its explicit `DEGRADED` result, or start from
`nan-opencode-glm-premium.example.yaml` when the account has GLM 5.2 premium.
The latter is `READY` only as configuration topology; it still needs exact
binding qualification. A writable frontier binding from another provider is
equally valid and does not require core changes.

## What remains deployment work

This package is not a universal one-command production daemon. A production
deployment still needs a pinned and audited host driver, native coordinator,
credential/provider gateway, sandbox certification, practice-pack resolver,
task source and publication verifier. Windows, Linux and macOS require separate
host evidence. Missing evidence must fail closed; repository documentation or
a successful model response cannot replace it.
