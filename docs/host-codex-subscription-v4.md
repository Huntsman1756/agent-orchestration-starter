# ChatGPT subscription host bridge V4

Runtime V4 can use a ChatGPT subscription for Codex orchestration and review without turning that subscription into an API gateway. The bridge launches the installed Codex CLI on the trusted host and accepts only a qualified OS-keyring ChatGPT login. It supports Windows, macOS, and Linux as separate host targets; each target still needs its own qualification evidence.

Repository activation writes the same keyring-only ChatGPT policy into `.codex/config.toml` for the interactive read-only orchestrator. Independent review uses the bounded host runner described below.

## Trust boundary

The bridge is deliberately review-only:

- `chatgpt-subscription` is valid only for read-only Codex orchestrator and reviewer bindings.
- Qwen3.6 and DeepSeek V4 Flash run through OpenCode and the Nano API. All repository writes, including economy model escalation and direct frontier execution, remain on distinct Nano bindings.
- Codex receives a read-only evidence capsule, `approval_policy="never"`, ignored user config and repository rules, and an ephemeral empty `CODEX_HOME`.
- The runner passes no API keys, tokens, broker endpoint, or inherited credential-shaped environment variables.
- `auth.json` is never copied, mounted, parsed, or placed in a capsule. Authentication remains in the host OS keyring.
- A fresh `codex login status` probe, exact policy hash, bounded process, strict JSON event parser, and review attestation verification are required for every review.

The host process is more privileged than a containerized reviewer because it can ask the operating system keyring for the saved login. Qualification therefore covers the exact Codex launcher, platform, arguments, and bridge policy. A copied login file or a writable Codex binding is not an acceptable substitute.

## Host enrollment

Install an exact Codex CLI version on each host. Configure Codex to store CLI credentials in the operating-system keyring and require ChatGPT login:

```toml
cli_auth_credentials_store = "keyring"
forced_login_method = "chatgpt"
```

Then authenticate interactively on that host and verify it:

```text
codex login
codex -c cli_auth_credentials_store='"keyring"' -c forced_login_method='"chatgpt"' login status
```

The expected status is `Logged in using ChatGPT`. If the login exists only in `auth.json`, the bridge reports `KEYRING_LOGIN_REQUIRED` and refuses to run. Re-authenticate after setting the keyring option; do not migrate the file into the runtime manually.

The host composition creates `createHostCodexSubscriptionRunnerV4` with:

- an absolute, immutable Codex launcher argv;
- an absolute broker-owned parent for ephemeral `CODEX_HOME` directories;
- a minimal platform-specific environment allowlist;
- the runner's returned policy hash as `expected_sandbox_policy_hash` for review.

Windows needs a qualified native launcher path and Credential Manager-compatible keyring support. macOS needs the login keychain available to the service account. Linux needs a supported Secret Service/keyring session for the service account. Headless services that cannot access a keyring remain unsupported instead of falling back to a credential file.

## Operational check

Before unattended use, prove on each platform that:

1. the probe succeeds from the same service account and session used by the host;
2. the temporary `CODEX_HOME` is removed after success and failure;
3. Codex cannot write inside or outside the capsule and cannot request approval;
4. no Nano or OpenAI API credential appears in argv, environment, logs, or capsule bytes;
5. a missing keyring login, changed launcher, changed policy hash, malformed JSON stream, timeout, or truncated output fails closed.

Official Codex references: [authentication](https://learn.chatgpt.com/docs/auth) and [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
