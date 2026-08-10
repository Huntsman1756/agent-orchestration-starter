# Model guidance V4

Runtime V4 keeps repository authority and model tuning separate. Repository policy owns paths, validation, routing, permissions, and acceptance. Each replaceable model binding owns a required, versioned `guidance` block. The binding hash includes the model and the complete guidance block, so changing either invalidates prior qualification evidence.

## Current subscription snapshot

`profiles/runtime.chatgpt-subscription.example.yaml` is dated `2026-08-10`. It assigns `gpt-5.6-sol` to frontier orchestration, frontier execution, and independent review, and `gpt-5.6-luna` to economical coding. Sol starts at high reasoning effort for quality-sensitive work. Luna starts at low effort, low verbosity, and a smaller step budget for bounded high-volume implementation. These are profile choices, not stable policy.

The pack follows current official OpenAI guidance: keep prompts lean, state instructions once, define autonomy and success criteria, expose only relevant tools, and measure reasoning effort on representative tasks instead of assuming that the maximum is best. OpenCode receives the bounded model options through its broker-owned agent configuration. Codex receives only an allowlisted `model_reasoning_effort` override. Unsupported Codex effort values fail qualification instead of being ignored.

The existing NaN/OpenCode example is also explicit. Its Qwen3.6 executor uses direct bounded tool instructions and provider-default inference settings; its Gemma4 escalation binding emphasizes the exact output contract and minimal edits. Neither setting is promoted merely because a vendor lists the model: both exact bindings still require fresh capability probes and paired task evidence. Their dated sources live beside the bindings in `profiles/nan-opencode.example.yaml`.

## Provider-family templates

Use these as starting points, then qualify and benchmark the exact model/harness combination:

| Family | Prompt pack | Inference starting point | Migration risk to test |
|---|---|---|---|
| OpenAI reasoning/coding | Lean Markdown, explicit constraints, evidence, stopping condition | Low for economical coding; high only for measured frontier gains | Excess instructions, unnecessary effort, unsupported Codex config |
| Anthropic Claude | Clear role and constraints; XML is useful for mixed context; explicitly damp overengineering when observed | Provider default/adaptive thinking first | Overexploration, unnecessary abstractions, excessive subagents |
| Google Gemini | Direct consistent Markdown or XML; put large context before the final task | Provider default thinking first; specify verbosity | Long-context ordering, fallback responses, tool/reasoning configuration drift |
| Unknown/new family | Minimal plain or Markdown prompt with no provider-specific inference override | `provider-default` | Qualification must prove structured output, bounded edits, repair, isolation, and credential separation |

Sources: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices), [Google Gemini prompt design](https://ai.google.dev/gemini-api/docs/prompting-strategies), and [OpenCode agent options](https://opencode.ai/docs/agents).

## Safe model replacement

1. Copy the profile; do not edit repository policy.
2. Change the provider/model and every guidance field as one reviewed unit.
3. Set a new guidance `id` or `revision` and record current HTTPS vendor documentation.
4. Use `provider-default` for inference controls the adapter cannot prove it supports.
5. Run three fresh capability probes for the exact profile, harness version, broker version, and agent policy hash.
6. Run paired benchmark tasks for the affected `task_class × route`; do not promote from model reputation or price claims.
7. Keep the prior profile available for rollback. Never reuse its qualification record after a model or guidance change.

Prompt guidance does not grant authority. It cannot add tools, paths, network access, attempts, merge rights, or deployment rights beyond the frozen repository policy and sandbox.
