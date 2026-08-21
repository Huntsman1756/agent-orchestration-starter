# Project profile selection V4

Runtime V4 selects trusted roles and qualified capabilities before it selects a
provider or model. A deployment may use one provider for every role, mix a
ChatGPT subscription with a provider API, or choose different providers in
different repositories. None of those choices changes stable repository
authority.

## Supported example topologies

| Example                                                                                              | Orchestrator and reviewer                         | Economy executor                                          | Escalation and frontier execution                                                             | Authentication boundary                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`nan-opencode.example.yaml`](../profiles/nan-opencode.example.yaml)                                 | Codex with a ChatGPT subscription                 | NaN Qwen3.6 through OpenCode                              | NaN DeepSeek V4 Flash for both economy reasoning and supervised direct execution (`DEGRADED`) | Subscription stays in the host keyring; NaN keys stay behind the provider gateway                          |
| [`nan-opencode-glm-premium.example.yaml`](../profiles/nan-opencode-glm-premium.example.yaml)         | Codex with a ChatGPT subscription                 | NaN Qwen3.6, with DeepSeek V4 Flash for economy reasoning | Distinct NaN GLM 5.2 premium frontier executor (`READY` for public-source topology)           | Same separation; the NaN key must have the GLM 5.2 premium tier                                            |
| [`runtime.chatgpt-subscription.example.yaml`](../profiles/runtime.chatgpt-subscription.example.yaml) | Codex with a ChatGPT subscription and GPT-5.6 Sol | OpenAI API GPT-5.6 Luna through OpenCode                  | OpenAI API GPT-5.6 Luna or Sol according to the resolved role                                 | A ChatGPT subscription is not an API credential; every writable API binding uses a separate provider lease |
| [`runtime.example.yaml`](../profiles/runtime.example.yaml)                                           | Replaceable frontier-capable binding              | Replaceable economical binding                            | Separately qualified escalation/frontier bindings                                             | The consumer defines and qualifies every exact authentication mechanism                                    |

These files are dated examples, not live credentials, recommendations for every
project, or proof that an account can use a model. Current OpenAI documentation
describes Sol as the flagship option for complex reasoning and coding, Terra as
the balance option, and Luna as the cost-sensitive high-volume option. That is
operational input for a dated profile, never routing authority.

NaN's dated API reference describes GLM 5.2 premium as supporting tool calling,
coding and long-horizon agentic tasks. That makes it an appropriate candidate
for the distinct frontier role, not prequalified evidence. Without that tier,
keep the standard profile's honest degradation or replace only
`frontierExecutor` with a separately qualified writable API binding from any
provider. Do not relabel an economy model as frontier merely to make the doctor
report green.

## Choose per repository

1. Start from the repository's data sensitivity, allowed mutations,
   deterministic validations and publication policy.
2. Define the capabilities needed by each role without provider names.
3. Copy the closest example into the consumer repository. Do not edit the
   upstream example or stable policy in place.
4. Set an explicit `authentication` value for every binding. A
   `chatgpt-subscription` binding is valid only for read-only Codex
   orchestration or review. A writable OpenAI, NaN or other API binding uses
   `provider-api-key` behind the broker gateway.
5. Preserve the schema-enforced tiers and authority: frontier read-only for
   planning/review, economy contract-write for ordinary workers and frontier
   contract-write for the protected fallback. Every writable role requires an
   explicit `execution` envelope.
6. Run `runtime doctor --repository-policy <path> --profile <path>` and inspect
   route collapse, trait coverage and same-model fallback warnings.
7. Qualify the exact provider, model deployment, harness, parser, guidance,
   tool bundle, platform and sandbox as one capability identity.
8. Benchmark representative project tasks. Keep the previous profile available
   for rollback and do not reuse its qualification evidence.

Private source must never be relabelled as public to fit a cheaper worker. If
no qualified binding supports the real sensitivity and required capability,
the route escalates or fails closed.

## Selection heuristics

- Prefer the smallest qualified worker that meets acceptance and safety gates;
  price, reputation and context-window size are not evidence.
- Keep orchestration and independent review read-only. A subscription-backed
  reviewer must not become an executor as a convenience fallback.
- Use one bounded repair before selecting a distinct escalation binding. Stop
  on mechanical failure instead of spending another model call blindly.
- Treat direct frontier execution and economy-model escalation as different
  authorities even when they currently resolve to the same physical model.
- Do not describe a same-provider/model fallback as a stronger-model
  escalation. It may have separate authority and budgets, but `runtime doctor`
  correctly reports it as degraded.
- Re-evaluate a profile when a project changes language, framework, source
  sensitivity, validation surface or publication authority.

See [model guidance](model-guidance-v4.md), [consumer adoption](consumer-adoption-v4.md)
and [external runtime qualification](external-runtime-qualification-v4.md) for
the required evidence.
