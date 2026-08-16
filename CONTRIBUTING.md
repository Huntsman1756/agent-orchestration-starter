# Contributing

## Development contract

Keep repository policy provider- and model-neutral. Concrete providers and
model names belong in dated profile examples and qualification records. Do not
turn model output, issue text or test fixtures into authority.

Before publishing any branch, issue or pull request, follow the
[public repository hygiene guide](docs/public-repository-hygiene.md). Replace
personal paths and identities with placeholders, keep logs bounded, and use a
private security advisory for sensitive reproductions.

Start from a clean branch and keep changes small enough to review. Before
opening a pull request, run:

```text
npm ci
npm run validate
```

For changes to host installation, process isolation, credential handling, IPC,
publication or schemas, also run the applicable certification workflow with an
immutable host/image binding. A platform-specific pass is evidence only for
that exact OS, Node major, harness, host driver, component set and policy.

## Pull requests

Describe the invariant changed, the trust boundary affected, the exact
qualification assumptions and any migration needed for profiles, schemas or
public exports. Do not include prompts, model responses, credentials, private
source or unbounded logs in commits or telemetry fixtures.

Breaking changes to the default package API or a contract require a changelog
entry and an update to the compatibility matrix. Host-driver changes require
fresh component and composition certification evidence.

## Release packaging

Release tarballs are built by the tag workflow on certified Linux x64. The
native broker helper is not cross-compiled from Windows or macOS; `npm pack`
on those hosts fails closed so a package cannot omit the helper while looking
complete. Use the release workflow for official artifacts and verify its
checksum, SBOM and provenance before distribution.
