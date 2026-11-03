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

**Ending.** A sub-agent ends with its delegating call's result, or, when it runs in the background (`run_in_background`, or `task_started.is_backgrounded`), at its `task_notification`, which can be turns later. Stopping the chat stops the ones the turn was waiting on. A background one stays open across turns until its notification, and closes as stopped if its process goes away.

**Boundaries.** Nothing here sends anything to Claude Code, so it needs no new row in the [Claude policy](../product/claude-policy.md) and applies to every sign-in, a plan included. No usage is recorded on the child: Claude Code reports a sub-agent's tokens in the parent's `result`. An incognito chat makes no child chats, since they would leave its work on disk; its delegation rows still show. A sub-agent's own sub-agent gets a delegation row in its child chat but no chat of its own.

Old chats keep the `Agent` rows they were saved with.

Decision: [0042](../../docs/decisions/0042-claude-code-sub-agents-are-child-chats.md).
