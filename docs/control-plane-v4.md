# Authenticated control plane V4

The local IPC boundary carries the same five bounded controls exposed by MCP:

- enqueue a complete coding task;
- read one run status;
- request a repair using persisted finding IDs and evidence hashes;
- finalize an already accepted run;
- abort without deleting evidence.

Every request uses the existing owner-verified endpoint, owner-only token, canonical JSON and bounded length-prefixed frame. Unknown fields, malformed identities, empty or duplicate findings, oversized payloads, non-canonical bytes, unverified peers, and replies that disagree with daemon status fail closed.

Mutating control IDs are derived deterministically from their canonical input. A transport retry therefore reaches the broker with the same identity instead of creating a second repair, finalization, or abort operation. The broker-owned control-plane implementation remains responsible for durable command idempotency and lifecycle policy.

`createIpcMcpControlClientV4` is the only adapter required between the five-tool MCP server and `BrokerIpcClientV4`. It does not expose a generic shell, filesystem method, model credential, GitHub credential, policy override, budget override, or arbitrary broker command.

## Native composition and production boundary

`createRuntimeHostCompositionV4` now composes the durable daemon, authenticated IPC server, one-flight scheduling and exact repair/finalize/abort operations. Accepted candidates, bounded failures and explicit aborts become durable state; terminal paths release repository locks. Startup rejects test-only authorities.

This closes the native composition seam but does not weaken host certification. Production uses a thin root plus eight exact component ports; each module, interface, qualification evidence and dependency certificate is pinned independently, and the complete composition has separate integration evidence. Native ownership verification, a certified cross-process coordinator, concrete model/validation/review operations, credential isolation, provider gateway support, capability qualification and target-host Docker certification remain mandatory. Host code is installed once per machine and is not repository code. An absent, incomplete, modified or dependency-drifting component returns `CAPABILITY_UNVERIFIED`. See [`modular-host-components-v4.md`](modular-host-components-v4.md) and [`host-installation-v4.md`](host-installation-v4.md).
