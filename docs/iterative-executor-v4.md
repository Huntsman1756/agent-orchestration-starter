# Iterative economy executor V4

The iterative executor turns an approved work contract into a bounded story DAG. It is inspired by Ralph's small-story loop, but it does not delegate authority over completion, history, or Git publication to the coding model.

## Protocol

1. The frontier planner emits a strict, hash-bound story plan. Every story is a subset of the work contract and declares dependencies, exact allowed paths, validation IDs, acceptance criteria, and at most three attempts.
2. The broker selects exactly one highest-priority dependency-ready story and opens a fresh economy-executor session.
3. The executor receives the active story, the last accepted tree hash, and structured receipts for accepted predecessor stories. It does not receive prior model reasoning or free-form progress notes.
4. Broker-owned path inspection, deterministic validation, and an independent fresh review decide whether the candidate is accepted.
5. The host atomically persists the iteration event and promotes the candidate tree. A rejected candidate is never promoted; the next attempt starts from the last accepted tree.
6. A story escalates at its attempt limit. The whole run stops at the plan's bounded iteration limit.

The coding model cannot set `ACCEPTED`, edit the plan, choose the next story, increase budgets, publish Git changes, or merge a pull request. Provider and model identities remain in replaceable runtime profiles rather than these contracts.

## Durable host requirement

`persist_iteration` is one broker-owned transaction. When `promotion` is non-null, compare the current accepted tree with `input_tree_hash`, promote exactly `candidate_tree_hash`, and append the hash-verified event atomically. A retry after a lost response must return the existing canonical result. Implementations must not perform promotion and journaling as two independent effects.

Public interchange schemas:

- `contracts/runtime-story-plan-v4.schema.json`
- `contracts/runtime-story-iteration-v4.schema.json`

This module is a provider-neutral runtime primitive. Production composition still has to supply isolated sessions, atomic persistence, deterministic validators, independent review, and the existing exact-SHA publication service.
