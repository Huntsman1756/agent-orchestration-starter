# Runtime V4 compatibility matrix

This matrix is a release and activation aid, not a claim that every cell is
qualified. A row is usable only when its exact host, driver, component set,
harness, provider/model binding, policy and evidence hashes match.

| Runtime release   | Schema family                                           | Host/driver status                                                                                                 | Provider/model status                                               | Publication status                                                                 |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `0.3.x`           | Runtime V4 schema `4`; pilot V3 schemas remain separate | Framework and installer tested; no universal production driver shipped                                             | Profiles are examples until exact binding qualification is recorded | GitHub adapter is tested; unattended publication still requires host qualification |
| `0.3.x` Linux x64 | V4 schema `4`                                           | Native broker helper is the currently certified target family; certify the exact host driver/components separately | Requalify every model, provider, harness/parser and guidance change | Requires exact policy, repository activation and post-merge evidence               |
| `0.3.x` Windows   | V4 schema `4`                                           | CI/platform behavior is exercised; native Linux broker evidence does not transfer                                  | Requalify the exact Windows driver/coordinator/sandbox combination  | No automatic production qualification implied                                      |
| `0.3.x` macOS     | V4 schema `4`                                           | Separate host, filesystem and coordinator evidence required                                                        | Requalify the exact macOS combination                               | No automatic production qualification implied                                      |

Official npm tarballs are produced on certified Linux x64 because they contain
the pinned Linux native broker helper. Windows and macOS may consume a release
for portable JavaScript surfaces where their own host evidence permits it, but
they must not be treated as release-build hosts for the native artifact.

## Qualification identity

The qualification unit is:

```text
runtime release + schema + OS/architecture + Node major
+ host root + component revisions/certificates + native coordinator
+ sandbox backend/image + harness/parser + provider/model deployment
+ guidance/tool/skill bundle + repository policy/profile + target
```

Changing only a model/profile does not require reinstalling unchanged host
bytes, but it does require a new activation binding and fresh qualification of
the exact combination. Changing a host byte, component, native helper,
coordinator, sandbox or composition certificate requires dependency-aware
recertification and a new installation identity.

`broker_version` in broker-owned qualification evidence is the package version
with the Runtime schema suffix (for example `0.3.1-v4`). It is centralized in
the runtime and covered by a package-version parity test. A package version
change therefore creates a new broker identity and invalidates prior sandbox
qualification evidence unless an explicit future compatibility policy says
otherwise.

## Evidence states

- `framework-tested`: automated contract and unit coverage exists.
- `platform-tested`: the relevant OS/Node matrix passed.
- `host-qualified`: the exact privileged host and component composition passed
  certification.
- `binding-qualified`: the exact provider/model/harness/policy/guidance/tool
  binding passed its capability and hostile behavior probes.
- `production-eligible`: all preceding states exist for the repository target,
  with operator-approved credential and publication controls.

No state may be inferred from a skipped test, a model name, a provider label,
or a successful run on another operating system.
