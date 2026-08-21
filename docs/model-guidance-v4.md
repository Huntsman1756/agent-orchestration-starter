# Model guidance V4

Runtime V4 keeps repository authority and model tuning separate. Repository policy owns paths, validation, routing, permissions, and acceptance. Each replaceable model binding owns a required, versioned `guidance` block. The binding hash includes the model and the complete guidance block, so changing either invalidates prior qualification evidence.

## Current subscription snapshot

`profiles/runtime.chatgpt-subscription.example.yaml` is dated `2026-08-10`. It assigns `gpt-5.6-sol` to frontier orchestration, frontier execution, and independent review, and `gpt-5.6-luna` to economical coding. Sol starts at high reasoning effort for quality-sensitive work. Luna starts at low effort, low verbosity, and a smaller step budget for bounded high-volume implementation. These are profile choices, not stable policy.

The pack follows current official OpenAI guidance: keep prompts lean, state instructions once, define autonomy and success criteria, expose only relevant tools, and measure reasoning effort on representative tasks instead of assuming that the maximum is best. OpenCode receives the bounded model options through its broker-owned agent configuration. Codex receives only an allowlisted `model_reasoning_effort` override. Unsupported Codex effort values fail qualification instead of being ignored.

The NaN/OpenCode snapshot dated `2026-08-16` keeps ChatGPT-authenticated Codex as the read-only orchestrator and independent reviewer. Its Qwen3.6 executor uses direct bounded tool instructions and provider-default inference settings. After one Qwen repair, the economy sequence resolves the separate DeepSeek V4 Flash `escalationExecutor`; a direct frontier route resolves `frontierExecutor` independently. DeepSeek owns both write bindings because NaN documents tool calling for that model, but the two roles require different hash-bound authority. Because those two roles reuse the same provider/model identity, this example demonstrates stronger frontier supervision and separate authority, not a stronger-model execution fallback; `runtime doctor` reports it as `DEGRADED`. No Codex subscription binding has write authority. Gemma4 is not used as an agentic coding binding because the current NaN API reference does not list tool calling for it. Both exact Nano bindings still require fresh capability probes and paired task evidence. Their dated sources live beside the bindings in `profiles/nan-opencode.example.yaml`.

The broker-owned OpenCode config declares NaN through `@ai-sdk/openai-compatible`, registers only the selected model, points it at the internal egress gateway, and reads the gateway's non-secret bearer value from `PROVIDER_GATEWAY_TOKEN`. The real NaN key remains in the credential gateway. Codex subscription credentials likewise remain in Codex's host credential store and must not be copied into executor or review capsules.

## Provider-family templates

Use these as starting points, then qualify and benchmark the exact model/harness combination:

| Family | Prompt pack | Inference starting point | Migration risk to test |
|---|---|---|---|
| OpenAI reasoning/coding | Lean Markdown, explicit constraints, evidence, stopping condition | Low for economical coding; high only for measured frontier gains | Excess instructions, unnecessary effort, unsupported Codex config |
| Anthropic Claude | Clear role and constraints; XML is useful for mixed context; explicitly damp overengineering when observed | Provider default/adaptive thinking first | Overexploration, unnecessary abstractions, excessive subagents |
| Google Gemini | Direct consistent Markdown or XML; put large context before the final task | Provider default thinking first; specify verbosity | Long-context ordering, fallback responses, tool/reasoning configuration drift |
| Unknown/new family | Minimal plain or Markdown prompt with no provider-specific inference override | `provider-default` | Qualification must prove structured output, bounded edits, repair, isolation, and credential separation |

Sources: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Google Gemini prompt design](https://ai.google.dev/gemini-api/docs/prompting-strategies), and [OpenCode agent options](https://opencode.ai/docs/agents).

## Context engineering invariants

Context is a finite execution input, not an unbounded transcript. Runtime hosts
must preserve these provider-neutral invariants:

- Keep the static prompt prefix deterministic. Stable broker instructions,
  versioned model guidance and fixed tool definitions precede task-specific
  material. Do not put timestamps, request IDs, retry counters or other
  volatile values in that prefix. A serialization change is a harness/parser
  revision change and requires fresh qualification.
- Freeze the tool surface for the complete attempt. The broker exposes only
  capability-approved actions from the `tool_bundle_hash`; changing that set
  creates a new capability identity instead of silently adding or removing
  tools from an active context.
- Prefer progressive disclosure. Give the worker bounded paths, hashes,
  receipts and approved instructions, then let it retrieve relevant repository
  bytes as needed. The measured context budget includes system instructions,
  tool definitions, retrieved content and tool results, not only the task text.
- Make context reduction restorable. Runtime V4 normally starts a fresh
  context for each attempt and carries forward accepted receipts plus a
  verified repair packet. Full logs and authority evidence remain in
  broker-owned storage; a summary or model-authored note never replaces or
  rewrites them.
- Record provider-reported input, output, cached-input and reasoning usage when
  available, preserving `null` when a dimension is unsupported. Prefix caching
  is a best-effort cost/latency optimization. It cannot change validation,
  acceptance, routing or authority, and one provider's cache behavior is not
  qualification evidence for another.
- Do not turn progress notes into cross-run mutable memory. Durable plans,
  journals, accepted receipts and evidence hashes are the authoritative
  continuity mechanism. Any future learned instruction still follows the
  separately governed post-dogfood compounding process.

These rules favor the smallest high-signal context that remains auditable. A
larger context window does not justify forwarding planner rationale, raw prior
traces or every available skill to the worker.

## Safe model replacement

1. Copy the profile; do not edit repository policy.
2. Change the provider/model and every guidance field as one reviewed unit.
3. Set a new guidance `id` or `revision` and record current HTTPS vendor documentation.
4. Use `provider-default` for inference controls the adapter cannot prove it supports.
5. Run three fresh capability probes for the exact profile, harness version, broker version, and agent policy hash.
6. Run paired benchmark tasks for the affected `task_class × route`; do not promote from model reputation or price claims.
7. Keep the prior profile available for rollback. Never reuse its qualification record after a model or guidance change.

Prompt guidance does not grant authority. It cannot add tools, paths, network access, attempts, merge rights, or deployment rights beyond the frozen repository policy and sandbox.

## Worker capability and task sizing

Model guidance is also not evidence that a worker can handle an arbitrarily large coding task. For iterative execution, the broker materializes a separate `WorkerCapabilityV4` from the activated binding and its qualification evidence. The snapshot binds the exact provider/model revision, endpoint, harness, tool parser, tool bundle and instruction/skill bundle. Its limits cap files, changed lines, context, acceptance criteria, dependency depth, steps and attempts.

The frontier planner sees those provider-neutral capabilities and limits and must emit smaller stories that fit them. It must select another qualified route when the task cannot be decomposed safely. A profile change invalidates the capability hash and all plans bound to it. This makes model replacement explicit without hard-coding Qwen, Luna, Codex or any other current model into repository policy.

Stack and task practice packs are resolved by the trusted host, not by the model profile. Load only the packs relevant to the active story and include their exact bytes in `instruction_bundle_hash`; do not give a smaller worker every available skill or fetch new guidance during execution. See [`delegation-practice-packs-v4.md`](delegation-practice-packs-v4.md).
