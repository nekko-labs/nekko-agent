---
title: "Run here or in a subagent"
area: agents
---

# Run here or in a subagent

`[implemented on desktop and Local Web UI 2026-11-03; on iPhone and Android 2026-11-03; unit tested; the real ChatPane checked in a hidden renderer, and both phones end to end against a real computer and relay, including what is sent; not yet tried with a live model]`

More work for a chat keeps filling its context. A subagent does the work separately and reports back, so the main chat stays light, but that used to mean asking for it in words.

When there is more work to place, the conversation offers two actions at its end, under the latest reply, where the other next steps (such as watching an open PR) appear. The composer stays as it was:

- **Do it here**, marked *uses more context*: it runs in this chat, with everything said so far. Enter does the same, so nothing about sending changes.
- **In a subagent**: a subagent does it and reports back to this chat.

**When it shows.** While you have typed a follow-up, or while answering an explicit agent question. Generated suggestions use the separate contextual response row described below, not generic execution-location buttons. It needs a reply to follow up on. It stays away for slash commands, image chats, and wherever delegation cannot run: the **Solo** strategy, `spawn_agent` switched off, offline, incognito, Sandbox, a subagent's own chat, and a computer that is blocked.

**During a reply** both actions queue, as sending does.

**What it does.** The message becomes *Do this in a subagent, then report back:* followed by your words. It is sent and shown as your message, on every engine, so there is nothing hidden and no new path: the model delegates with `spawn_agent`, or Claude Code with its `Agent` tool. The agent is being asked, not forced, so a model can still decline.

**On iPhone and Android.** The same two actions, for a typed follow-up. They sit just above the message box, beside the phone's other next steps (the PR chip), and the box itself is unchanged. The phones have no suggested next step, so there is nothing to offer in an empty box. The rule is the desktop's: a picked skill or saved prompt counts as a slash command, and the row stays away while the computer is out of reach (a message then waits on the phone, and the phone can't tell whether delegation will run). The phone learns the computer's strategy from its settings, read only; a computer from before this doesn't say, so its phones offer the choice even on **Solo**, where the agent simply does the work itself.

**On a Claude plan** this is a message the person wrote and chose to send, so it needs no new row in the [Claude policy](../product/claude-policy.md).

## Contextual suggested follow-ups (implementation on branch, verification in progress)

User intent: a generated suggestion about inspecting saved PNGs should offer concrete responses, not just “Do it here” and “In a subagent”. The side-call model now returns 2–3 distinct, self-contained user messages in the existing `ReplySuggestions.options` list. Avoid generic yes/no answers, duplicate choices, invented approvals, and execution-location choices. No useful next step means no options. No additional model call is introduced.

Desktop and Local Web UI show these as primary buttons beneath “Suggested follow-ups”, clearly separate from an agent question. Clicking sends exactly the visible choice. A secondary “Run in” select defaults to “This chat”; where existing delegation restrictions allow it, “A subagent” wraps the chosen response in the existing delegation instruction. Choosing a location alone never sends. Contextual buttons remain usable when delegation is unavailable. Typed drafts retain their existing placement controls and Enter behavior.

Compatibility: an older engine returning only `next` gets a single full-message button, never a fabricated yes/no alternative. Suggestions are bounded to four unique text choices, escaped as ordinary React text. A pending question, approval, error, live/held reply, blocked computer, image chat, or nonempty draft suppresses the suggestion row. Suggestions belong to the latest assistant reply and disappear after sending. They do not authorize tools or bypass approvals. Native phones have no generated suggestions and are unchanged.

Acceptance: verify exact direct and delegated send payloads, no send on render/location selection, empty/malformed/legacy options, provider-independent delegation gating, no stale row after sending, and readable wrapping at desktop and 390px web widths. Synthetic ChatPane interaction checks and focused unit tests pass; before/after pixel inspection and live-model quality remain unverified until recorded in the PR.
