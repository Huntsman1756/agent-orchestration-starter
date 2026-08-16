# MCP, strict SDD and context culling V4

This guide describes the current Runtime V4 control path for a frontier
planner/reviewer, an economical implementation worker and the broker that
owns repository authority. It is an operational contract, not a provider
binding: provider and model identifiers belong in `profiles/*.yaml` and must
not be copied into stable policy or source code.

## Architecture at a glance

The system has three independent decision boundaries:

| Boundary                  | Authority                                                       | What it may do                                                                                                                        |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Frontier planner/reviewer | ChatGPT Desktop or another qualified read-only frontier binding | Create the Work Contract, author acceptance tests, inspect hash-bound evidence and submit a verdict                                   |
| Broker                    | Trusted runtime and host composition                            | Admit work, create isolation, build context, enforce paths, run gates, persist state, request repair and own finalization/publication |
| Economy executor          | Qualified contract-write binding                                | Read the bounded snapshot and modify only `implementation_targets`                                                                    |

The reviewer is independent from the executor. A model response cannot widen a
contract, select a new route, approve its own diff or publish a commit. The
broker remains the source of truth for state and deterministic evidence.

## Connecting ChatGPT Desktop

### Prerequisites

Use Node.js 20 or newer, build the runtime, and use a trusted host installation
for isolated execution. The host installation and repository activation are
documented in [`host-installation-v4.md`](host-installation-v4.md). A minimal
build/check sequence is:

```powershell
npm ci
npm run validate
npm run build
```

For a complete V4 activation, the trusted host creates an immutable
installation and then activates the target repository. The activation command
derives the frontier model and reasoning effort from the selected profile and
generates the project MCP binding; do not provide a second model flag that
could drift from the profile:

```powershell
node <runtime-entrypoint> runtime activate `
  --repository-root <repository-root> `
  --policy <repository-root>/policies/repository-policy.yaml `
  --profile <repository-root>/profiles/runtime.chatgpt-subscription.example.yaml `
  --worktree-parent <external-worktree-parent> `
  --installation-manifest <installation-v4.json> `
  --host-root <trusted-host-root> `
  --target ANALYSIS_ONLY
node <runtime-entrypoint> runtime doctor --activation <repository-root>/.agent-orchestration/activation-v4.json
```

Activation writes `.agent-orchestration/activation-v4.json` and a managed
`.codex/config.toml`. It refuses to overwrite an unmanaged or locally modified
configuration. Merge a pre-existing configuration deliberately and rerun the
activation instead of forcing the file.

### Generated STDIO binding

The Desktop integration uses the authenticated local STDIO adapter. Its
generated configuration is equivalent to the following, with paths supplied
by the activation manifest:

```toml
cli_auth_credentials_store = "keyring"
forced_login_method = "chatgpt"
approval_policy = "never"
sandbox_mode = "read-only"

