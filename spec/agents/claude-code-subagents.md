---
title: "Subagents in Claude chats"
area: agents
---

# Subagents in Claude chats

`[implemented 2026-11-03; unit and end-to-end daemon tests against a scripted Claude Code; not yet checked against a live Claude Code sub-agent or a live plan sign-in]`

Claude Code runs a sub-agent inside the chat's own session, so before this change Nekko had nothing to show: the `Agent` call read as an ordinary tool, the sub-agent's steps went out as events no client read, and no child chat existed. People concluded nothing was being delegated.

Now each sub-agent is an ordinary child chat, made from what Claude Code prints:

- **In the parent chat** an `Agent` (or older `Task`) call is a delegation, the same row a `spawn_agent` call gets on every client: its task, the model it runs on, **To subagent** and **From subagent**, and **Open ↗**.
- **In the Agents panel** it sits under its parent, and the Working subagents control on the chat counts it while it runs. On the Agents wall that control sits on the window's composer bar, beside the microphone and as tall as it, with its list opening above it; a window showing only the transcript, with no composer of its own, keeps it in the window's bottom-right corner (`[implemented 2026-11-24, #3265; unit-tested and checked in a hidden renderer fixture against main; not yet checked in the packaged app]`).
- **Its own chat** shows what it is doing live: its task as the first message, then its text, thinking, tool calls and results, and the model read from its first reply. `chat:running` lists it while it runs, so a window opened mid-run shows it working.

**A watching copy, not a conversation.** Claude Code holds the real history, so the chat is marked `claudeCodeSubagent`, its composer says *This subagent runs inside its parent chat. Send your message there.*, and `chat:send` refuses it the same way for phones.

**Ending.** A sub-agent ends with its delegating call's result, or, when it runs in the background, at its `task_notification`, which can be turns later. It runs in the background when its call says `run_in_background`, and also when Claude Code moves it there itself: `task_started` with `is_backgrounded`, or an `Agent` result that only says "Async agent launched". That is every sub-agent when Claude Code runs them in the background by default. Stopping the chat stops the ones the turn was waiting on. A background one stays open across turns until its notification, and closes as stopped if its process goes away.

**Its whole transcript** (fixed 2026-11-12, [#2645](https://github.com/nekko-labs/nekko-agent/issues/2645)) `[unit, harness-fixture and end-to-end daemon tested against a scripted Claude Code; the reader was also run read-only against a real session's saved sub-agent transcripts; not yet watched in a live chat]`. Before this fix, a sub-agent Claude Code backgrounded by itself was closed as stopped at the end of the turn that started it, and its later steps were dropped: its child chat held its first few steps only, so the PRs it opened never reached the parent (see [Agent card PR chip](agent-card-pr-chip.md)). Now:

- Such a sub-agent is kept open until its notification, like one started with `run_in_background`.
- When a sub-agent ends, its child chat is filled from the copy Claude Code saved (`<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`, found by the `toolUseId` in the `agent-<id>.meta.json` beside it), mapped exactly as the stream is. That covers steps the stream never delivered. The chat keeps its task message, and the saved copy replaces the rest only when it holds every tool call the chat already shows and more besides, so a wrong or older file never replaces it. Each step appears once. The chat is marked `transcriptFilledAt`.
- At startup, sub-agent chats changed in the last 30 days that ended short are filled the same way, keeping their `updatedAt` so the chat lists do not reorder.
- **Untrusted input.** The files are Claude Code's. They are read only inside the chat's Claude Code config folder (its account's, else `CLAUDE_CONFIG_DIR`, else `~/.claude`), by names built from the chat's Claude Code session id and the sub-agent's call id. Those ids may hold only letters, digits, `-` and `_`. The files are never followed through links and are capped in size (32 MB for a transcript, 64 KB for its meta file), and malformed lines are skipped. No path ever comes from the model or the stream.
- A sub-agent's own sub-agents still get a delegation row but no chat of their own.

**Boundaries.** Nothing here sends anything to Claude Code, so it needs no new row in the [Claude policy](../product/claude-policy.md) and applies to every sign-in, a plan included. No usage is recorded on the child: Claude Code reports a sub-agent's tokens in the parent's `result`. An incognito chat makes no child chats, since they would leave its work on disk; its delegation rows still show. A sub-agent's own sub-agent gets a delegation row in its child chat but no chat of its own.

Old chats keep the `Agent` rows they were saved with.

Decision: [0042](../../docs/decisions/0042-claude-code-sub-agents-are-child-chats.md).

## While the chat waits on its sub-agents

`[implemented 2026-11-15, #2840; unit and end-to-end daemon tests against a scripted Claude Code, the stream shape checked against a live Claude Code 2.1.319; not yet watched in a live chat]`

**User intent.** Philip, on a Claude Agent chat (Claude plan) that started three background sub-agents and ended its turn: "while the agent is waiting for agents to progress, it should show in the building status. There's no indicator in the chat for their progress." And: "the first message back ... didn't have a timestamp and showed done. if that's the end of the turn, it should have the turn details."

**What was wrong.** After its turn's `result`, Claude Code keeps printing its background sub-agents' own lines (and `task_progress`, `task_updated`, `commands_changed`). nekkod's idle watch takes them as a wake-up and runs a wake-up turn that only feeds the child chats until a sub-agent reports back, so the parent had no reply of its own on screen: the Agents panel filed it under Done, and the chat said nothing. When the reply after a sub-agent's report did stream, the chat stopped the saved transcript at the last user message, as it does for any live reply. A wake-up has no user message, so the whole turn before it vanished and the reply showed as the first message back, as its live copy: no timestamp, "Done." and no turn details until the chat was read again.

**Now:**

- **Agents panel.** A chat counts as working while any of its sub-agents works, so it stays in Building (or Verifying) with the working rocket. A sub-agent waiting on you still lifts it to Needs input, and a chat's own state (working, an error) stands otherwise.
- **In the chat.** Under the finished turn, the chat says **Waiting on N sub-agents** and lists each working one with the working glyph, its title and what it is doing now (its latest tool, thought or sentence, as the delegation row says it). A row opens that sub-agent's chat. Claude Code's other background tasks are counted after them ("and 2 other background tasks"); with no sub-agent working, the line reads as before, "Claude Code is still running N background tasks". It shows only while the chat has no reply of its own streaming.
- **The reply after a report.** nekkod saves where each turn's own messages start (`activeRun.afterMessageId`: its prompt, or for a wake-up the last message of the turn before it) and says `session_meta` when a wake-up starts. The chat stops the saved transcript there while the reply streams, so the reply streams under the turn before it and lands as a normal reply, with its time and turn details.

**Not yet.** The Local Web UI gets all three (it runs the desktop renderer); the phones still show neither the sub-agent list nor the lifted status.
