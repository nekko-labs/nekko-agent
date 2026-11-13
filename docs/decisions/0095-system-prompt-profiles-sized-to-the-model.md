---
status: accepted
date: 2026-11-14
---

# 0095. Size the system prompt to the model with three profiles

## Context

One built-in prompt went to every model: about 3.4k tokens of instructions (`o200k_base`), much of it pull request, CI and visual-verification process that a small local model cannot act on. A local model with an 8k window spent most of it on instructions and tools before the user typed. Only `settings.systemInstructions` customized it, for every model alike. Issue #2593. Philip's concept: frontier models need fewer, shorter rules than small local models need, or the reverse of what one prompt gives.

## Options considered

1. **One prompt, user edits it.** No engine change. Every user must know to trim it per model; small models stay mis-served by default.
2. **Three copies of the prompt.** Simple to select, but a fix to a rule must be made three times and the copies drift.
3. **Three profiles built from one list of rules, picked per model.** Each rule declares its text per profile (or none). Selection is automatic from the size signal Auto already uses plus the context window, with user override per model and per provider.

## Decision

Option 3. Large is today's prompt, unchanged, so frontier behavior and the frozen prompt fixtures do not move. Medium shortens the process rules. Small drops them and keeps short forms of the rules that prevent harm (issue tracking so agents do not duplicate work, honest wrap-up, diagnose failures). Selection: override for the model, override for the provider, a context window under 16k is Small, a large or frontier model is Large, a local model rated small is Small, everything else is Medium. Quick cloud models (Haiku, mini) stay Medium: they have the window and the skill for the working rules, and the size signal only means "cheap" there. A user's system instructions append to every profile. Details and measured sizes: [the spec](../../spec/context/model-sized-system-prompts.md).

## Consequences

Small is about 14 percent of Large's tokens (483 against 3,367). Medium is the default for a model the rules cannot place. Anyone who changes a rule edits one declaration. Follow-ups: an Inspector line and a Settings screen for the override and per-profile additions or replacement; measuring Small against Medium on ~8B and ~32B local models (task success, valid tool calls, tokens in), and shipping Small as the automatic choice only if it wins. Wrong if Small loses to Medium on small models: then select Medium for them and keep Small opt-in.
