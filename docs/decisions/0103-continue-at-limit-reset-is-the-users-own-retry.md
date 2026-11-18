---
status: accepted
date: 2026-11-15
---

# 0103. Continuing a chat when its usage limit resets is the user's own Retry, on a Claude plan too

Issue: [#2811](https://github.com/nekko-labs/nekko-agent/issues/2811). Related: the Claude policy table ([spec](../../spec/product/claude-policy.md)), where `unattended_runs` (scheduled tasks, workflows, goals, watches, auto-continue) is awaiting approval on a Claude plan.

## Context

A reply that runs into a used-up usage limit leaves a Reply failed notice with Retry. Philip asked for a button in that notice that continues the chat by itself when the limit resets. The limit is usually a Claude plan's session limit, and on a plan the policy table holds unattended runs until Anthropic approves them, so a resumed turn marked `unattended` would be refused at admission.

## Options considered

1. **Remind only on a plan.** At the reset, a notification says the limit reset; the user presses Retry. Keeps the plan row untouched but does not do what was asked.
2. **Disable the button on a plan,** with the policy's reason. The main case gets nothing.
3. **Treat it as attended.** The user pressed the button for this one chat, so the resumed turn is their Retry, only delayed, plus a reminder when it runs.

## Decision

Option 3 (Philip, 2026-11-15: "treat as attended if they click the button and also send a reminder").

- The resumed turn is sent without `unattended` and without `autoContinue`: admission does not apply the `unattended_runs` gate, and usage counts it as the user's.
- It is one turn for one chat, set by a press in that chat's notice, and it fires once. A second failure leaves a plain Retry.
- A `limit_reset` event is posted when it runs, and the desktop shows it as a reminder.
- Nothing else changes: workflows, watches, goals and the context auto-continue stay gated on a plan.

## Consequences

- On a Claude plan, the chat carries on after the reset with nobody at the keyboard, on the strength of the earlier press. If Anthropic's terms are read to cover this, the fix is to send this turn with `unattended: true`, which brings it under the plan row again.
- It was wrong if a turn ran without a press in that chat, ran more than once per press, or ran after the user retried, dismissed or cancelled.
