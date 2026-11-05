---
title: "Sub-agents as a tree and as live cards on the plan, a clear sub-agent chat, and plan checks on their bullets (2026-11-06)"
area: agents
---

# Sub-agents as a tree and as live cards on the plan, a clear sub-agent chat, and plan checks on their bullets (2026-11-06)

Issue: [#1892](https://github.com/nekko-labs/nekko-agent/issues/1892).

## Intent

Philip saw status said twice: the plan sheet's Verify sub-bullets each had a chip on the right ("Check pending on iOS") repeating the bullet on the left, and each sub-agent row in the agent panel had a hollow bullet on the left and its rocket or check on the right. One place is enough, and it should be the left. A check that was running on a step already marked done did not show as in progress. Sub-agent rows did not read as children of the card above them, and opening a sub-agent looked like opening any other chat. He then asked for the chat's sub-agents to be live cards at the bottom of the plan: each with its status and what it is working on as a one-line title, opening the sub-agent when tapped.

## Behavior

- **Plan checks on the bullet.** No verification chip anywhere on the plan sheet (folded line, step rows, Verify sub-bullets). A step's bullet shows its reported check instead, and a reported check outranks the step's own status:
  - running check (`active`): the working ripple, even when the step is done; pause bars when the run was interrupted;
  - `passed`: the green check; `failed`: a red X; `blocked`: an amber warning;
  - `pending` or `unknown`: the step's own mark (ripple while the step is active, check when done, hollow circle when pending).
  - The bullet's label and tooltip carry the check wording and device ("Check pending on iOS / Android"), say it is agent-reported, and give the report's age (stale for waiting reports). With a safe evidence link the bullet is a button that opens it; an unsafe link is never offered. The report's detail line is unchanged.
- **Sub-agent rows as a tree.** Under a parent's card in the agent panel, each sub-agent row has a tree line from the card: a tee for every row, an elbow for the last. The row's status icon (rocket while working, check when done, question when it needs input, warning on error, sleep when watching) sits where the bullet was, before the title; nothing trails the title.
- **Sub-agent chips.** On the plan sheet, a sub-agent chip leads with its rocket or check instead of a robot icon, and nothing trails its title.
- **Sub-agent cards on the plan.** The chat's direct sub-agents are live cards in one row along the bottom of the plan sheet, folded or open, replacing the open plan's "Running:" chip row and the folded "Sub-agents" count chip. A card shows the agent panel's status glyph (rocket working, question needs you, warning stopped or failed, check done) and the sub-agent's task as a one-line title; under it, faint, the status word and what it is doing right now ("Working · Running bash: npm test", "Needs you · Waiting for your answer."), from the same live activity the delegation rows use. A finished sub-agent with nothing to report just says "Done". Cards waiting on you lead, then working, stopped, done; newest first within each. The row scrolls sideways rather than wrapping. Clicking a card opens that sub-agent's chat (on the wall, as a window there). The per-step sub-agent chips inside the open plan stay.
- **Sub-agent chat banner.** A sub-agent's chat has an accent banner across the top of the window: a robot icon, "Sub-agent of" and the parent chat's title, which opens the parent (on the Agents wall, as a window there). With the parent not in the list it reads "Sub-agent of its parent chat". The small "sub-agent" chip in the title strip stays.

## Boundaries

Display only: no change to the saved plan, verification reports, routing, providers, permissions or network access. The iPhone app is unchanged (it still shows its own verification chips).

## Status

Implemented 2026-11-06. Verified by `PlanSheet.test.tsx` (sub-agent cards: below the steps, working first, kept when folded, status mapping; no verify chips; marks per report plus the Verify roll-up; ripple for a running check on a done step and only then; check wording on the bullet; evidence only from a safe link), `SubagentBanner.test.tsx`, and hidden, off-screen Electron captures (`plan-marks-sandbox.cjs`: the marks, four tree rows with an elbow last, the rocket leading the running row, four cards below the steps, the working one first with its rocket and live activity, one-line titles, a card opening its sub-agent, the banner after clicking a row; `plan-sheet-sandbox.cjs` updated for marks). Not checked in a packaged build.
