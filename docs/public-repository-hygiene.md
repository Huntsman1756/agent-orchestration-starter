# Public repository hygiene

This repository is public. Commits, pull requests, issues, Actions logs,
release artifacts and deleted Git history must be treated as permanently
shareable. Sanitization happens before publication, not after a secret or
personal detail has reached GitHub.

## Appropriate public evidence

- schemas, threat models and provider-neutral contracts;
- synthetic fixtures with invented repository and account identities;
- bounded counters, content hashes and redacted failure categories;
- exact public commit, release, harness and documentation versions; and
- reproducible commands that use placeholders and repository-relative paths.

## Never publish

- API keys, OAuth material, cookies, keyring exports, `auth.json`, `.env`
  contents, credential leases or gateway secrets;
- private source, prompts containing private source, raw model responses,
  hidden reasoning, full transcripts or unbounded logs;
- personal absolute paths, usernames, email addresses, machine names, account
  IDs, private repository names or screenshots containing them;
- real activation manifests, host inventories or certification artifacts that
  expose local topology; publish a sanitized fixture or its content hash; or
- copied third-party issue data, CI payloads or provider responses that the
  project does not have permission to redistribute.

Do not substitute realistic-looking credentials for safe fixtures. Use obvious
synthetic values that cannot be mistaken for a live secret, and keep the
fixture parser strict enough that examples cannot become ambient authority.

## Before opening a pull request

1. Inspect `git status`, the complete staged diff and every new binary asset.
2. Replace personal paths with repository-relative paths or documented
   placeholders such as `<repository-root>` and `<host-root>`.
3. Reduce logs to the smallest reproducible excerpt and remove environment
   values, prompts, source and provider payloads.
4. Confirm examples identify their date, trust level and unsupported claims.
5. Run `npm run validate`; report the exact pass/fail/skip result and platform
   rather than saying only that the change "works".
6. Use GitHub's private security advisory workflow for suspected
   vulnerabilities. Never move sensitive reproduction material into a public
   issue for convenience.

If sensitive material is published, stop further copying, revoke affected
credentials first, preserve only sanitized incident evidence, and contact the
maintainer through the process in [`SECURITY.md`](../SECURITY.md). Rewriting
Git history does not make an exposed credential safe again.

## Public claims

Use the adoption names from [consumer adoption](consumer-adoption-v4.md).
Tests of contracts and adapters do not prove a production host is certified.
CI on one operating system does not certify another platform, and a dated
profile does not prove account availability, quota, quality or cost. Public
documentation must distinguish implemented code, automated tests, exact-host
qualification and live dogfood evidence.
