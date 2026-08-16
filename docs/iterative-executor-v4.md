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

## Strict SDD write boundary

Every V4 work contract now carries two explicit path matrices:

- `acceptance_tests`: Planner-authored `.spec.ts` and `.test.ts` files. The Economy executor may read the complete repository snapshot, including these tests, but may never write them.
- `implementation_targets`: non-test `.ts` files and their approved operations. These are the only write targets granted to the Economy executor.

`allowed_changes` remains a hash-bound compatibility projection and must exactly mirror `implementation_targets`; it is not an independent authority. The broker inspects the implementation targets before launch, OpenCode denies every other edit path, and the economy diff interceptor rejects any observed acceptance-test change as `ECONOMY_POLICY_VIOLATION` before the candidate can be accepted. The normalized repair instruction is: `Intentaste modificar los tests de aceptación. Esto está prohibido por el contrato. Solo modifica los archivos de implementación.`

## Static capability snapshot and context culling

Before a coding runner starts its model session, `src/routing/capability-snapshot.ts` parses the declared implementation targets and acceptance tests with the TypeScript compiler API. It follows only statically observable local edges: imports/exports, literal `require()` or `import()` specifiers, import-type nodes and TypeScript reference paths. It never loads or evaluates repository modules. Package imports and dynamic expressions are excluded; unresolved local static imports fail closed, while ignored dynamic edges are recorded in the snapshot metadata.

The default bounded context is 128 KiB and the parser caps the graph at 256 files. When the complete dependency closure would exceed the limit, the snapshot switches to `SIGNATURE_FALLBACK`: target and test roots retain full source, while dependencies contribute only exported type/interface signatures (plus safe declaration signatures). If even that bounded form cannot fit, execution fails before the model is invoked. The final ordered file set, inclusion modes, source revision and ignored-edge evidence are SHA-256 bound by `snapshot_hash`.

OpenCode and Codex inject the rendered `<capability_snapshot>` blocks before the task and return the same hash in their execution receipt. The Review Envelope and Broker Review Packet carry `capability_snapshot_hash`; the durable review-verdict journal record includes it in its own hash chain. A reviewer can therefore verify both the exact bounded context seen by the worker and its transitive audit-trail binding.

## Shift-left validation gate

The project policy runs `npm run lint` and `npm run format:check` as deterministic, networkless validation commands. ESLint uses the TypeScript parser plus `eslint-plugin-security`; the security gate rejects executable evaluation such as `eval()` and the controlled strict type-checked profile applies to the new broker quality boundary. `npm audit` is deliberately not part of this sandbox gate because it is network-dependent and cannot provide a reproducible offline verdict.

The broker validates the static-quality results before invoking a fresh Frontier reviewer. If `lint` or a format gate fails, the reviewer callback is not reached. The broker creates a hash-bound `RepairPacketV4` with category `shift_left_static_quality`, ties each finding to the validation evidence hash, and forwards the bounded instruction `Las pruebas pasan, pero el código viola las políticas estáticas de calidad/seguridad. Repara los siguientes errores de lint antes de reclamar completitud.` to the Economy repair path.

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
4. The executor receives only the active story, the immutable acceptance-test list, implementation-target authority, last accepted tree hash, structured predecessor receipts and, on retries, one verified repair packet. It receives no prior model reasoning or free-form progress log.
5. Broker-owned path inspection and deterministic validation run before an independent fresh review.
6. The host atomically persists the iteration event and promotes only an accepted candidate tree. Rejected bytes are never promoted; retry starts from the last accepted tree.
7. Repeated normalized failure signatures escalate as `NO_PROGRESS` before wasting the remaining attempt budget. A different unresolved failure may retry until `ATTEMPT_LIMIT`. The plan's global iteration limit remains final.

The coding model cannot set `ACCEPTED`, choose the next story, edit its capability snapshot, increase budgets, create repair evidence, publish Git changes, or merge a pull request.

## Single-writer execution

Contract-write authority is serial within a run. The broker selects one
dependency-ready story, awaits one executor attempt and promotes at most one
candidate tree before another writer can start. Planner and reviewer contexts
remain read-only, and no parallel child executor may write to the same run
worktree. This keeps implicit code and design decisions in one ordered history
that replay can reconstruct.

A host may parallelize bounded, independent discovery only as read-only work.
Each discovery task needs an explicit objective, scope and output contract, and
returns condensed evidence to the frontier planner; it cannot edit files,
approve output, share credentials or mutate the active story. Such fan-out is
an optional measured route for breadth-heavy research, not the default for
coding, and it does not increase runtime authority.

## Frontier-led review control

