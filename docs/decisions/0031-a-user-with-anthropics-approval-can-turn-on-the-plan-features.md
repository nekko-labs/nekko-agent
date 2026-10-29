---
status: accepted
date: 2026-10-28
---

# 0031. A user with Anthropic's own approval can turn on the Claude plan's gated features, behind a warning

## Context

On a Claude plan through the user's own Claude Code, four capabilities are built and tested but `awaiting_approval` ([spec](../../spec/product/claude-policy.md)): unattended runs, Nekko tools, the context note and plan usage. The 2026-10-19 design said only Nekko could turn them on, through a reviewed release or a signed policy, "never by a user-flippable toggle". Some users have Anthropic's approval themselves (an agreement of their own), and for them the product refused features they are allowed to use. Nekko's own approval request to Anthropic is still open.

## Options considered

1. **Keep Nekko-only.** Safe for Nekko, but blocks users who are allowed, with no way through but an API key.
2. **One switch per capability.** Finer, but an approval from Anthropic is about the user's use, not one flag, and four switches multiply the places the warning has to be read.
3. **One switch, always-visible warning, enforced in nekkod.** Moves every `awaiting_approval` `subscription` row to enabled for that install, never an `unsupported` or `unknown` row.

## Decision

Option 3. The setting is `claudePlanFeaturesApproved` in Settings > Agents, off by default, literal `true` only. nekkod applies it on every gate (`ClaudePolicyStore::policy()`), so the renderer and the daemon cannot disagree. The warning says to turn it on only with Anthropic's written approval, that Anthropic can limit or suspend an account that breaks its terms, and that Nekko cannot check and the decision is the user's.

## Consequences

- Nekko no longer fully controls what runs on a plan: a signed override that moves a row back to `awaiting_approval` does not reach a user who has the switch on. That is accepted as the user's call.
- `unknown` still fails closed, so a turn before `claude auth status` is read stays refused even with the switch on.
- If Nekko's own approval request is granted, the signed override (once a release key exists) turns the rows on for everyone and the switch becomes redundant; remove it then.
- If Anthropic objects to a user-side switch at all, this is the decision to reverse.
