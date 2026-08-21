# Runtime V4 activation readiness

`assessRuntimeActivationV4` turns repository-independent activation prerequisites into a deterministic, content-addressed report. It consumes a validated repository policy, a replaceable runtime profile and broker-owned host evidence. It never scans a repository for project names, frameworks, databases or deployment conventions.

The three targets are deliberately different:

- `ANALYSIS_ONLY` compiles and evaluates configuration without authorizing model execution or publication. Missing host evidence is a warning.
- `ISOLATED_EXECUTION` requires the complete certified execution host and requires publication to be disabled.
- `AUTONOMOUS_PUBLICATION` additionally requires publication to be enabled and a verified GitHub publication lease.

The report detects whether the configured source sensitivity is supported by the core roles and by the economy and frontier execution paths. It also emits `DELEGATION_TOPOLOGY`: frontier planning/review must be read-only, economy execution must be contract-write and the direct frontier fallback must be contract-write. An `AUTO` request may use economy when its executor and escalation executor are compatible; otherwise it may elevate to a compatible frontier executor. Explicit `ECONOMY` requests still fail when economy cannot process the source. Source is never reclassified from `PRIVATE` to `PUBLIC`.

Run `runtime doctor --repository-policy <path> --profile <path>` before host
activation. This built-in preflight does not need a host driver. It lists exact
provider/model/harness identities, declared task traits and route-collapse
reasons. It deliberately reports configuration only; host certification and
fresh capability qualification remain separate evidence.

Host evidence is closed and hash-addressed: native composition, immutable bundle, credential isolation, provider gateway compatibility, exact capability qualification and Docker certification. A forged boolean is not evidence. The evaluator accepts a check as verified only with a 64-character evidence hash; the host verifier remains responsible for producing and retaining the referenced artifact.

The concrete V3 telemetry adapter remains a warning rather than an execution blocker because telemetry cannot alter a live safety gate. This makes incomplete measurement visible without pretending it is equivalent to missing credential isolation or sandbox certification.

The public output schema is `contracts/runtime-activation-readiness-v4.schema.json`.
