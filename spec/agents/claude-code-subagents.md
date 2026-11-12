---
title: "Subagents in Claude chats"
area: agents
---

# Subagents in Claude chats

`[implemented 2026-11-03; unit and end-to-end daemon tests against a scripted Claude Code; not yet checked against a live Claude Code sub-agent or a live plan sign-in]`

Claude Code runs a sub-agent inside the chat's own session, so before this change Nekko had nothing to show: the `Agent` call read as an ordinary tool, the sub-agent's steps went out as events no client read, and no child chat existed. People concluded nothing was being delegated.

Now each sub-agent is an ordinary child chat, made from what Claude Code prints:

- **In the parent chat** an `Agent` (or older `Task`) call is a delegation, the same row a `spawn_agent` call gets on every client: its task, the model it runs on, **To subagent** and **From subagent**, and **Open ↗**.
- **In the Agents panel** it sits under its parent, and the Working subagents control on the chat counts it while it runs.
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
