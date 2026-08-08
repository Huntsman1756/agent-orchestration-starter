# Repository agent contract

Keep stable policy provider- and model-agnostic. Concrete provider identifiers and model names belong only in `profiles/*.yaml`.

The orchestrator plans and delegates but remains read-only. The executor receives bounded work contracts and may write only within the allowed files. The reviewer is independent from the executor and remains read-only.

Run `npm run validate` before claiming completion. Deterministic failures are authoritative and cannot be overruled by model judgment.

Generated harness files are managed by `.agent-orchestration/inventory.json`. Never overwrite unmanaged or locally modified files without an explicit exact-path `--force`.
