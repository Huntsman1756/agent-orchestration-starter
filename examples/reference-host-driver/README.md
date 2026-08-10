# Deterministic reference host driver

This directory is a qualification fixture, not a production host driver. It
shows the exact root-driver export accepted by the loader and intentionally
fails closed for daemon/MCP startup. It contains no credentials and has no
publication authority.

The executable end-to-end reference is
`tests/runtime-reference-host-e2e.test.ts` and can be run with:

```text
npm run example:reference-e2e
```

That test performs a real temporary installation and repository activation,
loads the hash-bound driver and eight component fixture ports, admits a typed
task, runs a deterministic worker/validation/review sequence through the
durable broker, finalizes a commit-shaped evidence record, and records a
`PUBLICATION_SKIPPED` dry-run. The fake provider is only there to make the
control-plane lifecycle reproducible without secrets or network access.

The test does not certify a production host. A real deployment must provide
the eight modular components, a native cross-process coordinator, isolated
credential/provider gateways, a certified sandbox and exact model/harness/
policy qualification for the target operating system.
