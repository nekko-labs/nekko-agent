---
status: accepted
date: 2026-11-03
---

# 0042. Claude Code's sub-agents are child chats

## Context

A Claude Agent chat delegates inside Claude Code's own session. Nekko saw that
only as `parent_tool_use_id` on stream lines, mapped to tool events with a
`parentToolCallId` that no client read, and they were not saved. The panel, the
wall, the delegation rows and the phones all work from child sessions, with
`spawn_agent` as the delegation's name, so none of them showed anything.

## Decision

Each sub-agent becomes a child session, written by the daemon from the stream.
A second `Mapper`, one per sub-agent, reads its lines, so its transcript and
live events have the shape of any other chat. The harness renames `Agent` and
`Task` to `spawn_agent`, adding `title` and `task`, which gives every client the
delegation row without a client change. `parentToolCallId` is gone.

The child records `spawnCallId`, the call that started it, and so do native
children. Clients find a child by that id, not by title and time.

## Alternatives

- **Teach each client `parentToolCallId`.** Four clients, nothing saved, and a
  window not showing the chat never receives tool events, so the panel still
  could not know.
- **A new "subagent" entity beside sessions.** Every surface would need a second
  path for what a child session already gives it.

## Consequences

The child is a copy: Claude Code holds the real conversation, so the child can't
be continued and `chat:send` refuses it. Saved transcripts from before this keep
`Agent` rows.
