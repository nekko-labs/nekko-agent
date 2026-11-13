---
title: "System prompts sized to the model (small, medium and large profiles)"
area: context
---

# System prompts sized to the model (small, medium and large profiles)

Requested by Philip (issue #2593). A frontier model does not need the guidelines and detail a small local model does, and a small model's short context window cannot spare the room. The built-in system prompt therefore comes in three profiles, picked per model. Why this scheme: [decision 0095](../../docs/decisions/0095-system-prompt-profiles-sized-to-the-model.md).

## Profiles

- **Large**: every rule, in full. Byte-identical to the prompt every model had before profiles.
- **Medium**: the working rules; the pull request, design and verification process is shortened or left out (no UI-verification, CI, `agent_watch` or design-versioning detail). The short forms keep the issue-tracking rule (find or file the issue, check who is assigned, assign yourself, link the PR) and the Unfinished work / release blockers rule.
- **Small**: who Nekko is, use tools instead of guessing, one-line forms of the principles, the issue rule in two sentences, short ask-first and plan guidance. No PR, CI, Mermaid, design-artifact or verification process.

**Automatic sizing ships off.** The profiles exist and are tested, but with no `promptProfiles` setting every model gets Large, byte-identical to today's prompt. Automatic sizing is enabled only by `promptProfiles.auto: true`, and becomes the default only when the measurement in #2593 shows Small beats Medium on ~8B and ~32B local models.

Each rule is declared once with the text it has in each profile (or none), so a fix to a rule lands everywhere it applies. `settings.systemInstructions` (and the work tracking preferences) still append to every profile.

## Choosing the profile

Order: the user's per-model setting, the user's per-provider default, then the automatic rule when `promptProfiles.auto` is true; otherwise Large ("Large: automatic sizing is off").

- Settings `promptProfiles`: `{ "auto": false, "models": { "<providerId>::<modelId>": "small|medium|large|auto" }, "providers": { "<providerId>": "small|medium|large|auto" } }`. `auto` is the same as unset.
- Automatic (only with `auto: true`): no model chosen: Large. A known context window under 16,000 tokens: Small ("Small: 8k context"). A model Auto rates tier 5 or up, or the shared capability rules call large or frontier: Large. A local or unknown-size server (llama.cpp, Ollama, LM Studio, vLLM, OpenAI-compatible) whose model is rated small (about 13B and under): Small. Everything else, including quick cloud models such as Haiku and mini: Medium.
- The reason string rides with the turn's facts and the Context Inspector preview (`promptProfile: { profile, reason }`).

## Status

Implemented: the profiles, the selection logic with automatic sizing off by default, `promptProfiles` (including `auto`) in settings, the preview field, tests for selection and for each profile's content.

Planned, not built: showing the reason in the Context Inspector; a Settings screen with a tab per profile (built-in text read-only, "Your additions", and an advanced "Replace the built-in prompt" with Reset); a per-model override in the model's settings; trimming Large. Unverified: whether Small beats Medium on small local models (task success, valid tool calls, tokens in). The measurement run (a ~8B and a ~32B local model and a frontier model, each profile, results in `docs/perf-history.md`) is tracked in #2771; automatic sizing stays off until it shows Small winning.

## Open questions for Philip (not decided)

1. Automatic tier from the model with a per-model override, or should the user always pick? (Proposed in #2593: automatic plus override.)
2. May users replace the built-in text, or only add to it? (Proposed: add by default, replace behind an advanced toggle.)
3. Should Large be shorter than today's prompt, or keep today's text for Medium and Large at first and only add Small? (Proposed: start with Small against today's prompt, measure, then trim Large.)

The build so far follows the proposals only where they cost nothing to reverse: overrides exist, replace and a shorter Large do not.

Not covered: Claude Agent chats (Claude Code uses its own prompt), the per-turn server instructions (unchanged for every profile), and tool definitions.

## Measured sizes

Built-in text with `o200k_base` tokens (the prompt with `ask_user` and `update_plan` offered adds the second figure):

| Profile | Instructions | With ask and plan guidance |
| --- | --- | --- |
| Small | 483 | 732 |
| Medium | 1,904 | 2,371 |
| Large | 3,367 | 3,834 |
