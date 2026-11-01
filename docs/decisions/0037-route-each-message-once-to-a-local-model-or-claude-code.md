---
status: proposed
date: 2026-11-01
---

# 0037. Route each message once, before the turn, to a local model or the user's Claude Code, passing it through unchanged

## Context

A Claude Agent chat runs every message on the user's own Claude Code, often on a Claude plan. Many messages could be answered by a local model already loaded on the machine, faster, privately and without spending plan usage. Philip asked whether a router in front of Claude Code is allowed. Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (read 2026-11-01) allows a plan only through the user's own, unmodified Claude Code and forbids apps routing requests through plan credentials or handling Claude credentials; the Consumer Terms (section 3) forbid reaching the service "through automated or non-human means" without an API key. An API key or cloud account carries no such limit. The existing [Claude policy table](../../spec/product/claude-policy.md) already keeps `context_note` (Nekko adding text to what Claude Code receives) and `unattended_runs` (Claude Code turns no person started) `awaiting_approval` on a plan, and `model_routing` `unsupported` for Claude Code. Decision [0035](0035-plan-usage-on-for-claude-plans-from-claude-codes-own-output.md) rules out using plan numbers for account switching or overflow.

## Options considered

1. **No router; the user picks a chat per engine.** Safe, but the user has to open a second chat for a quick question, and most never will.
2. **A local agent that calls Claude Code as a tool or sub-agent.** Most capable: the local model plans and hands Claude Code the hard steps. On a plan it starts Claude Code turns no person sent, and writes their prompts: the non-human use the terms forbid. Fine on an API key, but a different feature.
3. **A pre-turn router with context carry on every auth.** The router picks an engine and, for a Claude Code turn, adds a summary of the local turns it missed. Better continuity, but on a plan Nekko then authors part of what Claude Code receives, the same grey area as `context_note`.
4. **A pre-turn router, one hop, the message passed through unchanged on a plan.** Each person's message goes to exactly one engine; a Claude Code turn receives the message exactly as typed; local turns stay out of Claude Code's session unless the user quotes them in. Context carry only where `context_note` is enabled (API key, cloud).

## Decision

Option 4. A routed Claude Code turn is, from Claude Code's side, the user typing their own message into it: a person started it, nothing was added, Claude Code ran it once and unmodified. Deciding *not* to send a message to Claude is no use of Claude at all. Add an `engine_routing` row to the policy table, `enabled` on all four auths, and let the existing rows enforce the plan shape: `context_note` gates any carried context, `unattended_runs` refuses an unattended turn that lands on Claude Code. `unknown` can be `enabled` because it gets exactly the plan shape. Option 2 stays out of this feature; if built, it gets its own row, `awaiting_approval` on a plan. Spec: [routing between a local model and Claude Code](../../spec/agents/routing-between-local-and-claude-code.md).

## Consequences

- Claude Code does not see local turns. The UI must say so on each local turn and give the user **Quote in message** to bring one in by hand; some follow-ups will land on Claude Code without context the user assumed it had.
- The router may never read plan usage, never choose another Claude account, never re-send to Claude Code on its own (after a weak or failed local answer, the user clicks **Send to Claude Code**), and never touch a credential. A test pins byte-identical passthrough to `claude -p` on a plan.
- `model_routing` stays `unsupported` for Claude Code: routing happens before the turn, never inside it.
- If Anthropic objects to apps choosing per message whether to send to Claude Code, this is the decision to reverse: move `subscription.engine_routing` to `awaiting_approval` (a signed override can do that without a release; the per-chat pins keep working because a pinned Claude Code chat is an ordinary Claude Agent chat).
