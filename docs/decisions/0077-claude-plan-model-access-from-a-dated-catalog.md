---
status: proposed
date: 2026-11-10
---

# 0077. What a Claude plan includes for Fable comes from a dated catalog, and Claude Code's own windows win over it

## Context

Fable is not included in Claude plans the way other models are. On Pro it runs on usage credits. On Max, Ultra and premium seats it is included up to 50% of the weekly usage, then credits. On Free it is not offered. Launch offers change this for days at a time: Fable 5.2 is included on Pro until 16 November 2026, 23:59 Pacific. The Claude Agent picker listed Fable for every plan with nothing beside it, so a Pro user learned the cost only afterwards.

Nekko already knows the plan type, because `claude auth status` prints `subscriptionType`. It also already shows plan usage, sourced only from what the unmodified Claude Code printed ([0035](0035-plan-usage-on-for-claude-plans-from-claude-codes-own-output.md)).

## Options considered

1. **Hide or disable Fable per plan.** This is wrong whenever the rule changes (offers, new plans), and it decides for Anthropic: a Pro user with credits can run Fable.
2. **Hard-code the current rules and edit them by hand when they change.** An offer's end then depends on someone shipping a release on the right day.
3. **A dated catalog with `from`/`until` instants, a source and a review date per rule, overridden by Claude Code's live windows.** This is a label and a notice only, never a block.
4. **Read Anthropic's plan endpoint for the truth.** The terms forbid this, because it uses the user's Claude login outside Claude Code.

## Decision

Option 3.

- `CLAUDE_PLAN_RULES` holds the rules. Known changes take effect by themselves at their instant (UTC). A rule older than 60 days says "Check your plan" instead of making a claim.
- The composer notices ("close to your Fable limit", "from here Fable uses your usage credits") come from Claude Code's model-scoped window first and the catalog second.
- A spent Fable window on an account with credits is shown as runnable on credits in the picker. The shared availability, and Auto with it, still treats it as spent, so Auto never moves a turn onto credits.

## Consequences

- No new data leaves the machine and no new source is read. The basis is the same as 0035's: showing what the user's own Claude Code reported, plus public plan pages.
- An unforeseen change still needs a release until signed policy overrides carry the catalog. That needs the release signing key ([claude policy](../../spec/product/claude-policy.md)).
- If Anthropic objects to apps describing plan terms, remove the labels. The catalog is the only place they live.
- Proposed, pending Philip's review: this extends what Nekko says about a Claude plan.
