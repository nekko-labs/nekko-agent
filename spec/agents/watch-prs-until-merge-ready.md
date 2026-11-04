---
title: "Watch PRs until they are merge-ready, by default"
area: agents
---

# Watch PRs until they are merge-ready, by default

`[implemented 2026-11-04; daemon unit and scheduler tests; not yet verified in a live chat against a real PR]`

## Why

An agent that opened a PR usually ended its turn there. Watching the PR's CI
and getting it merged depended on the model choosing to arm `agent_watch`, and
chats on the Claude Code harness have no `agent_watch` at all (Nekko never
appends to Claude Code's system prompt or gives it the tool). So few agents
were ever seen **Watching**, and PRs sat with red checks or unanswered reviews
until the user came back. Every user and project now gets the watch by default.

## What happens

- When any turn ends (native, Claude Code or another harness), the host reads
  the chat's transcript for PRs **the chat opened**: a successful
  `gh pr create`, a `gh api .../pulls -X POST`, or a connector's
  create-pull-request tool, taking the PR URL from its output. PRs the chat
  only read or mentioned are not its to drive.
- For each such PR that is still open and has no armed watch (the agent's own
  `agent_watch` on it counts), the host arms a PR watch marked `auto`, with a
  3-hour deadline. Its continuation asks the agent to get the PR merge-ready:
  read checks, reviews, conflicts, the Unfinished work section and required
  evidence; fix and push; diagnose before rerunning; land it the repository's
  way when the user or the repository authorizes landing, otherwise report it
  merge-ready or name the blocker. It never grants permission to bypass
  protections, approvals or checks, and it leaves a PR the user asked to hold.
- The watch wakes the chat on any PR change (state, checks, review decision,
  draft, update time) or at the deadline, through the same scheduler as
  `agent_watch` (one-shot, durable, a busy chat is not interrupted). When the
  woken turn ends with the PR still open, the host arms the next watch.
- It stops for a PR when the PR is merged or closed, when the user cancels the
  host's watch on it, when a wake-up fails to deliver, or after 24 wake-ups for
  that PR in that chat. A turn the user stopped arms nothing. Merged and closed
  PRs are remembered per daemon run, so old PRs are read once, not every turn.
- Not armed in incognito, offline, archived or training-run chats. Child
  (delegated) chats are armed like any chat, since the parent's transcript does
  not show the PR as opened.

## Where the user sees it

- The composer chip reads **Watching until merge-ready** for a host-armed
  watch, and its details say why it exists and how to stop it. The sidebar's
  **Watching** group and the idle (Zz) glyph count it like any active watch.
- Settings › Tools › Pull requests, behind **Show advanced settings** below
  Expert (and the first-run Work tracking step):
  **Watch each PR until it is merge-ready**, on unless turned off
  (`pullRequests.watchUntilMergeReady`). The chip's details spell out that path.
- `session:watches` views carry `auto: true` for these watches.

## Implementation

`crates/nekkod/src/pr_autowatch.rs` (which PRs, the continuation, when to stop),
`Watches::watch_opened_prs` in `watches.rs` (arming, sharing the tool's create
path), called from `Turns::after_turn_hooks` in `turns.rs`.

## Not verified

- A live chat (native and Claude Code) opening a real PR and being woken by it.
- The renderer chip label and Settings toggle have no visual capture yet.
