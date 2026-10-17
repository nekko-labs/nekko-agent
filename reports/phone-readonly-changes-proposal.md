# Proposal: read-only "Changes" on the phones

Status: **built, off by default** (2026-10-17, TASKS IO-9). It was built while the owner was away, so it still needs the owner's sign-off before the switch is turned on anywhere. What shipped differs from the proposal below in these ways:

- It reuses **`changes:list`** with a projection (`phoneChangesView` in `packages/shared/src/phone-changes.ts`, `phone_changes.rs` in the daemon), not a new `changes:phoneView` channel. The phone never receives whole file contents, only the capped hunks.
- Paths are the **last two segments** (`…/src/app.ts`) rather than relative to the workspace, since a change records only the absolute path.
- It's off unless **Settings → Remote access → Let phones see changes** is on (`phoneChanges`, which a phone can't set). With it off, the computer refuses the call.
- The phone learns the switch from `settings:get` (`phoneChanges`), not `app:info`.
- Any chat id is accepted, as `session:get` already accepts any. Restricting it to the chats `sessions:summaries` lists is not built.

Both phone screens are built: a Changes sheet from the chat's More menu on iOS, and a Changes button in the chat's top bar on Android. Each appears only when the computer allows it. The decisions below are taken as proposed, except that only `changes:accept`, `changes:acceptAll`, `file:read` and `dir:list` were added to `PHONE_ALWAYS_DENIED`. File writes and terminals were already there.

## Why

The biggest gap with Orca and Codex on the phone is seeing **what the agent changed**. Both show diffs from the phone. Nekko's phones can follow a chat, approve tools and answer questions, but can't see the edits those tools made (see [ios-native-competitive-2026-10-16.md](ios-native-competitive-2026-10-16.md)). Files and terminals are listed as "a security decision for the owner", and so is this.

## What it would be

A **Changes** sheet in a chat, on iPhone and Android. It lists the files the agent changed in this chat with `+added −removed`. Tapping a file shows a unified diff, read only. There are no Accept, Revert or edit buttons, no file browser and no terminal.

## The narrowest version that closes the gap

| | Proposal |
| --- | --- |
| **Channel** | One new phone channel, **`changes:phoneView(sessionId)`**: a projection the computer computes, not the existing `changes:list` (which returns whole before/after file contents). |
| **What it returns** | Per file: the path *relative to the chat's workspace folder*, `added`, `removed`, and unified-diff hunks computed on the computer. |
| **Limits** (in `PHONE_SESSION_VIEW` style, as constants) | At most 50 files. At most 400 diff lines and 64 KB per file. At most 512 KB total. Past a limit a file reads "Too large to show on a phone (N lines)", and is not cut mid-hunk. |
| **Which chats** | Only the chats the phone already lists (`sessions:summaries`). Any other session id is refused the same way an unknown channel is. |
| **Hidden files** | Files matching secret patterns are listed with their counts but no content ("may contain secrets"): `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `*.keystore`, `.npmrc`, `.netrc`, and anything under `.ssh/` or `.aws/`. |
| **Paths** | Never absolute. A file outside the workspace shows as `…/<name>`. |
| **Still refused** | `changes:accept`, `changes:acceptAll`, `file:read`, `file:write`, `terminal:*`, `terminals:*`. They are added to `PHONE_ALWAYS_DENIED` explicitly (`changes:accept*` aren't there today), so a later allowlist edit can't let them through. |
| **Off switch** | *Settings → Remote access → Let phones see changes* on the computer, **off by default**. With it off the channel is refused, and the phone hides the sheet (it learns this from `app:info`). |

## Where the code would go

- **Shared:** `packages/shared/src/phone-access.ts`: the channel, the limits, the secret patterns, and `phoneChanges(changes, workspace)` (a pure function, unit-tested).
- **TS host:** `packages/host/src/relay.ts` routes the channel through `phoneChanges`, gated by the setting.
- **Rust daemon:** `crates/nekko-remote/src/phone.rs`, held to the TS projection by the existing goldens (`tests/golden/phone.json` and a new `phone-changes.json`).
- **iOS:** `Wire.swift` decoder, `ChatModel.changes()`, and a `ChangesSheet` reached from the chat's More menu.
- **Android:** `Wire.kt`, `ChatController`, and a `ChangesScreen`.
- **Tests:**
  - shared: limits, secret patterns, relative paths, refusal of other sessions;
  - goldens for TS↔Rust parity;
  - Swift and Kotlin decoders;
  - the live journeys (iOS simulator, Android emulator): the fake model edits a file, the phone shows the diff, and `changes:accept` from the phone is refused.

## Risks, honestly

- **A diff can still contain a secret** that doesn't match a pattern (a token pasted into source code). The setting being off by default, plus the end-to-end encryption, is the mitigation. A phone that can see diffs should be treated like a laptop that can.
- **A lost, unlocked phone** could read recent changes. The app lock (on by default) and revoking the phone on the computer cover this, as they do for chats today.
- **Scope creep:** a file browser or terminal would be a separate decision. This proposal stops at changes the agent made in a chat the phone already sees.

## The decision needed

1. **Yes or no** to `changes:phoneView` as described, off by default behind the setting.
2. **The limits:** 50 files, 400 lines or 64 KB per file, 512 KB total. Keep them or adjust.
3. **The secret patterns** above: keep, add or remove.

With a yes, the work is one PR across shared, TS host, Rust daemon, iOS and Android, each with its own tests.
