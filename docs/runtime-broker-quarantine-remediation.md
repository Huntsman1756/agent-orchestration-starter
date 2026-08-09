# Linux broker quarantine remediation

The V4 broker retains Unix-domain socket objects instead of deleting a pathname after a separate identity check. Each retained object consumes one top-level quarantine slot in the broker state directory. Production admits at most 64 entries whose names match `.broker.sock.quarantine-<pid>-<32 lowercase hex characters>`.

An empty owner-only quarantine directory is intentional safe debris from a reservation that failed closed before endpoint mutation. A populated reservation contains only `broker.sock`. Older deployments can also leave a socket directly at the quarantine name. The broker validates all of these entries, their ownership and modes, their physical identities, and their relationship to the current endpoint before listening or cleaning up. It does not delete them automatically.

## When remediation is required

Remediate only after startup reports that broker quarantine capacity is exhausted. Do not raise or bypass the 64-entry production limit. A malformed, aliased, incorrectly owned, duplicate, or endpoint-linked quarantine is a security failure, not ordinary capacity pressure; preserve the directory for investigation.

## Offline-only procedure

1. Stop the broker and prevent every launcher, service manager, and same-UID process from accessing the state directory. Confirm that no broker process or client is using `broker.sock`. If exclusive control over same-UID processes cannot be established, stop and do not remove anything.
2. Validate every component of the state-directory path without following symbolic links. The final state directory must be owned by the broker UID and accessible only to that owner. Any symlink, unexpected mount or alias, ownership mismatch, or writable parent is grounds to stop.
3. Inventory every matching quarantine entry without following links. Accept only:
   - an owner-only Unix socket at the quarantine name (legacy layout), or
   - an owner-only directory that is empty, or contains exactly one owner-only Unix socket named `broker.sock`.
4. Record device/inode identities. Reject the inventory if two retained sockets have the same identity, if a retained socket has the same identity as the current `broker.sock`, or if metadata changes during inspection.
5. Under continued exclusive offline control, manually remove only entries that passed the complete inventory. For a reservation, remove its `broker.sock` child first when present and then remove the now-empty directory. For a legacy entry, remove only the validated socket. Revalidate the exact identity immediately before each removal. Never use recursive deletion, globs, link-following tools, or an automated scan-then-delete loop.
6. Leave the current `broker.sock`, nonmatching names, malformed entries, and anything whose identity cannot be revalidated untouched. Escalate those objects for security review.
7. Restart only after the retained quarantine count is below 64. Startup will perform the authoritative capability-bound validation and fail closed if the directory is still unsafe.

This maintenance procedure is safe only because the broker is stopped and the operator has exclusive control of the broker UID and state directory for the entire validation-and-removal interval. Normal runtime cleanup deliberately does not make that assumption.
