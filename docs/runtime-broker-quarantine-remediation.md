# Runtime V4 offline quarantine remediation

## Linux broker socket quarantine (fixed-slot format)

The V4 Linux broker never performs a metadata-check followed by a pathname `unlink`. An owned `broker.sock` is retained inside one of exactly 64 accepted owner-only directories:

```text
.broker.sock.quarantine-slot-00
...
.broker.sock.quarantine-slot-63
```

Each slot is empty or contains exactly one owner-only Unix socket named `broker.sock`. Empty directories are reusable reservations. An occupied directory consumes one of the 64 retained-socket positions. The broker never creates a name outside this closed set and never deletes a retained object automatically.

Names from the earlier `.broker.sock.quarantine-<pid>-<hex>` layout are no longer accepted online. Any such entry, any other `.broker.sock.quarantine-*` name, a direct socket at a slot name, or malformed slot contents makes startup fail closed.

## When remediation is required

Remediate only when startup reports exhausted quarantine capacity or rejects malformed quarantine state. Do not raise or bypass the 64-slot production limit. A symlink, alias, ownership/mode error, duplicate inode, endpoint hard link, unexpected name, or changing inventory is a security event; preserve it for investigation unless the complete offline procedure below succeeds.

## Offline-only procedure

1. Stop the broker. Disable every launcher and service manager, and prevent every process running as the broker UID from accessing the state directory. Confirm that no broker or client is using `broker.sock`. If exclusive same-UID control cannot be established, stop and remove nothing.
2. Walk every state-directory path component without following links. Root-owned components and broker-owned components must not be group/world writable. The final directory must be owned by the broker UID and mode `0700`. Stop on a symlink, unexpected mount/alias, unknown metadata, ownership mismatch, or writable parent.
3. Inventory `broker.sock`, all 64 fixed slot names, and every name beginning `.broker.sock.quarantine-` without following links. A fixed slot may only be an owner-only directory that is empty or contains exactly one owner-only Unix socket named `broker.sock`; every observed socket must report `nlink = 1`.
4. Record device/inode identities and link counts, then repeat the inventory. Stop if metadata changed, any socket has a link count other than one, two retained sockets share an identity, a retained socket shares the current endpoint identity, or any fixed slot/child is linked through another name.
5. Treat old dynamic quarantine names and all malformed entries as evidence. Remove one only if its complete no-follow metadata and physical identity have been independently established, it is not live, and the broker remains offline under exclusive UID control.
6. Under the same exclusive control, manually remove only exact socket identities that passed both inventories. Remove a slot's `broker.sock` child first, then its now-empty directory if desired. Revalidate immediately before each removal. Never use recursive deletion, globs, link-following tools, or an automated scan-then-delete loop.
7. Leave the current `broker.sock`, non-quarantine names, and every unverifiable object untouched. Restart only after the inventory is stable and at least one fixed slot is empty or absent. Startup performs the authoritative capability-bound validation.

This procedure is safe only while the broker is stopped and the operator has exclusive control of the broker UID and physical state directory for the whole validation/removal interval. Runtime cleanup deliberately does not assume that control.

## Native package cleanup holders

The native package builder uses `.agent-orchestration-native-clean` only as a process-local cleanup namespace. A successful invocation creates that namespace itself, records its physical device/inode identity in memory, creates each `holder-<6 alphanumeric>` reaper itself, binds the reaper and detached source to their recorded device/inode identities, removes only that reaper in the same process, and removes the empty namespace before continuing.

Any cleanup namespace that exists when a later invocation starts is inherited state, including an empty namespace and a syntactically valid `holder-*/detached` tree. The builder fails closed before moving or deleting anything, before TypeScript compilation, and before packaging. It never adopts, recovers, or recursively removes an inherited current holder. A crash, killed process, failed identity reproof, or hostile substitution therefore requires offline manual remediation.

Legacy `dist/.native-clean-<6 alphanumeric>` holders are different only because they are inside the package allowlist. When no current cleanup namespace exists, the invocation may validate a legacy holder, move it into a fresh process-local reaper, and complete identity-bound removal during that same invocation. If it cannot complete, the current namespace remains as a durable blocker; every future invocation preserves it and fails without a tarball.

### Native-holder offline-only procedure

1. Stop every `npm pack`, `prepack`, TypeScript build, native-helper build, watcher, CI job, and service that can access the checkout. Establish exclusive control of the repository owner account and the physical project directory for the entire procedure. If another same-UID process can modify the tree, stop and remove nothing.
2. Walk the project-root path and every existing parent component without following links. Reject symlinks, junctions/reparse aliases, unexpected mounts, ownership changes, group/world-writable untrusted parents, or any component whose stable physical identity cannot be established.
3. Inspect `.agent-orchestration-native-clean`, every name below it, `dist`, and every `dist/.native-clean-*` name with no-follow metadata. Treat an unknown name, unexpected child, symlink, non-directory, cross-filesystem object, or layout other than an empty `holder-<6 alphanumeric>` or one physical `holder-<6 alphanumeric>/detached` directory as security evidence, not recoverable runtime state.
4. Record device/inode identities, ownership, modes, and the complete no-follow inventory. Repeat the inventory while exclusive control remains in force. Stop if any identity, name, link relationship, or content changes; do not infer provenance from a valid-looking name.
5. Prefer preserving the complete inherited namespace for investigation. To unblock a trusted checkout, atomically rename the exact validated namespace, with no replacement, into a prevalidated owner-only quarantine directory outside the repository on the same filesystem. Immediately reprove that the moved namespace has the recorded device/inode and that the original pathname is absent. If either proof fails, do not delete, restore, or overwrite either pathname; retain the moved object and stop.
6. Remove quarantined contents only with offline descriptor-relative, no-follow tooling while exclusive control remains in force and only after an independent provenance review. Never use recursive pathname deletion, globs, a scan-then-delete loop, or the package builder itself as remediation. Legacy holders must meet the same identity and provenance requirements before any manual move or removal.
7. Restart packaging only when `.agent-orchestration-native-clean` is absent, the `dist` inventory is stable, and every remaining legacy cleanup name has been independently resolved. The next builder invocation creates a new namespace and is the authoritative online check.

This policy intentionally prefers a durable packaging outage over deleting an object inherited from another process. The package lifecycle has no online override or force-recovery mode.
