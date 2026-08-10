# Portable runtime inspection V4

This surface adds four provider-neutral controls for operating and replacing model adapters safely.

## Capability contracts

A role declares the behavior it requires: structured output, native tool protocol, filesystem authority, network mode, fresh or persistent context, step ceiling, accepted reasoning controls, and temperature support. An adapter declares what it actually implements. `matchModelCapabilitiesV4` verifies both self-hashes and fails with `CAPABILITY_UNVERIFIED` when any required feature is absent.

Provider and model names do not appear in either document. Replacing a model means publishing a new adapter capability record, matching it against the unchanged role contract, and obtaining fresh runtime qualification evidence.

## Bounded execution graph

`buildRuntimeExecutionGraphV4` projects a verified iterative plan and its receipts into at most 64 story nodes and 2,048 dependency edges. Nodes contain only story IDs, story hashes, status and attempt counts. Objectives, prompts, source and model reasoning are excluded.

## Safe trace export

`exportRuntimeTraceV4` verifies the complete telemetry hash chain and monotonic timestamps before producing at most 1,024 linked spans. It exports event names, hashes, durations, bounded counters and finding counts by severity. It never exports finding text or IDs, prompts, responses, reasoning, diffs, source, environment values or credentials. Export remains observational and cannot change a runtime gate.

## Trajectory evaluation

`evaluateRuntimeTrajectoryV4` deterministically reports `PASS` or `FAIL` for five rules: telemetry integrity, terminal-event placement, balanced execution boundaries, fresh validation before each completed review, and validity of the iterative story graph. The report is self-hashed and advisory; it cannot promote routing, bypass review or authorize publication.

Public JSON Schemas are `contracts/runtime-capabilities-v4.schema.json` and `contracts/runtime-trajectory-evaluation-v4.schema.json`.
