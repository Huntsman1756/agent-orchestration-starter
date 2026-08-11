# Evidence compounding design

## Status and sequencing

This document defines a post-dogfood design boundary. It does not add an
active learning path, change Runtime V4, or alter the frozen Dogfood V1
experiment. Implementation and activation remain blocked until the first
dogfood manifest has completed or stopped and its evidence has been retained.

The design borrows the useful Compound Engineering principle that completed
work should make later work easier. In this runtime, compounding means turning
retained evidence into separately governed candidates. It never means allowing
a model to rewrite its own authority, qualifications, instructions, routing or
acceptance policy.

## Design rule

Automatic evidence accumulation is allowed. Automatic promotion of authority
or worker-visible instructions is forbidden.

The trusted host may derive a candidate from already-retained, sanitized
evidence. A candidate is not active knowledge and cannot affect planning,
execution, review, routing or publication until a separate approval and
activation flow succeeds.

## Evidence boundary

Candidate generation may consume only normalized references to retained
artifacts, including:

- deterministic validation failures and accepted validation results;
- independent-review findings and event-bound repair decisions;
- repair, retry and escalation outcomes;
- false acceptance and post-acceptance defect evidence;
- human intervention categories and measured operational cost; and
- repeated successful patterns backed by exact commits and validations.

Raw prompts, hidden reasoning, complete transcripts, source-code bodies,
credentials, secrets and unrestricted tool output are not learning records.
Evidence references must retain their original run, manifest, repository,
base revision, policy and binding identities. Missing or conflicting
provenance fails closed.

## Proposed `LearningCandidateV1`

The first implementation should define a canonical, self-hashed artifact with
at least:

- candidate and schema identity;
- source run IDs and evidence hashes;
- repository-independent task classes and an optional stack fingerprint;
- a bounded observation and recurrence count;
- the proposed output kind;
- producer identity and creation time;
- lifecycle status and status-event hashes; and
- supersession, expiry and revocation metadata.

Allowed output kinds should initially be:

- `REGRESSION_TEST`;
- `VALIDATOR`;
- `DOC_ONLY`; and
- `PRACTICE_PACK_PATCH`.

Prefer an executable regression test or deterministic validator whenever the
lesson can be expressed mechanically. Documentation is appropriate for
contextual knowledge. A practice-pack patch is the highest-risk output because
it changes worker-visible guidance and therefore requires the strongest review.

## Lifecycle and authority

The minimum lifecycle is:

```text
CANDIDATE -> VALIDATED -> APPROVED -> ACTIVE
     |            |          |          |
     +------------+----------+----------+-> REJECTED
                                      \----> SUPERSEDED
                                      \----> REVOKED
```

Transitions are append-only, event-bound and independently attributable. The
candidate producer cannot validate or approve its own proposal. Validation
must check the cited evidence, applicability, duplicates, contradictions and
whether a narrower mechanical guard is possible. Approval remains an external
operator or separately qualified authority decision.

Activation grants no runtime, filesystem, network, credential, routing,
publication or deployment authority. Repository content can only constrain
work within authority already granted by policy and the certified host.

## Activation and qualification

`DOC_ONLY` material may remain searchable without entering a worker instruction
bundle. A promoted test or validator becomes active only through the normal
repository change and review path.

A promoted practice-pack or repository-instruction change creates new content
bytes and a new `instruction_bundle_hash`. The prior worker capability,
qualification evidence and story plans are stale by construction. The changed
binding must be activated and qualified again before execution; retaining the
old capability hash is an integrity failure.

No learning may be activated between ordinals of a frozen dogfood manifest.
Discoveries made during Dogfood V1 are retained as evidence and processed only
after that experiment is closed.

## Bounded retrieval

Future retrieval must be deterministic, allowlisted and bounded by task class,
stack evidence, repository policy and worker capability. It should return only
the small number of most relevant active items that fit the story context
budget. It must not inject an ever-growing memory file or fetch new guidance
during execution.

Retrieval output must record the exact candidate revisions and ordered content
hashes used to construct the instruction bundle. Ambiguous ranking, stale
content or a context-budget overflow fails closed or omits the optional
learning; it never silently changes the binding.

## Refresh, supersession and revocation

Active knowledge must be rechecked when referenced paths, APIs, validations,
stack fingerprints or policy identities change. Refresh produces a new
candidate; it does not mutate an active artifact in place. Contradicted or
unsafe guidance is revoked immediately and retained for audit. Duplicate or
more general learnings are linked through explicit supersession.

## Delivery slices after Dogfood V1

1. Analyze the retained pilot corpus and enumerate real evidence shapes before
   freezing a schema.
2. Add the candidate schema, canonical hashing, append-only lifecycle events
   and adversarial contract tests, disabled by default.
3. Add a deterministic reducer that emits candidates but cannot activate them.
4. Add independent validation and approval adapters with separation-of-duty
   tests.
5. Enable `REGRESSION_TEST`, `VALIDATOR` and `DOC_ONLY` promotion through normal
   reviewed repository changes.
6. Add bounded retrieval and `PRACTICE_PACK_PATCH` only after requalification,
   stale-content and rollback behavior are certified.

Each slice is a separate reviewable change. Routing promotion, publication and
authority expansion remain outside this design.

## Readiness gates

Implementation is not ready for activation until tests prove that:

- a candidate cannot affect a run before approval and activation;
- one actor cannot produce, validate and approve the same candidate;
- every claim is traceable to retained evidence and the exact experiment;
- secrets, raw prompts and hidden reasoning cannot enter the candidate store;
- changed worker-visible content invalidates prior capability evidence;
- retrieval is deterministic, bounded and reproducible;
- expiry, supersession and revocation remove content from future bundles; and
- crash recovery cannot duplicate transitions or reactivate revoked content.

