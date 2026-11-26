---
status: accepted
date: 2026-11-26
---

# 0122. Bulk worktree cleanup includes worktrees agents made outside Nekko

## Context

On 2026-11-26 Philip's Mac was down to 14 GB free eleven days after a cleanup that freed 120 GB. 158 worktrees under `nekko-agent/.worktrees` held 180 GB, about three quarters of it build output. 156 of the repository's 169 worktrees were made by agents running `git worktree add`, as this repo's `AGENTS.md` tells them to. The merged-PR sweep in `crates/nekkod/src/worktrees.rs` only removes worktrees a chat made (`madeByChat`), so it never touched them. The new Settings → Storage page offers a bulk "Remove idle worktrees" ([spec](../../spec/desktop/storage-settings.md)).

## Options considered

1. **Chat-made worktrees only**, as the sweep does, plus a separate action that deletes build output inside any idle worktree. Safe, but frees about three quarters of the space and leaves the checkouts piling up.
2. **Every linked worktree of a configured project, behind an idle rule.** Clean, not locked, not running, no program's working directory inside it, no Git activity for 3 days, and every commit on a remote or in a merged PR. The branch is always kept.

## Decision

Option 2 (Philip, 2026-11-26). The bulk action is user-started, previews every worktree it would remove with why it is safe, lets each be unticked, re-checks each right before removal, and runs `git worktree remove` without `--force`. It never deletes a branch. The automatic merged-PR sweep is unchanged and still touches chat-made worktrees only.

## Consequences

- A worktree an agent made and left clean for 3 days can be removed even though Nekko did not make it. Its branch and every commit stay reachable, so the cost is a fresh checkout and rebuild.
- "Idle" is judged from Git's own metadata and running processes, not from walking every file, so measuring stays cheap. A program that edits ignored files only, with no working directory inside the worktree, for 3 days is not seen as activity.
- Single removal in Git management still deletes a merged branch, as before; the two actions differ on purpose and the preview says branches are kept.
