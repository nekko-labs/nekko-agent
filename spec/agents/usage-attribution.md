---
title: "Where usage came from (attribution)"
area: agents
---

# Where usage came from (attribution)

`[implemented 2026-11-10, #2494; usage and daemon unit tests, renderer unit tests, hidden isolated capture of the Budget monitor; not yet seen on a live install's usage log]`

## Why

The Budget monitor showed totals (spend, tokens in and out) but not why tokens were spent, so a spike was hard to explain. A usage review asked for three splits: a turn the person sent versus a background continuation, the chat's own turns versus a subagent's, and cached reads versus new input.

## What the user sees

Under the Budget monitor's breakdown, for the selected range, six rows give a share and a token count:

- **Sent by you** and **Background** (turns that started on their own: a watch waking the chat, an automation, an automatic continue after compaction). They add up to 100%.
- **Main chats** and **Subagents** (a delegated child chat's turns). They add up to 100%.
- **Cache reads** and **New input** (new input including cache writes), as shares of all input.

Hovering a label says what it counts; hovering a value gives the exact token count. The rows appear only when the range has attributed usage. When the range starts before attribution did, a note says "Split since <date>; earlier usage is in the totals only".

## How it is recorded

- Each daemon turn's usage line (`usage.jsonl`) carries `origin`: `background` when the turn was unattended (`opts.unattended`, an automation's chat marked `unattended`) or an automatic continue (`opts.autoContinue`, set by auto_continue.rs), else `user`; and `parentSessionId` for a subagent's turn. Older lines have neither.
- `usage:summary` adds `attribution` to each day that has such lines: `user`, `background`, `parent` and `subagent`, each `{ input, cacheRead, cacheWrite, output, cost, listCost }`, where `input` is new input only. Days with only older lines have no `attribution`, so older engines and the frozen golden fixtures are unchanged. The renderer sums the range's days (`attributionRange` in monitorMetrics.ts).
- A Claude Code chat's subagents run inside its own turns and Claude Code reports their tokens in the parent's result, so they count as **Main chats** (see [Subagents in Claude chats](claude-code-subagents.md)). Side calls (titles) and compaction summaries carry no origin and are in the totals only.

Nothing leaves the computer; these are fields in the local usage log. No content is recorded.

## Not verified

- A live install's log over a day of mixed use, and the Local Web UI's Budget monitor (same component, not captured separately).
- Phones show no Budget monitor today.
