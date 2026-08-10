# Optional A2A v1 projection

The core runtime remains local, broker-owned and provider-neutral. `projectRuntimeResultToA2AV1` is an optional boundary projection pinned to A2A protocol version `1.0`; it does not make this package an A2A server. It follows the v1 data model and therefore does not emit the legacy `kind` discriminator.

The projection maps one validated runtime result to an A2A `Task` snapshot:

- a new run becomes `TASK_STATE_SUBMITTED`;
- active execution, review and publication become `TASK_STATE_WORKING`;
- `FINALIZED`, `FAILED` and `ABORTED` become completed, failed and canceled terminal states;
- metadata contains only the runtime state and content hashes needed to bind status to broker evidence.

It deliberately omits messages, artifacts and history so that prompts, source, diffs, findings and model reasoning do not cross the boundary. Unknown runtime states and implicit timestamps fail closed.

## What a complete A2A server still requires

A conforming deployment must separately provide an HTTPS transport, an Agent Card, authentication/authorization, and the mandatory send, get and cancel methods. Streaming and push notifications are optional capabilities and must only be advertised when implemented. Credentials belong in transport authentication, not task metadata or the Agent Card.

That outer server should call the authenticated V4 control plane; it must not talk to executors, worktrees or provider credentials directly. A2A remains an interoperability adapter, never the internal orchestration state machine or authority model.

The public projection schema is `contracts/a2a-runtime-task-projection-v1.schema.json`.
