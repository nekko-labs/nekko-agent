---
title: "Subagent model preference (Auto by default)"
area: agents
---

# Subagent model preference (Auto by default)

`[implemented 2026-11-10, #2487; daemon unit tests for the pick and the Claude Code launch, renderer unit tests for the control; not yet seen with a live model delegating, nor captured in the packaged app]`

## Why

Every `spawn_agent` call that named no model ran its child on the parent's model, and Claude Code ran its sub-agents on whatever the chat ran. A chat on Opus that fanned out four workers paid for five Opus contexts at once, which used up a plan's allowance quickly. The requester asked for a Subagents preference in the model selector, listing cloud and local models with a search, Auto by default, with Auto variants "default, prefer same provider, prefer local".

## What the user sees

- The model selector's popover ends with a **Subagents** row naming the current choice. It opens in place to a search field and a list: **✨ Auto** (marked Default), **✨ Auto · same provider**, **✨ Auto · prefer local**, **Same model as the chat**, then every chat model of every enabled provider under **Cloud** and **Local**, with the loaded dot on local models. The search filters choices, models and provider names.
- Settings › Agents shows the same control under **Subagent model** (it replaces the old Delegation route provider and model dropdowns).
- The choice applies to every chat. It is hidden on **Solo** and in a sub-agent's own chat.

## What each choice does

When a `spawn_agent` call names no `provider_id`/`model_id`:

- **Auto** (default, also when unset): a lighter model than the chat's on the same provider, one step down from a top-tier model (Opus or Fable to Sonnet, `gpt-5` to `gpt-5-mini`), the closest relative by name and then the newest. A chat on ✨ Auto (the Nekko router, which already routes between cloud and local) first uses a local model that is already loaded, so nothing new is loaded for it; otherwise its child keeps routing on ✨ Auto.
- **Auto · same provider**: the lighter model, never leaving the chat's provider; a chat on ✨ Auto keeps its child on ✨ Auto.
- **Auto · prefer local**: a local chat model on this computer (loaded first, then the strongest), else the same-provider pick. Choosing it is the user's opt-in for a cloud chat's sub-agents to run locally; a cloud-only chat still cannot.
- **Same model as the chat**: the old behaviour.
- **A specific model**: saved as the delegation route (`orchestration.delegationRoute`). It is checked against the provider's model list before each delegation and never falls back, as before.

An auto pick never names a stronger model than the parent's. When the parent is not top tier, nothing lighter is listed, or the list cannot be read, the child inherits the parent's model: no error, and never a move to another cloud provider. A model the agent names explicitly still wins. The agent is told the preference in the routing prompt ("Omit provider_id and model_id to use the user's sub-agent model preference: …").

**Claude Code chats** run their own sub-agents, so the preference reaches them as `CLAUDE_CODE_SUBAGENT_MODEL` at launch: `sonnet` under an Auto choice when the chat runs Opus or Fable, the saved model when the route is on a Claude Code provider, nothing otherwise (Claude Code's own default). A changed preference starts a new Claude Code child at the next message, as a model change does. Whether the installed Claude Code honours the variable for every sub-agent type is not verified here.

**Fewer delegates.** The advisory parallel cap (`orchestration.maxParallel`, in the prompt as "keep concurrent sub-agents to about N") now defaults to 2 instead of 4 for settings that never saved one.

## Data

`orchestration.subagentModel`: `auto` | `auto-same-provider` | `auto-local` | `inherit` (unset is `auto`). `orchestration.delegationRoute` wins when set. Code: `crates/nekkod/src/subagent_model.rs` (the pick and the Claude Code variable), `spawn.rs` (`auto_target`), `nekko-turn` `plan.rs` (the prompt line), `apps/desktop/src/renderer/components/SubagentModelControl.tsx`.

## Not verified

- A live delegation picking the lighter model, and Claude Code honouring the variable.
- Visual capture of the control in the selector and in Settings.
- The phones do not show or change the preference yet.
