---
title: "Limits on what grows in the data folder"
area: platform
---

# Limits on what grows in the data folder (2026-10-24)

`[implemented; unit-tested (command log tail, quota-history pruning, stale download sweep); not yet run against a long-lived profile]`

**User intent:** Nekko Agent should not slowly fill the disk with logs and leftovers nobody reads ([#1035](https://github.com/nekko-labs/nekko-agent/issues/1035)).

| Record (in the data folder) | Limit |
| --- | --- |
| `logs/app.log`, `logs/nekkod.log` | Rotate at 5 MB, 3 older files kept (already so). |
| `logs/connections.log` | Rotates at 2 MB, 2 older files kept ([Connections](connections-switch-and-activity-log.md)). |
| `sessions/<id>.commands.log` | Past 5 MB, cut back to its last 4 MB of whole lines. Deleted with its chat. |
| `quota-history.jsonl` | Lines older than 30 days are dropped at startup. Nothing in the app reads it back. |
| Model downloads left as `<file>.part` | Removed at startup once untouched for 7 days. The download queue does not survive a restart, so only downloading the same file again would have resumed one. Finished models are never touched. |
| `sandboxes/<id>/` | Not capped: it holds only the sandbox's small manifest, kept as a record after the container and volume are removed. |

Left as they are on purpose:
- `usage.jsonl` and `replies.jsonl` feed Budget and the usage views; Clear usage removes them.
- Chats are the user's data.
- Chromium's caches follow Chromium's own limits.

A Storage card that shows each bucket's size with clear buttons is a possible follow-up.