[mcp_servers.agent_orchestration_v4]
command = "node"
args = ["<central-runtime-entrypoint>", "runtime", "mcp-stdio", "--activation", "<activation-v4.json>"]
required = true
enabled_tools = ["run_coding_task", "repair_coding_task", "finalize_coding_task", "abort_coding_task", "get_coding_task_status", "broker.get_review_packet", "broker.submit_verdict"]
startup_timeout_sec = 10
tool_timeout_sec = 30
default_tools_approval_mode = "auto"
```

The generated binding contains no API key, bearer token or `auth.json`. The
ChatGPT subscription is used only by the read-only Codex orchestrator and
reviewer bindings. The Economy executor is a separate profile binding and may
use a provider API key kept behind the trusted credential gateway.

After activation, restart or reload the Desktop project so it sees the
required `agent_orchestration_v4` server. The server instructions enforce the
following control rule: use `run_coding_task` for source mutation, poll the
returned run instead of submitting duplicates, request a review packet only
after deterministic validation and independent review, and submit a verdict
with the exact returned `packet_hash`.

### Streamable HTTP adapter

Trusted hosts can expose the same MCP server through
`createMcpHttpAdapter`/`runMcpHttpAdapter` in `src/mcp/http-adapter.ts`. This is
an embedding API, not a public unauthenticated web server:

- the default bind host is `127.0.0.1` and the default path is `/mcp`;
- every request requires `Authorization: Bearer <token>`;
- the token must be between 16 and 4,096 bytes and is compared in constant
  time;
- request bodies are bounded to 4 MiB by default and the adapter tracks MCP
  sessions with `Mcp-Session-Id`;
- a trusted host must keep the token outside the repository and supply the
  transport, network and TLS policy appropriate to its deployment.

The Desktop-generated configuration intentionally uses STDIO because it keeps
the broker on the local process boundary. Use HTTP only when a separately
qualified host needs a network transport; do not expose `/mcp` directly to an
untrusted network.

### MCP tool contract

The V4 server exposes exactly seven tools:

| Tool                       | Purpose                                    | Important guard                                                             |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| `run_coding_task`          | Enqueue one complete bounded task          | The request is schema-validated and idempotent through its request identity |
| `repair_coding_task`       | Request a bounded repair                   | Findings must be persisted identities with evidence hashes                  |
| `finalize_coding_task`     | Ask the broker to finalize an accepted run | Finalization remains broker-owned and rechecks deterministic state          |
| `abort_coding_task`        | Abort without deleting evidence            | The durable failure is retained for audit                                   |
| `get_coding_task_status`   | Read a bounded status reply                | The reply is normalized at the MCP boundary                                 |
| `broker.get_review_packet` | Read the complete review envelope          | Available only at `REVIEW_ACCEPTED`, with no unresolved findings            |
| `broker.submit_verdict`    | Persist `APPROVED` or `REJECTED`           | The supplied `packet_hash` must exactly match the packet                    |

`APPROVED` records a hash-bound verdict; it is not an implicit finalize,
merge or deployment command. The broker can finalize only through the explicit
broker-owned lifecycle after deterministic evidence remains valid. `REJECTED`
enters the existing repair path and does not create a parallel mutation flow.

## Strict Spec-Driven Development

Runtime Work Contracts separate the Planner's tests from the Economy worker's
write authority:

```yaml
acceptance_tests:
  - tests/example.test.ts
implementation_targets:
  - path: src/example.ts
    operations: [MODIFY]
```

The schema requires every acceptance test to be a normalized `.spec.ts`,
`.spec.tsx`, `.test.ts` or `.test.tsx` path. Implementation targets must be
non-test TypeScript files. `implementation_targets` must exactly mirror the
contract's `allowed_changes`; overlap between the two matrices is invalid.

The effective Economy permission is therefore:

```text
read: the bounded repository capability snapshot
write: implementation_targets only
write: acceptance_tests never
```

The Planner prompt freezes the acceptance tests before requesting an
implementation. The Executor prompt repeats the immutable test list, the
write-only target list and the shift-left gates. These prompts are helpful
instructions; the diff interceptor is the authority.

### Diff interceptor and repair

`interceptEconomyDiffV4` delegates to the Git-based diff policy with
`acceptance_tests` marked immutable and `implementation_targets` as the only
allowed changes. It observes tracked changes and untracked files after the
worker returns, so changing a test through another tool or by creating an
untracked replacement does not bypass the policy. Unsupported modes,
symlinks, submodules, ambiguous paths, excessive files or excessive lines are
also rejected.

Any mutation of an acceptance test, including whitespace-only changes, raises
`ECONOMY_POLICY_VIOLATION`. The error carries an evidence hash and the bounded
repair instruction:

> Intentaste modificar los tests de aceptación. Esto está prohibido por el contrato. Solo modifica los archivos de implementación.

The broker records the failure and emits a Repair Packet. The repair may only
address the persisted finding; it cannot expand `implementation_targets` or
rewrite the tests.

## Context culling and capability snapshots

`build_capability_snapshot` in `src/routing/capability-snapshot.ts` constructs
the Economy context from the contract roots:

1. Start with `implementation_targets` and `acceptance_tests`.
2. Parse TypeScript/TSX source with the TypeScript compiler API.
3. Follow only resolvable local static imports, exports, import types and
   referenced files inside the repository.
4. Record dynamic `import()` and dynamic `require()` locations as ignored
   imports; never execute or evaluate them.
5. Render the selected files as bounded `<capability_snapshot>` and `<file>`
   blocks for the runner.

The default limit is 128 KiB and the policy maximum is 4 MiB. The dependency
graph is limited to 256 files. If the complete graph is too large, the broker
keeps the root files at full content and replaces local dependency bodies with
their exported function, type, interface and enum signatures. This mode is
`SIGNATURE_FALLBACK`. If even the roots plus signatures exceed the limit, the
broker fails closed instead of silently truncating context.

The snapshot is stable and content-addressed. Its SHA-256 `snapshot_hash`
covers the canonical selected body, and each rendered file has its own
`content_hash`. The hash is carried into runner evidence, the review envelope,
the review packet and the audit trail. A reviewer can therefore distinguish a
diff produced from one context from a diff produced from another.

The Codex and OpenCode runners build the snapshot before invoking the model.
An unrelated repository file is not included merely because it exists; it is
included only if it is a contract root or a statically resolved local
dependency.

## Shift-left deterministic validation

The validation order is deliberately conservative:

```text
worker diff
    -> diff/path policy
    -> deterministic test, lint, format and security evidence
    -> fresh independent review
    -> hash-bound verdict
    -> broker finalization/publication policy
