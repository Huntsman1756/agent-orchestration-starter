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

## Production boundary

This closes the wire-protocol gap; it does not weaken host certification. A production daemon still needs native ownership verification, a certified cross-process coordinator, exact control handlers, credential isolation, provider gateway support, capability qualification, and target-host Docker certification. If a mutating control handler is absent, IPC returns `CAPABILITY_UNVERIFIED`.
