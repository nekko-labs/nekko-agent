---
title: "Run here or in a subagent"
area: agents
---

# Run here or in a subagent

`[implemented on desktop and Local Web UI 2026-11-03; unit tested; the real ChatPane checked in a hidden renderer, including what is sent; not yet tried with a live model; phones not built]`

More work for a chat keeps filling its context. A subagent does the work separately and reports back, so the main chat stays light, but that used to mean asking for it in words.

When there is more work to place, the composer offers two actions in a slim row above its buttons:

- **Do it here**, marked *uses more context*: it runs in this chat, with everything said so far. Enter does the same, so nothing about sending changes.
- **In a subagent**: a subagent does it and reports back to this chat.

**When it shows.** While you have typed a follow-up, or while the agent's suggested next step is waiting in the empty box. Then either action runs the suggestion, without typing it. It needs a reply to follow up on. It stays away for slash commands, image chats, and wherever delegation cannot run: the **Solo** strategy, `spawn_agent` switched off, offline, incognito, Sandbox, a subagent's own chat, and a computer that is blocked.

**During a reply** both actions queue, as sending does.

**What it does.** The message becomes *Do this in a subagent, then report back:* followed by your words. It is sent and shown as your message, on every engine, so there is nothing hidden and no new path: the model delegates with `spawn_agent`, or Claude Code with its `Agent` tool. The agent is being asked, not forced, so a model can still decline.

**On a Claude plan** this is a message the person wrote and chose to send, so it needs no new row in the [Claude policy](../product/claude-policy.md).

## Not done

iPhone and Android do not have this yet, tracked as SUB-4.
