---
status: accepted
date: 2026-11-01
---

# 0035. A Claude plan shows its usage limits, read only from what the user's own Claude Code printed

## Context

On a Claude plan, `usage_limits` was `awaiting_approval` ([spec](../../spec/product/claude-policy.md)), so the data path (Claude Code's `rate_limit_event` and `/usage` report, parsed into `SubscriptionLimits`) was built but showed nothing. Anthropic's terms ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-11-01) forbid an app offering Claude sign-in, routing requests through plan credentials, handling Claude credentials or tokens, and modifying Claude Code. Nothing in them restricts showing what the unmodified Claude Code reports about the user's own plan. That is the same footing as the plan sheet reading Claude Code's own `TodoWrite` and task calls (#1401).

## Options considered

1. **Keep it off until Anthropic approves.** Safest, but holds back a display that touches no credential and changes nothing Claude Code does.
2. **Read the plan usage endpoint or plan headers.** More complete and fresher, but that uses the user's Claude login outside Claude Code, which the terms forbid.
3. **Turn it on, sourced only from Claude Code's own stream.** Shows what Claude Code printed, when it printed it.

## Decision

Option 3. `subscription.usage_limits` is `enabled` in the shipped table (TS and Rust mirror, golden fixture). `unknown` keeps it `awaiting_approval`: a sign-in Nekko has not read still fails closed. The renderer reads it through the ordinary limits path with the key `claude-code:<provider id>` (`limitsKeyFor`), which nekkod answers from `claude:planUsage`'s source, so the chat's usage chip, the Models card and the phone show it like any other plan.

## Consequences

- Plan usage is only as fresh as Claude Code's last report. Nekko never sends `/usage` on its own (that would be automated use of the plan) and never reads a plan endpoint, header or credential.
- The numbers must never drive automatic account switching or overflow onto another plan: getting around plan limits is what the terms rule out. Auto already never moves a turn onto a Claude Agent.
- If Anthropic objects to apps showing plan usage at all, this is the decision to reverse: move the row back to `awaiting_approval` (a signed override can do that without a release).
