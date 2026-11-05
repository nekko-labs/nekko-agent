---
status: accepted
date: 2026-11-05
---

# 0051. One macOS Keychain item per profile

Amends the macOS item layout and test policy of [0046](0046-secrets-live-in-the-os-keystore.md). The OS keystore boundary, settings format, backups, Windows layout and Linux fallback stay unchanged.

## Context

Each provider key was its own Keychain item. Long sign-in tokens were split into multiple items to accommodate Windows Credential Manager's size limit. On macOS, a daemon with a different signing identity could consequently request a separate approval for every key and token chunk. The machine-oriented service name did not explain the purpose. See issue #1749 and [the specification](../../spec/models/models-providers.md#consolidated-macos-keychain-access-issue-1749).

## Decision

Store all macOS vault namespaces for a data profile as one JSON map in one Keychain generic-password item. Its name is `Nekko Agent: API keys, sign-ins and encryption keys (<profile hash>)`, with account `Nekko Agent credentials`. The name is also the persistent service identifier; changing it needs a migration. Keep namespaces and existing token chunk names inside the map, not as separate Keychain items. No credential moves to a local file.

All vault handles for a profile share one process-lifetime cache and mutex. `nekkod` already holds an exclusive per-data-directory process lock, so it remains the single writer. Read-only startup callers share the first Keychain read, including an access failure. A restart is required to retry denied or unavailable access. A credential change writes and verifies the complete replacement before changing the cache. A write or readback failure stops further writes for that process, preventing stale-snapshot overwrites.

Read legacy entries lazily, retaining each original until the consolidated item reads back unchanged. Delete old entries by their attributes, without keyring's extra password read. Cache legacy misses and failures. If one legacy access is refused, stop scanning other legacy entries until restart. Persist deletion tombstones so an old item whose deletion failed cannot resurrect a removed credential.

## Alternatives and consequences

- Caching per-secret entries alone would not remove separate approvals after an update or restart.
- An encrypted local file with one Keychain wrapping key would add a file format and key lifecycle without improving this trust boundary. macOS can hold the aggregate directly.
- Apple controls access to each old item. Migration may still ask for each original once; the application cannot merge those existing grants or guarantee a single dialog for the upgrade. Later read-only starts use the consolidated item. Writes may still require system authorization.
- Cached credentials stay available in the daemon's memory, as provider and sign-in stores already require. Manual Keychain edits take effect after restarting the daemon. Concurrent external writers and downgrades are unsupported; an older build cannot read the consolidated format.
- Default tests use fake/file stores. One explicitly invoked macOS test may create uniquely named synthetic items in the login Keychain, with Security framework user interaction disabled in that test process and cleanup on scope exit. It never reads an existing user credential, changes the default keychain, or displays a consent dialog.
- Unit tests verify one shared read for 15 concurrent credential consumers and error handling. The native test verifies migration, long tokens and deletion. The visible system dialog, its exact macOS-dependent wording, and signed-release upgrade authorization remain unverified.