```

`runReviewAfterDeterministicValidationV4` refuses to invoke Frontier review
when the validation manifest is empty or contains a failure. Failures whose
validation identity contains `lint` or `format` produce a hash-bound Repair
Packet for Economy. The internal security lint configuration includes static
rules such as the `eval` red-team check; it does not execute candidate source
to decide whether it is safe.

The repository-level `npm run validate` command runs the complete deterministic
suite: tests, typecheck, ESLint with zero warnings, Prettier checks and the
build. Network access and model judgment are not required to accept or reject
these gates. A model cannot waive a failing gate, and a review packet is not
available until the broker has accepted the deterministic manifest.

## Immutable audit trail

The broker projects durable lifecycle evidence into
`logs/audit-trail.v4.ndjson` below its state directory. Each canonical NDJSON
record contains:

- `story_id`, `run_id`, event identity and timestamps;
- the Work Contract hash and capability snapshot hash;
- the final prompt and raw completion, bounded for storage;
- the observed diff and every validation result;
- the lifecycle status;
- a sequence number, `prev_hash` and `record_hash`.

The audit writer is append-only, fsyncs each record, rejects non-canonical
records and makes repeated event IDs idempotent. Verification checks the
sequence, previous-hash link and record hash. The broker also reconstructs its
audit projection from the durable journal during recovery and treats unknown
runs or broken projections as state corruption.

Audit evidence is sensitive. Before serialization the runtime redacts common
private keys, connection strings, Bearer tokens, query-string secrets, API-key
shapes, cloud tokens and JWT-like values. Redaction is a safety layer, not a
license to publish prompts, completions or diffs; keep the state directory
under the trusted host boundary.

Verify the default local state directory with:

```powershell
npm run audit:verify
```

For an activated host state directory, pass it explicitly:

```powershell
npm run audit:verify -- --state-directory <state-directory>
node dist/cli/main.js runtime audit-verify --state-directory <state-directory>
```

The command exits zero and reports `OK` when the ledger is empty or the entire
chain is valid. It exits non-zero with `INTEGRITY_BREACH` when a record is
malformed, reordered, partially written or hash-inconsistent. Do not repair a
broken ledger in place: preserve it as evidence and investigate the host and
filesystem boundary.

## Profiles and provider neutrality

`profiles/runtime.example.yaml` is the provider-neutral V4 shape.
`profiles/runtime.chatgpt-subscription.example.yaml` documents a dated mixed
topology in which ChatGPT subscription authentication is restricted to the
read-only Codex orchestrator/reviewer and the Economy binding remains separate.
`profiles/nan-opencode.example.yaml` is another dated example. These files are
configuration examples, not credentials or live qualification claims.

MCP is generated from the selected V4 profile and activation; there is no
unvalidated `mcp` profile field to add. Keep concrete provider names, model
names, source URLs and authentication choices in profiles only. Never put
tokens, `auth.json`, API keys or bearer values in a profile committed to Git.

## Operator checklist

Before enabling a host or changing a profile:

1. Pin the runtime, host driver, components, policy and profile revisions.
2. Run `npm run validate` and qualify the exact host, sandbox and credential
   boundary.
3. Confirm `runtime doctor --activation ...` succeeds for the same service
   account that will access the keyring.
4. Confirm the generated `.codex/config.toml` is managed, required and
   read-only; do not copy credentials into it.
5. Verify that acceptance tests and implementation targets are disjoint.
6. Verify the audit ledger with `npm run audit:verify -- --state-directory ...`.
7. Treat deterministic failure, `ECONOMY_POLICY_VIOLATION`,
   `CAPABILITY_UNVERIFIED` and `INTEGRITY_BREACH` as fail-closed conditions.

For the wider host, sandbox, credential and publication boundaries, continue
with [`runtime-v4-operations.md`](runtime-v4-operations.md),
[`host-installation-v4.md`](host-installation-v4.md) and the
[repository threat model](threat-model-v4.md).
