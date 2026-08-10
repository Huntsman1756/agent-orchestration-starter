# Runtime V4 publication

Runtime V4 exposes a broker-owned publication step after deterministic local finalization. A successful call to `publishFinalizedRunV4` performs the complete GitHub sequence without giving a model GitHub credentials or Git authority:

1. acquire the run and repository locks;
2. push the exact accepted commit SHA to `codex/auto/<run-id>` without force or hooks;
3. find or create one pull request with the exact head and policy-owned base;
4. wait for required checks when repository policy requires them;
5. merge with the policy-owned method and `--match-head-commit`;
6. verify the merged PR and merge commit, then append `RUN_MERGED` evidence.

Each remote boundary is journaled before the next one. Runtime state advances through `READY_FOR_PUBLICATION`, `PUBLICATION_PUSHED`, `PULL_REQUEST_OPEN`, `REQUIRED_CHECKS_PASSED`, and finally `FINALIZED`. The public result retains the remote name, base branch, pull request identity and verified merge SHA. When policy or the work contract explicitly disables publication, a `PUBLICATION_SKIPPED` command closes the local run without pretending it was merged.

The operation is retry-safe. `BRANCH_PUSHED`, `PULL_REQUEST_RECORDED`, `REQUIRED_CHECKS_PASSED`, and `RUN_MERGED` use deterministic command identities. If the process stops after a remote effect, the next attempt verifies the same SHA/head/base and reuses the durable command instead of repeating state transitions. If GitHub already merged, it verifies and records the existing merge without issuing another merge.

## Authority boundary

Models can propose source changes only. They cannot choose the remote, base branch, merge method, check policy or publication timeout. Those fields belong to the hashed repository policy. A work contract containing `push`, `merge` or `publish` in `prohibited_actions` fails closed.

`createGithubPublicationAdapterV4` is the concrete GitHub adapter. The trusted host supplies the canonical repository root, `owner/repository` identity, expected remote name, an empty hooks directory and an empty global Git config. The adapter:

- launches `git` and `gh` directly without a shell;
- uses bounded time and output;
- disables prompts, system Git configuration, ambient credential helpers, external protocols and submodule recursion;
- supplies the fixed `gh auth git-credential` helper only to the trusted Git process;
- pushes an explicit SHA refspec and never uses force;
- uses an explicit repository, head, base and non-maintainer-editable PR;
- waits only for required checks and binds merge to the previously accepted head SHA;
- validates that GitHub responses identify exactly the configured repository and PR.

The host composition must create and certify the empty hooks/config paths outside every registered repository and lease GitHub authentication only to this adapter. Worktrees, model containers, validation and review capsules must not receive `GH_TOKEN`, `GITHUB_TOKEN`, credential-manager access or the broker's Git configuration.

## Provider neutrality

Publication is downstream of model selection. Changing an orchestrator, executor or reviewer binding does not change this protocol. GitHub is one `PublicationAdapterV4` implementation; another forge can implement the same interface while preserving exact-SHA push, exact head/base identity, required-gate waiting, head-bound merge and verified durable evidence.

## Current activation gate

The library surface and GitHub adapter are automated and tested, but the repository still does not ship a production host composition that leases saved credentials and connects every pipeline stage to the durable daemon. Until that composition and host certification exist, Runtime V4 remains a framework rather than a one-command unattended service.
