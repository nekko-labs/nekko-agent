---
title: "Fusion routing and model capability tiers"
area: chat
---

# Fusion routing and model capability tiers

Implemented and locally verified in [PR #2737](https://github.com/nekko-labs/nekko-agent/pull/2737), tracking [#2731](https://github.com/nekko-labs/nekko-agent/issues/2731). Design: [editable canvas](../../nekko-designs/fusion-router-design.html).

## Intent and permission

Choosing a ChatGPT model must not silently choose a local provider for its delegates. Model selection, provider-switching permission, and relative model capability are independent.

- A pinned model or **Auto · this provider** keeps automatic replies and subagents on that configured provider/account.
- **Fusion** explicitly enables both existing per-chat flags: `autoModel: true` and `autoProviderSwitch: true`. Both must be true booleans; missing flags, stale switching flags on a pinned model, and the global subagent preference do not grant permission.
- The daemon requires Fusion for *every* change of configured provider, including cloud-to-cloud, local-to-local, agent-supplied targets, saved exact routes, and resuming a child. It checks the persisted parent and target before discovery/creation/admission. A same-provider exact model remains allowed without Fusion.
- Cloud-only, offline/incognito, endpoint/provider/model validation, and sandbox restrictions still win. Fusion does not clear privacy settings. Explicit cross-provider picks in a non-Fusion chat fail visibly without starting a child or silently replacing that exact route.
- Automatic local preferences in a non-Fusion chat resolve on the current provider instead. The Subagents control explains this effective boundary.
- Picking a concrete model or Auto from the composer clears stale `autoProviderSwitch`. Selecting Fusion enables the two flags without rewriting global privacy defaults.

## Strategies

`AppSettings.fusion.strategy` applies to Fusion chats in the shared desktop/local-web renderer; selecting a strategy does not enable Fusion on any chat. Invalid/missing values use `balanced`.

| Strategy | Ranking |
| --- | --- |
| Balanced | Rules classify a quick task as Small or above, a complex task as Medium or above. Prefer the closest suitable tier, then known per-turn cost. |
| Economical | Same task suitability floor; prefer the lowest known per-turn cost first, then the closest tier. Unknown prices are not assumed free. |
| Quality first | Prefer the strongest available classified tier, then known cost. |
| Local first | Prefer a suitable local model before cloud, then closest tier and known cost. A too-small local model does not satisfy a complex task. |
| Capacity fallback | Keep the current provider while it can serve; when spent/blocked, find a ready alternative at or above the home model's capability. |

Eligibility precedes ranking: enabled and permitted providers, chat-capable model, model availability, provider limits, privacy restrictions, and the existing restriction against overflowing onto Claude Code. Loaded status, favorites and the home provider break remaining ties deterministically. A route reason names strategy, task complexity, capability, provider and loaded status when applicable. A Fusion pool with no eligible classified model returns no pick, not a fabricated runnable route.

These are deterministic rules. No extra classifier call, telemetry or credential disclosure is introduced. Existing same-provider Auto quality profiles and messaging Auto's legacy ranking remain unchanged unless the user explicitly assigns a model tier.

## Capability scale

Settings → Agents → **Fusion routing → Model capability tiers** lists chat models by provider and offers search, override and reset.

| Tier | Meaning |
| --- | --- |
| Small | Lightweight requests and focused workers; suggested for Haiku/mini/nano/flash and small parameter-count models. |
| Medium | Everyday coding/synthesis; suggested for Sonnet and medium parameter-count models. |
| Large | Harder multi-step work; suggested for Opus and larger models. |
| Frontier | Optional top capability tier; suggested for Fable and very large parameter-count models, or explicitly assigned. |

This is a workload-relative heuristic, not benchmark evidence or a promise that parameter count determines intelligence. Shared `model-tiers.json` supplies the same suggestion rules to TypeScript and Rust. Small variants are matched before their parent family. The UI distinguishes **Suggested**, **Your classification**, and **Unclassified**. Unknown models are excluded from explicit tier routing until classified; an exact pick can still use one. Reset deletes the user override rather than persisting today's guess.

Storage: `fusion.modelTiers` maps `providerId::modelId` to `small | medium | large | frontier`. Provider/account-scoped keys prevent one provider's classification from changing another's same-named model. Existing settings without this object require no migration.

## Subagents

The existing global Auto / same-provider / prefer-local / inherit / exact-model choices remain. `orchestration.subagentTier` adds `small | medium | large | frontier | smaller` (missing means smaller). A tier target selects that tier, then the nearest smaller eligible tier, never automatically exceeding the parent's capability. Loaded status breaks ties, rather than silently replacing a requested Medium with a loaded Small. Default Auto only considers already-loaded local models; prefer-local may use an unloaded model, but only in Fusion. With no eligible automatic choice, the parent model is inherited; exact picks never fall back.

Legacy default same-provider Auto keeps its established top-family downshift (including the closest-family/name preference) when no tier settings exist. Explicit tier targets and classifications use the new scale. Claude Code uses its existing `CLAUDE_CODE_SUBAGENT_MODEL` mechanism: Small → Haiku, Medium → Sonnet, Large/Frontier → Opus, capped by the parent's tier. A Frontier alias is not invented for the installed CLI.

## Verification and scope

Acceptance includes both-flag truth tables, stale flags, explicit and saved routes, Cloud-only, resume after consent removal, provider-scoped classification/reset, small variants, unknown/non-chat models, all strategies, and local Small versus Medium targets. UI evidence uses synthetic production-component fixtures at matching 1200px/390px light/dark viewports with a disposable profile, denied external network and no real user data.

All 4,611 shared/desktop TypeScript tests, desktop build/typecheck, both daemon permission/tier regressions, six subagent tests and messaging/turn contract suites pass. Thirty-six isolated Electron assertions pass; narrow light/dark and wide layouts plus recorded scroll frames were inspected. Sixteen PNGs and two GIFs are published with verified URLs in PR #2737. One unrelated context-preview token golden fails identically on base, tracked in [#2736](https://github.com/nekko-labs/nekko-agent/issues/2736), with its assertion unchanged. No live cloud/local inference or packaged-app verification is claimed. Native phone clients do not expose these controls. Headless messaging continues its same-provider Auto route; the new cross-provider strategy controls belong to the shared renderer, not a new engine-wide headless scheduling service. A model-based classifier and measured latency/benchmark-driven tiering remain planned extensions, not implemented options.
