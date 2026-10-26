---
title: "Completed chat retention and storage controls"
area: chat
---

# Completed chat retention and storage controls

## Intent

Completing a chat tidies the agent list, not its saved history. Completed rows and messages remain readable and restorable until the user explicitly deletes them. This replaces the former 60-day expiry, including for already-completed chats. Already-deleted history cannot be recovered by this change.

## Implemented

- The daemon's legacy expired-archive purge is a compatibility no-op; the renderer no longer runs a deletion sweep. Idle auto-completion remains reversible and does not delete history.
- Completed rows and read-only readers say that history is kept until deleted, with no expiry countdown or urgency styling. Individual permanent deletion is unchanged.
- The daemon exposes local history usage and explicit range cleanup. Usage counts all regular session JSON and command-log bytes, including active chats and valid orphaned logs, without following symlinks. The accompanying count is completed chats only. This is chat-owned storage, not the entire app data directory, model downloads, caches or project files.
- Cleanup selects completed chats by last activity (`updatedAt`). Today starts at the host's local midnight; last week is the past seven days; older than two weeks is strictly older than 14 days; older than one/six months uses calendar-month subtraction in the host's local timezone. Active, running and admitting chats are protected. Malformed/missing activity timestamps are retained. Command-log cleanup happens before deleting conversation JSON; a cleanup failure retains that conversation.

## Planned next layer

Settings → General → Chat history will show storage usage, warn at 1 GB (1,000,000,000 bytes), offer the five cleanup ranges with an explicit irreversible-deletion confirmation, and link to the existing Nekko Cloud sync section. Sync is not automatic local offloading and must not be presented as freeing local bytes.

## Verification and boundaries

Backend store, daemon endpoint, shared and remote-channel tests cover retention, deletion boundaries, DST/month behavior, protected turns and symlink exclusion. The shared desktop/Local Web UI reader has matched hidden renderer before/after evidence. No new permissions, telemetry, automatic upload or account sign-in; cloud sync remains separately opt-in. Native mobile settings are not changed. Packaged desktop and native mobile verification remain outside this change.

Tracked in [#1156](https://github.com/nekko-labs/nekko-agent/issues/1156).
