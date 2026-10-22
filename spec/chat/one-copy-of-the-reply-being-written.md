---
title: "One copy of the reply being written"
area: chat
split-from: SPEC.md (2026-10-22)
---

# One copy of the reply being written

`[implemented 2026-10-15, verified in an isolated hidden renderer fixture, light and dark]` While a reply is in flight the chat draws the current turn once, from the live run under the transcript. The transcript itself stops at the prompt that started the turn, even though the daemon checkpoints the chat after every tool result and the pane re-reads it: that checkpointed tail (the turn's narration and tool calls so far) is the same content the live run is drawing. It used to be drawn twice, once as a settled bubble with a Done row above the working steps and once streaming below them, until the real answer landed. Once the turn ends and the persisted reply has replaced the held live copy, the transcript shows the full turn as before.

Acceptance: during a turn the narration appears once, in the live region, with no Done row; after the turn the persisted copy appears once in the transcript. No host, daemon or storage change; the packaged app and native OS chrome were not captured.
