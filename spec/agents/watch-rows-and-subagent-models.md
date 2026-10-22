---
title: "Watch rows and subagent models"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Watch rows and subagent models

`[implemented 2026-10-15; unit-tested and verified in an isolated hidden renderer fixture (dark/light, wide/narrow) against the base revision; not yet checked in the packaged app]` Durable agent watches read like the other agent rows instead of chat messages. A step that arms a watch shows a binoculars icon, what it watches and what fires it (**Watching PR #555 · wakes on any PR change or after 1h**, or **Timer watch · wakes after 10 min**), and a subline **then · …** with the first sentence of its continuation. A chip beside it is live: time left (counting down each second while visible), **overdue N min** in the warning colour once a deadline passes by more than a minute without waking, **due · waiting for the chat** when it fired but the chat is busy, **retrying** after polling errors, then **triggered**, **cancelled** or **failed to wake**. A watch that could not be armed says **Watch not armed** with the reason. The wake-up the host sends is no longer a user bubble: it is one row, **Watch triggered · PR #555 changed (merged, checks pending)** or **Deadline reached**, with its time and the same then-line; expanding it shows the full wake-up text. This replaces the earlier **Agent watch · automated wake-up** label. Prefix recognition remains a presentation hint, not authenticated provenance.

Watch state comes from a new read-only `session:watches` channel listing a chat's watches (kind, PR URL, status, deadline, pending, failures, last error), never their continuation prompts, which the transcript already holds in the arming call. Rows refresh on the chat's tool results, turn ends and messages, plus a 15 s poll while one is on screen.

Every subagent row (group header, each step, standalone card) shows the model it runs on as a quiet chip, with the full ID in its tooltip and where it came from: the child chat's own model, else the call's `model_id`, else the saved delegation route or this chat's model when the call named none. The Working subagents panel shows it after the child's title. The running dots now sit before a live row's text, in a fixed box, so neither the dots nor the text move as the third dot lands.
