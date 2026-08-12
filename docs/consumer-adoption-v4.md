# Runtime V4 consumer adoption guide

This guide is the handoff path for a team that wants to use this repository in
another project. It separates a useful orchestration pattern from a certified
Runtime V4 deployment so that local wrappers, model permissions and path
checks are not mistaken for hard isolation.

## Choose and name the adoption level

| Level | What is present | Permitted claim | Not yet established |
| --- | --- | --- | --- |
| `PATTERN_ONLY` | role split, bounded prompt and independent human/frontier review | "inspired by Agent Orchestration Starter" | enforced contracts, clean execution, durable evidence |
| `BOUNDED_LOCAL` | typed contract, clean isolated worktree, exact path checks, deterministic validation and no worker publication | "bounded local delegation" | certified sandbox, durable daemon, autonomous publication |
| `ANALYSIS_ONLY` | installed Runtime V4 contracts, repository policy/profile and hash-bound activation | "Runtime V4 analysis activation" | model execution or publication authority |
| `ISOLATED_EXECUTION` | complete certified host evidence and publication disabled | "certified isolated execution for this exact binding" | autonomous publication |
| `AUTONOMOUS_PUBLICATION` | isolated execution plus GitHub lease, publication policy and post-merge verification | "certified autonomous publication for this exact binding" | deployment, production mutation or global routing authority |

Adoption is monotonic only through evidence. A project does not become
`ISOLATED_EXECUTION` because a worker obeyed instructions, OpenCode denied some
tools, a container existed, or a post-run script found no path violation.

## Freeze the handoff identity

Before adapting anything, record:

- the release tag and full upstream commit SHA;
- package version and Runtime schema family;
- operating system, architecture and Node major;
- repository policy hash and runtime profile hash;
- harness, provider, model deployment, parser, guidance and skill bundle;
- intended activation target and whether publication is enabled;
- host-composition and qualification evidence when execution is requested.

Do not track mutable `main` for a pilot. A changed model, harness, parser,
guidance pack, policy, host component or platform creates a new qualification
unit even when its friendly name is unchanged.

## Start from a clean upstream checkout

```powershell
git clone https://github.com/Huntsman1756/agent-orchestration-starter.git
cd agent-orchestration-starter
git checkout v0.2.0
npm ci
npm run validate
npm run build
```

The release tag is the source identity. Verify the GitHub release checksum and
provenance before distributing its tarball to another machine.

## Define repository-owned inputs

Copy the examples rather than editing them in place:

- [`policies/repository-policy.example.yaml`](../policies/repository-policy.example.yaml)
  becomes the target repository's stable authority policy;
- [`profiles/runtime.example.yaml`](../profiles/runtime.example.yaml) becomes a
  dated replaceable binding profile;
- [`orchestration.yaml`](../orchestration.yaml) remains the V1 compiler input
  when only generated harness configuration is needed.

Keep provider and model identifiers out of stable policy. A consumer policy
owns branches, paths, source sensitivity, validation commands, sandbox
requirements and publication authority. The profile owns provider/model,
harness/parser, guidance, tool and qualification identities.

For private repositories, declare `PRIVATE`; never relabel source as `PUBLIC`
to make an economical binding eligible. If no compatible binding exists, the
route elevates or fails closed.

## First safe result: compiler dry run

The compiler can be evaluated before installing a privileged host:

```powershell
node dist/cli/main.js init `
  --target G:\path\to\consumer-repository `
  --policy orchestration.yaml `
  --profile profiles/open-compatible.yaml `
  --harnesses codex,opencode `
  --dry-run
```

Inspect every proposed managed file. Run `doctor` and `check` with the same
policy/profile. Do not silently overwrite unmanaged agent configuration or
interpret generated files as runtime certification.

## First Runtime V4 result: analysis-only activation

Build and install the immutable bundle without production host components:

```powershell
node dist/host/agent-orchestration.mjs runtime install `
  --source-root G:\path\to\agent-orchestration-starter `
  --host-root C:\ProgramData\agent-orchestration
```

Then activate one repository with no execution authority:

```powershell
node <installed-entrypoint> runtime activate `
  --repository-root G:\path\to\consumer-repository `
  --policy G:\path\to\consumer-repository\policies\repository-policy.yaml `
  --profile G:\path\to\consumer-repository\profiles\runtime.yaml `
  --worktree-parent G:\worktrees\consumer-repository `
  --installation-manifest <installation-v4.json> `
  --host-root C:\ProgramData\agent-orchestration `
  --target ANALYSIS_ONLY
```

`ANALYSIS_ONLY` may report missing host evidence as warnings. That is an
expected inventory result, not permission to execute. Preserve the activation
manifest and readiness report with the handoff record.

## Bounded local delegation without Runtime V4

