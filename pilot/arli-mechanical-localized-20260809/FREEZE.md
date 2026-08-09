# ArliAI mechanical/localized Stage 1 pilot

Status: **FROZEN / NOT EXECUTED**

- Pilot: `arli-mechanical-localized-20260809`
- Manifest hash: `b431cc45d2a7cb6f08f0e3001621d446bf32b6fb8a8a82c3ec9ff8c020d70c96`
- Base commit: `6f49ab9f266c5b1ff25f59781d983fcaedafed64`
- Base tree: `4914db11b12b69be6c088ee9ee9eea0509d90a12`
- Cohort: 10 equivalent triplets / 30 blocks / 10 per arm at Stage 1
- Strata: 6 mechanical-low triplets and 4 localized-low triplets
- Initial cheap capability alias: `cost_optimized_coding` (currently intended to resolve to the configured ArliAI fast coding profile; the concrete model alias is recorded only in execution evidence)
- Strong capability alias: `private_review`
- Reviewer: strong capability with incremental diff review
- Stage 1: instrumentation and early rejection only; **promotion is impossible**
- Quality window: 7 days plus 60 seconds allowed clock skew

## Scope gate

Every block is low-risk, cheap-eligible, and limited to tests or documentation. The frozen contracts prohibit migrations, public schemas, concurrency, security, architecture, dependency changes, publication, merge, and deployment. Each arm runs in its own clean worktree from the same base commit.

## Evidence required per block

Record the V3 append-only events for planning, arm assignment, isolation, execution attempts, reviews, validation, usage, acceptance/rejection, and parent rework. Missing exit status, usage, timestamps, review outcome, or identity is incomplete evidence and cannot be inferred.

## Primary readout

Report first-pass acceptance, acceptance after one repair, strong-capability tokens per accepted block, wall time per accepted block, parent rework, and escaped defects. Keep observed token-equivalent usage separate from the fixed ArliAI subscription allocation; this Stage 1 calibration is not an economic promotion decision.

## Frozen artifacts

- [work-contracts.json](./work-contracts.json)
- [manifest.yaml](./manifest.yaml)
- [gate.yaml](./gate.yaml)
