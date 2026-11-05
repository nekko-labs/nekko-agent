---
title: "Persistent PR lifecycle cards in agent chat"
area: chat
---

# Persistent PR lifecycle cards in agent chat

## Intent

PR work should remain visible in the conversation at the point it happened, not disappear into a collapsed tool group or wait until the turn ends. Historical milestones and the PR's current fetched status are different facts.

## Implemented

- Confirmed, attributable `bash` / `Bash` calls to `gh pr` project inline cards for creation, draft, ready for review, queue entry, merge request, actual merge, close, reopen, update, review and view/check/diff interactions. Existing direct API creation support is retained.
- Events are derived from stored tool calls/results, not assistant prose, pasted URLs, read files, arbitrary output or a guessed branch/repository. A direct PR URL, explicit repo/number, gh's own full repo/number status line, or an unambiguous previously known identity supplies the link. Failed, pending, orphaned, contradictory and replayed results do not establish success.
- A successful merge command alone means **Merge requested**. **PR queued** needs queue-entry confirmation; **PR merged** needs terminal confirmation. Enabling auto-merge is not a merge. Quoted bodies/titles and formatting expressions do not supply identity or terminal-state evidence.
- A single leading `cd … &&` and established create-body heredocs/output trims remain supported. Ambiguous shell batches, scripts, unrecognized flags and branch-only targets are deliberately not interpreted as lifecycle evidence.
- Saved transcript cards follow their originating tool result and split collapsed working groups at that point. Repeated events have distinct stable call-based keys. Fresh live status never rewrites an old event label. Timestamped terminal polling remains a fallback for a PR closed or merged outside the chat, without duplicating a confirmed milestone.
- Live turns retain only attributable PR calls and bounded results, render a card when each result arrives, and carry the same sequence through replay, the held completion and saved history. Outputs above the existing 40,000-character live cap wait for saved history rather than parsing a truncated result. Other tools' outputs are not retained for this purpose.
- When live metadata is already available, the first card for an open PR retains existing live status, checks/review progress and actions; subsequent historical cards do not duplicate its action buttons. Creating or viewing a PR does not automatically run any PR mutation. Existing polling/subscriptions are reused; the creation-only session summary and plan-output attribution remain unchanged. New interactions without live metadata still get a canonical linked milestone rather than fabricated current status.
- Desktop and the Local Web UI share this renderer. Cards use existing theme tokens and link to the canonical GitHub PR, with responsive title truncation and readable lifecycle labels.

## Verification

Focused parser, transcript, card and live replay/handoff tests cover chronology, repeated transitions, numeric identities, contradictory results, false merge prevention and bounded live retention. The actual ChatPane runs in a hidden, non-focusable Electron fixture with a disposable profile, a stub bridge and external requests/permissions blocked. Matching base/head screenshots at 1000×1100 and 390×1100 cover saved history; the same fixture captures live creation → draft → ready → queued and its saved handoff as PNG frames and a short GIF.

Matching desktop/narrow baseline/head pixels and live/saved PNGs have been inspected. The initial creation card is visibly present after a fixture compositor barrier. The canonical PR link click, exactly one action card and identical before/after-finish event order passed. Shared and desktop regressions pass across 389 files / 3,643 tests after building the required desktop bundles; desktop typecheck and shared build also pass. Captures alone were not counted as visual verification.

## Boundaries / unverified

This does not invent structured lifecycle events for arbitrary connector tools or compound shell scripts, add GitHub credentials, migrate stored messages, or add a second PR poller. UI-button actions retain their existing live refresh and terminal-poll behavior; a new backend audit/event log for every manual PR action is not implemented. Packaged-app, real GitHub mutation, paired-device and native iOS/Android rendering have not been verified by this renderer fixture.