A project may deliberately stop at `BOUNDED_LOCAL`. Its launcher must enforce,
outside the model:

1. one typed objective with exact repository-relative allowed files;
2. a clean dedicated Git worktree before launch;
3. fixed executable, argv, model binding, timeout and working directory;
4. no shell interpolation and no repository/provider credentials in input;
5. post-run rejection of every unauthorized path or unsafe file type;
6. deterministic validation run independently from model claims;
7. independent review of the diff and evidence;
8. no commit, push, PR, merge, deploy or production mutation by the worker;
9. bounded repair followed by frontier escalation or stop;
10. a factual receipt that is evidence for review, never self-acceptance.

When the frontier model is the advertised orchestrator/reviewer, use the
frontier-led control described in
[`iterative-executor-v4.md`](iterative-executor-v4.md#frontier-led-review-control):
persist each rejected attempt, stop, and require an event-bound frontier
decision before retrying. Persist that canonical decision before opening the
next worker session, retain its owner and verified authority-evidence hash, and
bind its `decision_hash` into the following iteration receipt. A restart must
replay the persisted decision; it must not ask for or spend a second decision.
An automatic broker retry may be valid under a separately qualified policy, but
it is a different operating topology and must be named `AUTONOMOUS_BROKER`, not
presented as frontier-led orchestration.

A before/after file snapshot is useful detection, but it is not prevention and
does not prove hard isolation. Preserve violations for review; do not run a
broad cleanup that could destroy unrelated work.

Before claiming that the economical worker is active, follow the executable
delegation evidence and troubleshooting checklist in
[`harness-adapters-v4.md`](harness-adapters-v4.md). `AGENTS.md`, a profile and a
project-local OpenCode agent are declarative inputs, not proof that the launcher
ran or that provider usage was attributed to the worker.

## Optional report-only roles

Consumers often need source extraction or document synthesis in addition to
coding. Keep these roles outside the mutable coding route unless a later
versioned contract explicitly incorporates them.

A report-only role should receive supplied local text or an allowlisted primary
source, have no edit/publication authority, separate literal evidence from
interpretation and return an explicitly untrusted draft. A frontier reviewer or
deterministic verifier must check source identity, dates, anchors and safety
flags before any downstream use. Model output alone is never publication or
database-write authority.

## Move to certified execution

Before changing the target to `ISOLATED_EXECUTION`, require all evidence listed
by [`runtime-v4-operations.md`](runtime-v4-operations.md): the thin root and
eight certified host components, immutable installation, credential gateway,
provider gateway compatibility, exact three-run binding qualification and
Docker sandbox certification for the exact host.

Windows, Linux and macOS are separate qualification units. Current native
release evidence is Linux x64; platform CI does not certify a Windows or macOS
production sandbox. Run `runtime doctor --activation <activation-v4.json>` and
require the readiness report to pass without replacing missing evidence with a
boolean assertion.

Enable `AUTONOMOUS_PUBLICATION` only in a new activation after isolated
execution is qualified. Keep deployment and production-data mutation outside
the publication authority.

## Consumer handoff checklist

- [ ] Upstream tag, full commit and artifact checksum are pinned.
- [ ] Adoption level and prohibited claims are written down.
- [ ] Stable policy contains no provider/model names.
- [ ] Profile identifies exact provider/model/harness/parser/guidance bytes.
- [ ] Source sensitivity matches the real repository.
- [ ] Credentials remain outside repository-controlled descendants.
- [ ] Code workers use clean isolated worktrees and exact path contracts.
- [ ] Validation and review are independent from worker claims.
- [ ] Retry ownership is explicit; frontier-led runs prove through the decision chain and iteration binding that no second worker call occurs without durable frontier authority.
- [ ] Report-only extensions cannot publish or mutate application data.
- [ ] Publication is disabled until its separate evidence gate passes.
- [ ] Platform and host qualification are current for the exact deployment.
- [ ] Model/profile changes trigger reactivation and fresh qualification.
- [ ] A synthetic low-risk shakedown succeeds before real repository work.
- [ ] The shakedown proves route, launch, native harness events and provider usage; it does not infer delegation from instructions or a diff.
- [ ] A rollback/abort path is exercised before unattended operation.

## Common invalid shortcuts

- Copying a provider-specific profile into stable repository policy.
- Calling a project-local script "Runtime V4" without installation and host evidence.
- Delegating from a dirty active checkout.
- Trusting validation text written by the worker instead of rerunning it.
- Treating path snapshots, tool permissions or container presence as hard isolation.
- Allowing a report-only extractor to create publishable facts or drafts directly.
- Reusing Linux, model or harness qualification after any identity change.
- Giving the model GitHub, deployment, database or saved provider credentials.

These shortcuts may still support an explicitly named local experiment, but
they must not be represented as certified autonomous execution.
