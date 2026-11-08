---
title: "Automatic title requests during queued turns (2026-10-13)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Automatic title requests during queued turns (2026-10-13)

Implemented, native macOS CI verification pending: automatic chat naming has one in-flight title request per session. A queued follow-up continues without waiting for that title request, but cannot start duplicate title work while it is pending. Failure, empty output or cancellation releases the claim so a later turn can try again. Eligibility is checked again after claiming; a user rename is never replaced by a pending automatic title result. Session-specific claims do not block naming in another chat. A held-response regression verifies queue progress before the title lands, plus failure/empty retry, cancellation and rename protection. This fixes the duplicate-request race exposed by macOS CI; it does not alter composer pixels or provider routing.

## Claude Code: in-turn naming (#2096)

Implemented and verified with focused local tests described below. Live Claude behavior and UI evidence are separate verification, not implied by the implementation.

Claude Code's print-mode turn does not supply a native automatic session title ([Claude Code session naming](https://code.claude.com/docs/en/sessions#name-your-sessions)). Keep naming inside the selected Claude Code turn, with no alternate provider or hidden extra turn:

- Offer `set_chat_title` on the chat's authenticated MCP bridge only when the existing `nekko_tools` **and** `context_note` capabilities are enabled for its Claude sign-in, and `titleAuto` is explicitly `true`.
- Incognito, offline, delegated child and training-run chats are excluded. A user-chosen title, including one chosen after the bridge launched, is never replaced.
- For an eligible ordinary user turn, append a short naming instruction to its outgoing user content. This does not edit the saved user message, add a message, inject a system prompt, or change Claude Code's launch flags. Image blocks remain intact; slash commands such as `/compact` remain unchanged. Background wake-ups send no naming message.
- The tool changes the Nekko chat title, not Claude Code's own session name. Dispatch checks the authenticated launch's offered tools, current provider capabilities, current title/privacy eligibility and an active turn. The store's guarded `set_auto_title` write checks title ownership again, then emits `session_meta` on success. Turn checkpoints preserve that saved title.
- Claude Code is explicitly excluded from the completion-sideband title path. There is no title-only Claude launch, provider fallback, credential access, approval-policy change or settings write.

### Supported defaults and limitations

Subscription sign-ins without the existing capability approval, and unread/unknown sign-ins, do not receive automatic naming. Their prompt-prefix placeholder remains, and manual rename still works. Existing API/cloud capability grants or an already-approved subscription can allow this in-turn path; this change never enables either capability for the user. Both grants are required even though naming itself does not need unattended-run permission.

Calling the tool is model-driven and subject to the existing tool permissions. A capability grant is not a guarantee that Claude will call it. If it is not called, is refused, or fails, the placeholder remains and a later eligible user turn can ask again. No extra call is made to force a title.

Focused coverage: CLI tool registry/offering and authenticated forwarding; outgoing naming-note content including images and slash commands; eligibility/privacy and sideband exclusions; fake-Claude daemon execution, blank-title rejection, persisted title plus `session_meta`, manual-rename protection and dispatch-time capability/privacy rechecks. These tests use no live Claude calls. Real subscription behavior and desktop visual evidence remain unverified by this backend change.
