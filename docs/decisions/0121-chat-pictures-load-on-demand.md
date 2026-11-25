---
status: accepted
date: 2026-11-26
---

# 0121. The window gets a chat's pictures on demand, not inside `session:get`

## Context

[0072](0072-chat-pictures-beside-the-chat-and-held-turn-saves.md) moved pictures
out of the chat file, but `SessionStore::read` put every one back as a data URL,
so each `session:get` carried them: a long agent chat is tens of megabytes of
screenshots, and the window's transcript cache and heap held them too. The
window draws only the pictures a user attached and a model generated; the
screenshots a tool returned are never drawn.

## Decision

- **Opt-in references.** `session:get(id, { pictures: 'refs' })` returns the chat
  with `nekko-blob:<name>` where the file holds one (pictures under 4 KB stay
  inline). With no option the reply is as before: data URLs. The phones, the CLI,
  the MCP server, export, sync, compaction and everything that builds model
  context call the store's `get` and never see references.
- **A channel to fetch one.** `session:blob(name)` returns a data URL for a
  blob name (bare or as the reference), or null. Names are validated strictly
  (64 hex digits and one known image extension), so no path can leave
  `sessions/blobs`. It sits behind the same per-launch token as every channel.
- **A channel, not an image URL.** The window's content security policy allows
  `img-src 'self' data:`, and an `<img>` URL would carry the per-launch token in
  its query string. A data URL over the existing channel needs neither change.
- **Another computer's chat** (`@computer:id`) is always asked for inline: that
  computer's pictures are not in this computer's blob folder.
- **The window opts in by default** (renderer PR), resolves a picture when it
  scrolls into view, and keeps a bounded cache of the data URLs. A reference with
  no blob here (a synced chat whose picture has not arrived) shows the existing
  "picture on its way" placeholder.

## Consequences

- `session:get` for the window shrinks to the chat's text; pictures cost one
  small call each, only for the ones drawn.
- Code in the window that moves a picture out of a chat (edit and resend, copy to
  the composer, split a chat) must resolve references first.
- The phones' `session:get` is unchanged on the wire; the daemon still restores
  pictures before thumbnailing them, which a later change could skip.
