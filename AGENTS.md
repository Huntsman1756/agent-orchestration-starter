# Repository agent contract

Keep stable policy provider- and model-agnostic. Concrete provider identifiers and model names belong only in `profiles/*.yaml`.

The orchestrator plans and delegates but remains read-only. The executor receives bounded work contracts and may write only within the allowed files. The reviewer is independent from the executor and remains read-only.

Run `npm run validate` before claiming completion. Deterministic failures are authoritative and cannot be overruled by model judgment.

Generated harness files are managed by `.agent-orchestration/inventory.json`. Never overwrite unmanaged or locally modified files without an explicit exact-path `--force`.

## Strict SDD and review boundaries

- The Planner generates and freezes acceptance tests before requesting an
  implementation. They are recorded in the Work Contract's
  `acceptance_tests` matrix.
- The Executor receives read access to the bounded capability snapshot but
  write access only to the Work Contract's `implementation_targets`. It must
  never edit, delete, rename or recreate an acceptance-test path.
- The broker's diff interceptor is authoritative. Any Economy diff that
  touches an acceptance test is rejected as
  `ECONOMY_POLICY_VIOLATION` and routed through the bounded Repair Packet.
- The Frontier Reviewer is independent and read-only. It evaluates only the
  hash-bound Review Packet and never modifies repository files.
- Deterministic tests, lint, format, typecheck, build and security gates are
  authoritative. A model cannot waive a failure, and an `APPROVED` verdict
  cannot bypass validation or finalize/publication on its own.
