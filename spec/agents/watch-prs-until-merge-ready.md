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
- The watch wakes the chat when the PR needs attention, or at the deadline,
  through the same scheduler as `agent_watch` (one-shot, durable, a busy chat
  is not interrupted). When the woken turn ends with the PR still open, the
  host arms the next watch.
- **Waiting costs no tokens** `[implemented 2026-11-10, #2483; daemon unit and
  scheduler tests; not yet seen in a live chat]`. Before, any change to the
  PR's snapshot woke the chat, including `updatedAt` after the agent's own
  push and checks moving to pending, so a model turn ran only to say "still
  waiting for checks". Now a change wakes the chat only when it is
  actionable: the PR merged or closed, a review decision, draft state, checks
  finishing (passing or failing), or an update with the checks unchanged (a
  comment or review). Checks starting or still running, and the push that
  started them, are recorded on the watch (its `fingerprint`) and shown from
  that metadata: `session:watches` views carry `checks` and `prState` as last
  polled, and the composer chip and the transcript's watch chip read **checks
  running**, **checks failing**, **checks passed** or **no checks yet**
  beside the time left. The agent's own PR watches share the scheduler, so
  the rule applies to them too (`watches::actionable_change`). A fingerprint
  that is not a snapshot object (older watches) wakes on any change, as
  before. The row headline still reads "wakes on any PR change" on every
  client; rewording it touches the phones too and is left for later.
- It stops for a PR when the PR is merged or closed, when the user cancels the
  host's watch on it, when a wake-up fails to deliver, or after 24 wake-ups for
  that PR in that chat. A turn the user stopped arms nothing. Merged and closed
  PRs are remembered per daemon run, so old PRs are read once, not every turn.
  When old finished watches are pruned `[2026-11-09]`, the newest host watch
  for each chat and PR (the cancelled or failed one, when there is one) is
  kept and carries a `rounds` count of the ones dropped, so these stops still
  hold. They are dropped only when the chat is deleted.
- Not armed for a chat the host may not wake `[fixed 2026-11-05]`: a Claude
  Code chat on a Claude plan, whose `unattended_runs` row is off
  (`claude:capability`, the same answer admission's gate uses). Before, the
  watch was armed there anyway and its wake-up was refused, so the chat showed
  "Scheduled runs need Claude with an API key." after the agent's reply. Claude
  on an API key or a cloud account, and a plan whose row the user or a signed
  policy turned on, are watched as before. A watch armed before the fix still
  fails once and then stops.
- Claude Code chats can also arm watches themselves where the Claude policy allows it (an API key or cloud account): the approval bridge offers `agent_watch`, and the transcript shows the call as Nekko's watch row. See [Claude policy](../product/claude-policy.md).
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
path), called from `Turns::after_turn_hooks` in `turns.rs`, which first asks
`claude:capability` for `unattended_runs` (`pr_autowatch::wakes_allowed`).

## Not verified

- A live chat (native and Claude Code) opening a real PR and being woken by it.
- The renderer chip label and Settings toggle have no visual capture yet.
