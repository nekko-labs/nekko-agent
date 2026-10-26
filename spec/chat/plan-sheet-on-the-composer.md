---
title: "Plan sheet on the composer (2026-10-25)"
area: chat
---

# Plan sheet on the composer (2026-10-25)

Issue: [#1149](https://github.com/nekko-labs/nekko-agent/issues/1149).

## Intent

The agent's plan was split from the place the user works: it sat in the Agent Monitor column, while verification and PR state sat under the composer. The user wants the full plan of the session tied to the composer, with fewer lines and borders.

## Behavior (implemented)

- In the full chat view, the agent's plan is a card tucked behind the composer. It rises out from under the composer's top edge when the plan first appears, and has no border: a slightly raised surface separates it from the transcript.
- The header shows "Plan", progress ("2 of 4") and **Change plan**, which opens the existing plan-change prompt. Clicking the header collapses the card to one line with the current step's title.
- Each step has up to three rows: its title; one line of detail (the agent's note); and, only when the step has something to show, a slim row of chips.
- Finished and skipped steps squeeze to their title. While the pointer (or keyboard focus) is anywhere on the card, every squeezed step opens to its full rows. The grow and shrink take 120 ms; reduced motion turns them off.
- Chips are attached by the app, not reported by the model. The app replays the transcript's `update_plan` calls in order, and a PR the agent created (the same rule as the PR dock: a successful `gh pr create` or POST to `pulls`) or a file or preview it linked belongs to the step that was active at that point. Replayed steps map onto the live plan by title. A PR chip shows its number, state and CI rollup (passing, failing, or "CI 6 of 9" while running) from the existing PR poller and opens the PR; a file chip opens it in the file pane, and a preview chip opens its URL.
- The Agent Monitor no longer shows the plan; it keeps artifacts, project, sub-agents and queued follow-ups.
- Step status marks are unchanged from [per-step plan working icons](per-step-plan-working-icons.md) and still do not animate.
- An archived chat has no composer, so it shows no plan card.
- The card is not shown in the wall's compact composer or on a clean-start chat.

## Verification and CI on the card (implemented, second PR)

- A step with an explicit verification report shows a chip: Verified, Checking, Check failed, Check blocked, Check pending or Check unknown, with the device ("Verified on macOS"). Its tooltip says it is agent-reported and gives the report's age (stale for waiting reports). It opens the evidence link only when that link is safe. The report's detail replaces the step's note on the detail row. A done step without a report shows no chip.
- CI checks of each open PR sit in one slim row under the last step that has a verification report (else the step that opened the PR, else the running step): failing and running checks by name, failing first, and the passing ones folded into "N passed", which opens the PR's checks page.
- The separate Verification panel under the composer is gone. When the card shows CI, the PR card keeps its actions and review threads but drops its CI lines; without a plan (or in the wall's compact composer) the PR card still shows CI.

## Verification

Unit coverage for step matching (`planStepLinks.test.ts`) and the card's rendering (`PlanRail.test.tsx`). Hidden, off-screen Electron captures (`plan-sheet-sandbox.cjs`) check that the card is tucked behind the composer, the right column has no plan, finished steps are squeezed, the PR and link chips land on the right steps, and hovering the card opens every finished step. Not verified in a packaged build.
