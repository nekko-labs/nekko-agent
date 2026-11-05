---
title: "First-run setup (planned onboarding wizard)"
area: brand
split-from: SPEC.md (2026-10-22)
---

# First-run setup (planned onboarding wizard)

The first launch opens a calm, full-screen setup wizard over the app; every step can be skipped (a per-step **Skip**, plus **Skip setup**), and it never auto-shows again once dismissed (Settings can replay it). Four skippable steps:

1. **Theme.** System-match, Light, Dark, and a set of elegant tech presets, each shown as a circle filled with a gradient of its palette so the choice is visual, not a word list. Clicking previews live.
2. **Providers.** Two groups: **online** (ChatGPT leads with one-click *subscription* sign-in so a Plus/Pro plan works without metered API fees; Claude takes an Anthropic API key, with the Claude Agent card joining it in the harness release; plus OpenRouter and a generic OpenAI-compatible endpoint) and **local** (auto-discovery surfaces running Ollama / LM Studio / vLLM servers for one-click add, and an **Nekko Agent** card offers the app's own managed local-model path).
3. **Integrations.** Two groups: **use Nekko inside other tools**, which installs the app as an MCP subagent into detected agent CLIs (Claude Code, Codex, Cursor) with one click, and **connect your apps** (GitHub, Linear, Slack, Discord, Jira, Teams, Gmail, Drive) so workflows and context can reach them.
4. **Work tracking.** Quick toggles for whether agent chats file an issue per change and link the PR to it (both on), and whether the user's prompt, screenshots or other chat context go into issues and PRs (all off until checked). See [issue per change](../code/issue-per-change.md).

## Independent palette and mode (desktop and Local Web UI)

User intent: every offered theme should have light and dark modes, without the mode control replacing the chosen palette. Theme choices should be compact circles, and Custom colors should no longer fill the page or have a card border.

Acceptance: Nekko, Nebula, Terminal, Nord, Ember, Forest, Blueberry and seasonal Spooky retain their identity in either mode. Selecting a palette keeps the current mode. Switching mode preserves each custom accent independently, while shipped accents adapt for readability. Existing preset IDs and settings remain valid; fresh profiles still follow the computer until a choice is made. No network calls, new permissions or data migration are introduced.

Status: mode-resolution and settings-patch helpers are implemented and unit-tested for both directions, reload, defaults, retired colors, custom channels and readable light accents. Picker/store integration and the compact sun/moon switch, circular controls and reduced-motion feedback are planned in the next stack layer. Native iOS/Android pickers are outside this desktop renderer change.
