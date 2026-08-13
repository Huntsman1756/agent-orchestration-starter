# Signed delegation provenance V4

`AGENTS.md`, prompts and model profiles can request delegation, but they cannot
prove that a worker actually ran. This optional gate makes mandatory delegation
an enforceable publication property without coupling policy to NAN, Qwen,
OpenCode or any other current provider, model or harness.

## Trust boundary

Only the privileged host may access the Ed25519 signing operation. The private
key must remain in the credential gateway, OS keystore, HSM or equivalent
broker-owned boundary. It must never enter a repository, worktree, model
context, container, environment inherited by a model, or CI log.

The signed evidence binds:

- run, contract, policy and replaceable profile identities;
- worker capability identity for delegated routes;
- base commit, finalized commit, Git tree, evidence tree and accepted diff;
- accepted story receipts and frontier retry/escalation decisions;
- deterministic validation and independent review attestations;
- an explicit authority-bound exemption when execution is intentionally
  frontier-only.

`DELEGATED` requires at least one accepted worker receipt and cannot claim
`FRONTIER_EXECUTION`. `FRONTIER_ONLY_EXEMPTION` requires a reason code,
authority identity and authority-evidence hash. It is not counted as economical
delegation.

## Safe activation

The publication API remains backward compatible. Existing hosts omit
`delegation_provenance_gate` or pass `{ enforcement: "DISABLED" }`. A qualified
host that has produced and durably stored signed evidence passes:

```ts
await publishFinalizedRunV4({
  ...input,
  delegation_provenance_gate: {
    enforcement: 'REQUIRED',
    evidence,
    trusted_public_key: protectedPublicKey,
  },
});
```

Verification happens before publication locks, network calls or push. Missing,
invalid, differently signed or stale evidence fails closed. Do not enable the
gate until the exact host can sign a synthetic run and recover its evidence
after restart.

## CI verification

The same public contract is available through the CLI:

```powershell
agent-orchestration runtime verify-delegation `
  --evidence <protected-artifact.json> `
  --public-key <protected-ed25519-public-key.pem> `
  --commit-sha <exact-head-sha> `
  --git-tree-sha <exact-head-tree-sha> `
  --policy-hash <activated-policy-hash> `
  --profile-hash <activated-profile-hash>
```

Evidence must be retrieved from a protected broker artifact store or trusted
control-plane service. Do not commit it into the candidate tree: an evidence
file cannot safely bind the commit that contains itself, and a pull request
author must not be able to replace the trusted public key or expected
policy/profile hashes. Branch protection should require this check for
repositories that advertise mandatory delegation.

## Rotation and portability

The evidence includes a key identifier derived from the public SPKI bytes.
Rotating the key, model, provider, harness, parser, guidance bundle, worker
capability, policy or profile creates new evidence and may require fresh
qualification. The semantic contract is provider-neutral; only the profile and
capability binding change.