The host may set `review_control.mode` to `FRONTIER_LED` when a frontier model
must coordinate and review while an economical model performs the bounded code
work. In this mode a rejected attempt is persisted and the executor returns
`AWAITING_FRONTIER_DECISION`. It does not create another worker session until
the host resumes it with `RETRY` bound to the exact rejected `event_hash`, a
unique decision ID, the decision-owner reference and a hash of host-verified
authority evidence. Before acting, the broker persists a canonical
`FRONTIER_DECISION_RECORDED` event in a self-hashed, plan-bound decision chain.
The next iteration binds that `decision_hash`. `ESCALATE` is persisted in the
same way and stops without another worker call. Missing, altered, duplicate,
stale and cross-mode decisions fail closed.

A crash after decision persistence but before worker launch resumes from the
pending durable decision; it neither requests a replacement decision nor
creates a second authorization record. Replay requires every frontier-led
attempt greater than one to consume the exact `RETRY` decision for the
immediately preceding rejected event. `inspectIterativeTrajectoryV4` and the
portable execution graph accept the same decision evidence and include its
hashes in their verified output.

This gate is deliberately separate from the worker receipt. The worker reports
candidate bytes; deterministic validation and independent review create the
evidence; the frontier decides whether another delegated attempt is justified.
The existing `AUTONOMOUS_BROKER` mode remains available for separately
qualified deployments whose trusted broker owns retry policy. Consumers must
name the mode they actually operate and must not describe broker-driven retry
as frontier orchestration.

### Provider-neutral automatic supervisor

`runFrontierSupervisorV4` closes the control-loop gap for `FRONTIER_LED`
deployments. It repeatedly invokes the iterative executor, asks a host-supplied
frontier decision port only when a persisted rejection is waiting, binds the
returned `RETRY` or `ESCALATE` to that exact event and resumes from the durable
event/decision chains. A retry therefore launches a fresh economical-worker
session with the verified repair packet; escalation stops before another
worker call. Invalid decisions, frontier-port failures and exhausted decision
budgets fail closed.

The supervisor is provider-neutral. `decide`, `execute`, `review`,
`load_repair_packet` and persistence are host ports, so ChatGPT + NAN,
frontier-only OpenAI, Anthropic + a local worker, or future combinations use
the same loop after exact qualification. The supervisor never obtains provider
credentials, invents repair findings or silently falls back to direct frontier
execution.

This function must be called by the host's admitted-run pipeline. Merely
generating a profile, an `AGENTS.md` rule or a project-local launcher does not
activate delegation. Consumer verification should prove at least one
`reject -> durable frontier RETRY -> repair attempt` trajectory and record
usage for planner, worker and reviewer roles.

## Repair packets and clean retries

`RepairPacketV4` is created by the trusted validation/review boundary from the persisted finding hashes. It contains bounded category codes, paths/lines when applicable and short actionable instructions. Its hash, story ID, failed attempt and complete evidence set are checked before retry. A packet that introduces unrelated evidence fails closed.

Only `repair_packet_hash` is stored in the iteration event. Repair packets must exclude source text, diffs, prompts, transcripts, hidden reasoning, credentials and secrets. The next worker context receives the approved instructions, not the planner's or prior executor's chain of thought.

Validators and reviewers also emit normalized failure signatures. `createNormalizedFailureSignatureV4` derives a stable hash from source, category and path while intentionally ignoring finding IDs, line drift, wording and evidence-object identity. The executor combines those hashes without storing failure prose. Two consecutive identical signatures (or the qualified limit of three) trigger `NO_PROGRESS`; changing wording without changing the normalized finding identity cannot evade the guard.

## Durable host requirements

`persist_iteration` is one broker-owned transaction. When `promotion` is non-null, compare the current accepted tree with `input_tree_hash`, promote exactly `candidate_tree_hash`, and append the hash-verified event atomically. A retry after a lost response must return the existing canonical result. Promotion and journaling must never be separate effects.

In `FRONTIER_LED` mode, `persist_frontier_decision` is a second privileged host
port. It must validate the referenced authority evidence outside the model and
durably append the exact canonical decision before returning. A duplicate
`decision_id` or rejected-event binding must return the existing identical
record or fail; it must never create another authority effect. On restart the
host supplies both `prior_events` and `prior_frontier_decisions`.

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
- `contracts/runtime-frontier-decision-v4.schema.json`

This module is a provider-neutral runtime primitive. The thin trusted root must compose it from separately qualified host ports; the schemas do not turn an unqualified harness into a safe autonomous worker.

See [`delegation-practice-packs-v4.md`](delegation-practice-packs-v4.md) for the deterministic instruction layering, frontend/backend examples, full-stack decomposition and escalation checklist expected from that host integration.
