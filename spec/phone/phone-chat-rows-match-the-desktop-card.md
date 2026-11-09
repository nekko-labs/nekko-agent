---
title: "Phone chat rows read like the desktop's agent card (2026-11-09)"
area: phone
---

# Phone chat rows read like the desktop's agent card (2026-11-09)

`[Implemented 2026-11-09 on iOS and Android, in source. The rules (model name, provider mark, context window and tone, which PR leads the chip) are unit-tested on both: ChatCardTests (Swift) and ChatCardTest (Kotlin), plus Android's RowPrsTest for the PR lookup. The Kotlin tests were run; the Swift tests and both apps' builds await macOS and Android CI, and native screenshots are pending]`

## User intent

Philip asked (2026-11-09) that the phone apps' chat rows match the desktop's agent cards more closely: the provider icon and model, the context window for chats in progress, and PR chips with their quantity and status. The same request asked for the brand logos on the Connectors page ([connectors](iphone-connectors-and-pull-requests.md)).

## What a row shows

The desktop's card is the reference ([agent panel view options](../agents/agent-panel-view-options.md), `WorkspaceCard.tsx`, `SessionPrChip.tsx`). Under the title, in this order:

- **Provider mark and model.** The provider's logo, tinted like the model's words (the accent), then the model as the desktop names it: *Opus 5.5*, *Sonnet 4.5*, *Fable 5.1* for a Claude id (past a gateway's `vendor/` and Bedrock's `anthropic.` prefixes); other ids lose their vendor, `:latest` and date (*qwen3-coder*). The mark comes from the provider's kind in the computer's `providers:list` (the phone's own providers for a chat on this iPhone): Anthropic for Claude API, Claude Agent, Bedrock and Foundry; OpenAI for OpenAI, ChatGPT and Codex; Google for Gemini and Vertex; OpenRouter, Ollama (local and cloud), LM Studio and vLLM. An OpenAI-compatible endpoint or llama.cpp shows no mark, as on the desktop. When the phone doesn't hold that computer's provider list (an iPhone chat on a computer not in view), a model id that can only be one vendor's names it (`claude-*`, `gpt-*`, `o1`/`o3`/`o4`, `gemini-*`); a gateway id (`anthropic/claude-…`) shows no mark, since it says nothing of the provider.
- **Context window, while in progress.** `45k/1M`: the computer's own figures for a Claude Agent chat, else the transcript estimate against the model's window (the computer's figure, else the desktop's `guessContextWindow`). Green below 60%, amber from 60%, red from 85% (`fillTone`). Shown only while the chat is in progress: working, waiting on you, stopped on an error (iPhone), or idle with a watch armed. A finished or completed chat leaves it off, as the desktop's Done cards do. Screen readers hear "Context window 45 percent full".
- **PR chip, bottom right.** One chip for all the chat's PRs: the one that matters most (open, then draft, then merged, then closed; then the newest in the same repository), with GitHub's glyph for its state (Gentleface, as the desktop's chip) in its hue (open green, draft faint, merged in the accent, closed in danger), `#123`, and `+N` in faint ink for the others. The row opens the chat, whose PR chip opens each PR; screen readers hear every PR and its state.

**View → Card details** turns Model, Context window, Pull requests and Last updated off independently. On iOS it expands inline inside the View-options popover, just like Show: native switches stay in the same Form instead of opening a nested popup. Changing one field leaves the others unchanged; all four choices persist across relaunch. [Implemented in source for #2380; native all-switch/persistence acceptance remains unverified. Older matched screenshots were inspected and show the nested-menu defect versus the inline switches, not a full interaction pass. Automatic run42578121066 on PR merge ref33669d3e compiled the corrected spoken-label and bounded-Form driver, but every switch remained on after the parent-row center tap. Its AX tree records each wide labeled Switch row containing the actual smaller switch. The driver now targets that native child with existence, frame-containment and hittability preconditions, preserving all field-independence, hidden-field and relaunch assertions. This driver correction still requires fresh native execution; previous failing runs remain failures.]

## PR state on Android

Android now asks the computer for the state of each PR a row names (`pr:sessionList`, read only), as the iPhone does: chats that name a PR, 8 at a time, again when the chat moves on or names another PR, and every five minutes; a failed lookup is asked again next time (`RowPrs`). Until the computer answers (or while it can't be reached), the chip shows the chat's newest link and count untinted, so a row never loses its PRs offline. The iPhone shows the chip once the state is known, as before.

## Acceptance criteria

- Both phones name models, choose marks, guess windows, tone the gauge and pick the leading PR by the same rules, held to the same cases (ChatCardTests / ChatCardTest).
- No context gauge on a finished or completed chat; one on a working, waiting, watching (and, on the iPhone, failed) chat with tokens used.
- A chat with several PRs shows one chip with `+N`, never a list of numbers.
- No new permission, storage or network use beyond Android's read-only `pr:sessionList`, which the iPhone already makes.

## Assets

Provider marks: the desktop's Lobe Icons (MIT) as iOS template SVGs (`ProviderMarks`) and Android vector drawables (`provider_*.xml`). PR glyphs: Gentleface 0.3.0 (MIT) line glyphs (`PrIcons`, `pr_*.xml`), the same as the desktop's chip. Listed in [ASSETS.md](../../ASSETS.md).

## Not yet

- Native screenshots of the new rows on both phones.
- The desktop also uses the model catalog's own context length; the phones use the computer's reported window or the desktop's guess.
