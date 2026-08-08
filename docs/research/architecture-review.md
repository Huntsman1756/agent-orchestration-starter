# Architecture review and source notes

Reviewed 2026-08-08. These notes separate durable design choices from provider-specific snapshots.

## Durable conclusions

- Use a small, self-contained work contract instead of forwarding the full conversation.
- Reserve frontier reasoning for decomposition, acceptance, and complete-diff review.
- Give implementation to an explicit economy assignment; never rely on model inheritance.
- Keep deterministic tests, linters, type checks, and source auditors authoritative.
- Permit automatic fallback only for availability failures. Authentication, policy, invalid output, grounding, and validation failures fail closed.
- Record the attempted and effective role assignment, but not prompts, secrets, or sensitive content.
- Keep stable role policy separate from replaceable provider/model profiles and harness-specific provider aliases.
- Treat economy-only, orchestrated, and frontier execution as competing routes by task class rather than assuming one universal path.
- Compare total cost per finally accepted task, including planning, review, repair, rereads, and escalation.
- Preserve first-pass failure telemetry when a frontier model rescues an economy attempt.

## Local projects

`eduayudas` already demonstrates typed availability fallback, attempted/effective provider telemetry, and fail-closed behavior for authentication, policy, invalid output, grounding, and validation. Its main portability cost is that concrete provider/model names appear across several layers; this starter confines them to profiles.

`mcpspain/official-sources` treats deterministic source auditors as authoritative and model output as advisory. That same ordering is encoded here: a reviewer cannot approve a failed deterministic gate, and the maker is never the sole verifier.

## Upstream material

- Helmcode's article and quickstart establish the orchestrator/executor split and concise result handoff: https://helmcode.com/es/posts/glm-5-2-deepseek-orquestador-ejecutor and https://github.com/helmcode/orchestrator-quickstart
- Codex supports project-scoped custom agents in `.codex/agents/*.toml`; provider credentials and provider definitions remain outside project-local config: https://learn.chatgpt.com/docs/agent-configuration/subagents and https://learn.chatgpt.com/docs/config-file/config-reference
- OpenCode agents support Markdown frontmatter for explicit models and permissions, while provider authentication is configured separately: https://opencode.ai/docs/agents/ and https://opencode.ai/docs/providers/
- Hermes delegation config exposes one parent model and one cheaper child model. Delegated children inherit the parent's tool surface, which creates the documented permission boundary: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md

## Snapshot profile

`profiles/chatgpt-subscription.yaml` is deliberately dated. At review time it maps orchestration/review to `gpt-5.6-sol` and bounded coding to `gpt-5.6-luna`, with the Hermes provider alias `openai-codex`. These are operational defaults, not architectural dependencies. Verify tool support and subscription availability locally with `doctor` and each harness's own authentication flow.

The Sol/Luna cost-quality hypothesis remains unproven until enough stratified observations pass `routing-gate.yaml`. The offline evaluator intentionally consumes measured total USD cost instead of embedding provider pricing, keeping historical evidence reproducible when price tables or model names change.
