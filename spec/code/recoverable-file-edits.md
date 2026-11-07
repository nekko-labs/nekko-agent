---
title: "Recoverable native file edits"
area: code
---

# Recoverable native file edits

## User intent

Before beta, compare established coding/personal agents and implement the most valuable verified gaps. The [2026-11-11 investigation](../../reports/beta-readiness-2026-11-11.md) selects dependable file review and validated batch editing, rather than claiming broad workspace checkpoint parity.

## Implemented, verification recorded in the report

### Durable review originals

- The daemon's native `write_file` / `edit_file` capture the first original per path in a saved chat before mutation. `<data>/changes/<chat-id>.json` persists that original across daemon restart; subsequent edits preserve the first original until accepted.
- Reopening Review Changes reads current disk contents and compares them with that original. Accept one/all removes the relevant persisted originals, not the source files. No renderer layout changes.
- Incognito originals remain memory-only. Enabling incognito deletes the saved sidecar. Privacy changes and snapshot operations use the session store's existing lifecycle lock, shared with single deletion, bulk deletion and cloud tombstones. Deleted chats cannot create new snapshots; cached originals are not resurrected after deletion/privacy changes.
- A failed session-privacy read, corrupt/unknown snapshot, or failed durable snapshot save fails closed before mutation. No silent downgrade to in-memory recovery. Explicit accept-all can discard an unreadable snapshot if the chat privacy state is readable; chat deletion does not need to decode the snapshot.
- Persistence is bounded to 512 tracked paths and 64 MiB of serialized originals per chat. Reaching the limit returns an actionable tool error; review and accept changes before editing more. Source files over 64 MiB fail before capture. Limits are not a total profile quota.
- The sidecar uses the existing atomic file writer, with owner-only mode on Unix; Windows uses inherited profile ACLs. Sidecars are local data, not added to chat sync. Originals may contain secrets and are not encrypted by this feature. Full data wipe removes orphaned sidecars too.
- Snapshot work runs on a blocking worker, with per-chat tracker locking rather than blocking unrelated chats behind a global snapshot rewrite. Chat metadata is decoded in a stream without allocating transcript content. There is no measured performance claim.

### Validated batches on `edit_file`

- Additive input: `{path, edits: [{old_string, new_string}, ...]}`. The original single-pair form remains supported; missing single `new_string` now errors rather than inserting `undefined`.
- A batch contains 1–100 ordered replacements. Each search is a non-empty string with one non-overlapping match **at its step**, so later edits may match earlier edits' output. Replacements are literal, including dollar sequences. Empty replacement text is allowed.
- All replacements validate in memory before any snapshot or write. An invalid, ambiguous, malformed, oversized or mixed-form batch leaves disk and tracking unchanged. Input text, cumulative replacement strings and result each have an 8 MiB limit.
- It is still `edit_file`: existing disabled-tool/workflow categories, approval rules, project jail, read-only roots, Git configuration guards and hooks apply. The Docker helper implements the same batch contract inside the existing copied-workspace boundary.
- Native single-pair JavaScript replacement/coercion compatibility is otherwise retained. The schema describes both forms; runtime rejects mixed inputs and missing replacement text.

## Acceptance

- Restart a tracker against the same saved profile and recover the exact original text plus current contents; accept and recreate it without resurrecting accepted originals.
- Incognito, missing/invalid IDs, metadata failure, corrupt sidecar and snapshot write failure cannot create unintended durable originals or mutate the source after a recovery error.
- Deterministically hold a snapshot write while deletion or enabling incognito waits; once the lifecycle action completes there is no sidecar. Cloud deletion uses this same store path.
- Delete, clear and completed-history deletion remove snapshots; the existing archived-retention purge no-op remains a no-op. Data wipe removes orphaned snapshots.
- Valid Unicode/CRLF/dependent/literal batches succeed; later failure, malformed forms, ambiguity, size/count limits, approval denial, jail/read-only/Git guards leave source unchanged.
- Execute the actual Python helper on Unix CI as well as native Rust tests. Windows native tests do not prove Docker execution or Unix permissions.

## Verification record (2026-11-08 JST)

- Windows: `cargo test -p nekko-tools -p nekko-store -p nekko-turn -p nekko-sandbox -p nekkod --locked`: 635 passed, zero failed, two existing real-model tests ignored (live llama-server round trip and injection evaluation).
- A freshly built worktree daemon passed all five journeys in `node scripts/itest-file-recovery.mjs`: actual restart recovery, acceptance, incognito transition/restart, deletion/recreation rejection, and corrupt snapshot error/explicit discard. Each run uses a disposable data directory and home, no configured provider, and cleans up its processes/profile.
- Linux CI passed [the actual helper and owner-only permission assertions](https://github.com/nekko-labs/nekko-agent/actions/runs/42422037188/job/128552459962), and all five real-daemon journeys passed the loopback integration job. These checks remain required in the loopback integration and Linux daemon jobs (`deploy:linux`); Windows results do not substitute for Unix verification.
- No visual change. The actual daemon checks prove backend integration, not packaged desktop acceptance, provider schema acceptance or a physical-device journey. Those broader checks remain unverified.

## Boundaries / not implemented

This is not a backup system, a crash-safe source-file transaction, or comprehensive workspace checkpoints. Native text tools preserve originals; shell/MCP/external edits, binary-byte fidelity, created-file-versus-empty-file restoration, multi-file rollback, concurrent external writers and per-step checkpoint history remain outside scope. Claude Code has its own file tools and does not automatically gain native batch support. A physical-device mobile journey, full live-provider matrix and packaged-app acceptance are not implied by headless tests.
