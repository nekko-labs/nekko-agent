---
title: "Watch rows and subagent models"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Watch rows and subagent models

`[implemented 2026-10-15; unit-tested and verified in an isolated hidden renderer fixture (dark/light, wide/narrow) against the base revision; not yet checked in the packaged app]` Durable agent watches read like the other agent rows instead of chat messages. A step that arms a watch shows a binoculars icon, what it watches and what fires it (**Watching PR #555 · wakes on any PR change or after 1h**, or **Timer watch · wakes after 10 min**), and a subline **then · …** with the first sentence of its continuation. A chip beside it is live: time left (counting down each second while visible), **overdue N min** in the warning colour once a deadline passes by more than a minute without waking, **due · waiting for the chat** when it fired but the chat is busy, **retrying** after polling errors, then **triggered**, **cancelled** or **failed to wake**. A watch that could not be armed says **Watch not armed** with the reason. The wake-up the host sends is no longer a user bubble: it is one row, **Watch triggered · PR #555 changed (merged, checks pending)** or **Deadline reached**, with its time and the same then-line; expanding it shows the full wake-up text. This replaces the earlier **Agent watch · automated wake-up** label. Prefix recognition remains a presentation hint, not authenticated provenance.

Watch state comes from a new read-only `session:watches` channel listing a chat's watches (kind, PR URL, status, deadline, pending, failures, last error), never their continuation prompts, which the transcript already holds in the arming call. Rows refresh on the chat's tool results, turn ends and messages, plus a 15 s poll while one is on screen.

Every subagent row (group header, each step, standalone card) shows the model it runs on as a quiet chip, with the full ID in its tooltip and where it came from: the child chat's own model, else the call's `model_id`, else the saved delegation route or this chat's model when the call named none. The Working subagents panel shows it after the child's title. The running dots now sit before a live row's text, in a fixed box, so neither the dots nor the text move as the third dot lands.

## Agent status: done versus waiting on a watch (#1110)

`[implemented; focused daemon, renderer and native tests; matching hidden before/after captures collected; visual inspection pending]`
Desktop sidebar cards, wall strips/composer, child-chat rows, phone-width web,
and native iOS/Android chat rows distinguish an inactive agent that is finished
from one waiting to wake:

- **Done:** a quiet gray checkmark when no turn/input/error state is active and
  there are no armed watches. This is a status, not the archive/Complete action;
  an unarchived chat can be done. Archived native rows use the same gray check.
- **Idle:** the existing Zz glyph when no work is active but at least one watch
  remains armed. A due watch waiting for a busy chat still counts as armed.
- Working, approval/question, interrupted/error and iOS outbox indicators retain
  precedence; a watch never hides actionable or running work. Native activity
  models do not introduce a new error state in this change.

The host adds `activeWatchCount` to `sessions:list` and `sessions:summaries`,
reading the watch file once per listing. Only `status: active` counts; triggered,
cancelled and failed watches do not. Missing counts from older hosts default to
zero. The count is computed on reads, not persisted into session transcripts;
phone summaries receive no watch continuation, URL or error details through this
field. Watch creation/cancellation and active-to-terminal transitions publish a
minimal `session_meta` event after saving. Clients refresh summaries on that event
and turn completion; the desktop refresh is debounced and does not require an
open ChatPane. Metadata alone never marks a chat working. Invalidations received
while a summary call is pending are coalesced into a trailing fetch, so an old
watch count cannot be the final result. Disconnected/replaced phone clients do
not apply late responses. Failed requests alone do not start a retry loop.

Evidence uses synthetic records and base `beee7cd1` at matching dimensions,
theme and data, in hidden Electron fixtures and owned native framebuffer-only
sandboxes. Desktop real glyph/card/frame checks pass;
the desktop composer fixture is a layout equivalent, not full composer navigation.
Native iOS gray-check pixel/precedence tests and Android Compose precedence/tint
tests pass. Screenshots are captured but not visually inspected because the
available tools cannot display image content. Packaged-app/navigation coverage is
not claimed. The retired Expo app is out of scope: main removed it in #1125 during this work;
its independent prototype and tests were discarded rather than resurrecting it.

## Composer controls and teardown (2026-10-25)

An active watch also appears as an expandable composer chip, independent of whether its arming call exists in the loaded transcript. It offers owned cancellation and a PR link; immediate child-agent watches are labeled by owner. Watch subscriptions share a poller per session. Removing the final subscriber clears the poll interval/event listener/cache entry and late responses cannot recreate that entry. Closing/completing an agent cancels work and watches through the engine lifecycle; minimize remains hide-only.
