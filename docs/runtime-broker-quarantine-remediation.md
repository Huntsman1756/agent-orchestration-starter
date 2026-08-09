# Linux broker quarantine remediation (V4 fixed-slot format)

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
