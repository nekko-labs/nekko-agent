---
title: "Persistent PR lifecycle cards in agent chat"
area: chat
---

# Persistent PR lifecycle cards in agent chat

## Intent

PR work should remain visible in the conversation at the point it happened, not disappear into a collapsed tool group or wait until the turn ends. Historical milestones and the PR's current fetched status are different facts.

## Implemented

- Confirmed, attributable `bash` / `Bash` calls to `gh pr` project inline cards for creation, draft creation, draft, ready for review, auto-merge enabled, queue entry, merge request, actual merge, close, reopen, update, review and view/check/diff interactions. Existing direct API creation support is retained.
- Events are derived from stored tool calls/results, not assistant prose, pasted URLs, read files, arbitrary output or a guessed branch/repository. A direct PR URL, explicit repo/number, gh's own full repo/number status line, or an unambiguous previously known identity supplies the link. Failed, pending, orphaned, contradictory and replayed results do not establish success.
- A successful merge command alone means **Merge requested**. **PR queued** needs queue-entry confirmation; **PR merged** needs terminal confirmation. Explicit auto-merge confirmation means **Auto-merge enabled**, not merged. No-op/already-state warnings, multiple or contradictory confirmations and unknown merge output do not invent transitions. Quoted bodies/titles and formatting expressions do not supply identity or terminal-state evidence.
- A single leading `cd … &&` and established create-body heredocs/output trims remain supported. Ambiguous shell batches, scripts, unrecognized flags are deliberately not interpreted as lifecycle evidence. Branch selectors require gh’s identifying success confirmation, never inferred repository context.
- Saved transcript cards follow their originating tool result and split collapsed working groups at that point. Repeated events have distinct stable call-based keys. Fresh live status never rewrites an old event label. Timestamped terminal polling remains a fallback for a PR closed or merged outside the chat, without duplicating a confirmed milestone.
- Live turns retain only attributable PR calls and bounded results, render a card when each result arrives, and carry the same sequence through replay, the held completion and saved history. Outputs above the existing 40,000-character live cap wait for saved history rather than parsing a truncated result. Other tools' outputs are not retained for this purpose.
- When live metadata is already available, the first card for an open PR retains existing live status, checks/review progress and actions; subsequent historical cards do not duplicate its action buttons. Creating or viewing a PR does not automatically run any PR mutation. Existing polling/subscriptions are reused; the creation-only session summary and plan-output attribution remain unchanged. New interactions without live metadata still get a canonical linked milestone rather than fabricated current status.
- Desktop and the Local Web UI share this renderer. Cards use existing theme tokens and link to the canonical GitHub PR, with responsive title truncation and readable lifecycle labels.

The consolidated projection incorporates the confirmation semantics and regression cases from #1816/#1817 without a second parser or renderer.

## Verification

Focused parser, transcript, card and live replay/handoff tests cover chronology, repeated transitions, numeric identities, contradictory results, false merge prevention and bounded live retention. The actual ChatPane runs in a hidden, non-focusable Electron fixture with a disposable profile, a stub bridge and external requests/permissions blocked. Matching base/head screenshots at 1000×1100 and 390×1100 cover saved history; the same fixture captures live draft creation → draft → ready → auto-merge → queued and its saved handoff as PNG frames and a short GIF.

Reconciled matching before/after screenshots at 1000×1100 and 390×1100 (dark), plus 390×1100 light-theme screenshots, have been inspected. All five live frames and the saved handoff were inspected; the historical draft creation and auto-merge labels are distinct from refreshed current state, remain whole at narrow widths, and do not imply a merge. The canonical link click, one live action card, zero errors/overflow and identical before/after-finish sequence passed. Shared/desktop regressions pass across 391 files / 3,663 tests; 201 focused parser/transcript/card/live tests, desktop typecheck/build, shared build and 22 desktop Node checks pass (one platform skip). The sandbox now asserts the reconciled sequence rather than merely recording captures. The main sync retains both working-agent completion notifications and lifecycle parsing. CI exposed a Vite dynamic-import timeout in the unchanged launcher safety test (#1841); its safety assertion now uses bounded native Node imports under the unchanged five-second test budget. No runtime code or check budget was changed. Captures alone were not counted as visual verification.

## Boundaries / unverified

This does not invent structured lifecycle events for arbitrary connector tools or compound shell scripts, add GitHub credentials, migrate stored messages, or add a second PR poller. UI-button actions retain their existing live refresh and terminal-poll behavior; a new backend audit/event log for every manual PR action is not implemented. Packaged-app, real GitHub mutation, paired-device and native iOS/Android rendering have not been verified by this renderer fixture.
