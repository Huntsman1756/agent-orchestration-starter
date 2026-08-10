# Iterative economy executor V4

The iterative executor turns an approved work contract into a bounded story DAG. It is inspired by Ralph's small-story loop, but it does not delegate authority over task size, completion, history, repair, escalation, or Git publication to the coding model.

## Exact worker capability

Before planning, the trusted broker creates a `WorkerCapabilityV4` for the activated worker. It binds all execution-relevant identity, not a marketing model name:

- provider, model and immutable model revision, plus an artifact hash when the provider exposes one;
- endpoint, harness and tool-parser revisions;
- tool protocol and the exact tool bundle hash;
- the instruction bundle hash, covering the system/developer prompt, repository instructions and any loaded skill snapshots;
- qualification evidence for that exact combination;
- qualified capability IDs and hard per-story limits.

The story plan includes `worker_capability_hash`. A different provider, model revision, endpoint, harness, parser, tool set, prompt/skill pack, qualification record or limit produces a different hash. The broker rejects a stale plan instead of silently running it on the replacement worker. Capability IDs are provider-neutral (for example `repository_search`, `patch_application` or a project-defined migration capability); the trusted host derives them from qualification evidence. A model may not self-declare them.

This supports Qwen, OpenAI, Anthropic, Gemini, local models and future providers through the same contract. Replacing a model requires a new capability snapshot and plan, not a core-code change.

## Bounded decomposition

Every story declares exact allowed paths and operations, validation IDs, acceptance criteria, dependency edges, required capabilities and these budgets:

- files and changed lines;
- context bytes supplied to the worker;
- model/tool steps per attempt;
- attempts, capped at three.

The worker snapshot separately caps files, lines, context, acceptance-criteria count, DAG depth, steps and attempts. Plan loading fails before model execution if any story exceeds either the work contract or the active worker. A frontier planner therefore cannot hand an underqualified worker one large task and hope it succeeds; it must split the work or select a stronger qualified route.

`context_budget_bytes` and `max_steps` are enforcement inputs, not prompt suggestions. The trusted harness adapter must measure the complete worker-visible context and stop tool/model execution at those limits. If an adapter cannot prove that enforcement, the corresponding binding is not qualified for unattended execution.

## Protocol

1. The broker snapshots the exact activated worker capability.
2. The frontier planner emits a strict plan bound to the work contract, base SHA and worker capability hash.
3. The broker selects one highest-priority dependency-ready story and opens a fresh executor session.
4. The executor receives only the active story, last accepted tree hash, structured predecessor receipts and, on retries, one verified repair packet. It receives no prior model reasoning or free-form progress log.
5. Broker-owned path inspection and deterministic validation run before an independent fresh review.
6. The host atomically persists the iteration event and promotes only an accepted candidate tree. Rejected bytes are never promoted; retry starts from the last accepted tree.
7. Repeated normalized failure signatures escalate as `NO_PROGRESS` before wasting the remaining attempt budget. A different unresolved failure may retry until `ATTEMPT_LIMIT`. The plan's global iteration limit remains final.

The coding model cannot set `ACCEPTED`, choose the next story, edit its capability snapshot, increase budgets, create repair evidence, publish Git changes, or merge a pull request.

## Repair packets and clean retries

`RepairPacketV4` is created by the trusted validation/review boundary from the persisted finding hashes. It contains bounded category codes, paths/lines when applicable and short actionable instructions. Its hash, story ID, failed attempt and complete evidence set are checked before retry. A packet that introduces unrelated evidence fails closed.

Only `repair_packet_hash` is stored in the iteration event. Repair packets must exclude source text, diffs, prompts, transcripts, hidden reasoning, credentials and secrets. The next worker context receives the approved instructions, not the planner's or prior executor's chain of thought.

Validators and reviewers also emit normalized failure signatures. `createNormalizedFailureSignatureV4` derives a stable hash from source, category and path while intentionally ignoring finding IDs, line drift, wording and evidence-object identity. The executor combines those hashes without storing failure prose. Two consecutive identical signatures (or the qualified limit of three) trigger `NO_PROGRESS`; changing wording without changing the normalized finding identity cannot evade the guard.

## Durable host requirements

`persist_iteration` is one broker-owned transaction. When `promotion` is non-null, compare the current accepted tree with `input_tree_hash`, promote exactly `candidate_tree_hash`, and append the hash-verified event atomically. A retry after a lost response must return the existing canonical result. Promotion and journaling must never be separate effects.

The production host must also:

- derive the worker snapshot from the activated, hash-verified profile and qualification record;
- enforce context and step budgets outside the model;
- create normalized findings and repair packets outside the model;
- provide isolated fresh sessions, deterministic validators and independent review;
- retain the existing exact-SHA publication gate.

Public interchange schemas:

- `contracts/runtime-worker-capability-v4.schema.json`
- `contracts/runtime-story-plan-v4.schema.json`
- `contracts/runtime-repair-packet-v4.schema.json`
- `contracts/runtime-story-iteration-v4.schema.json`

This module is a provider-neutral runtime primitive. A trusted host driver must compose it; the schemas do not turn an unqualified harness into a safe autonomous worker.
