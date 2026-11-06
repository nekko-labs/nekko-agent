---
status: accepted
date: 2026-10-28
---

# 0033. Mods may run agent tools, behind a permission and the tool policy

## Context

Mods are code written by other people, run in a sandboxed frame with a permission-checked bridge ([0032](0032-three-layers-and-the-nekko-package.md)). The question was how far that bridge reaches. Reading and starting chats lets a mod build dashboards and shortcuts. Running agent tools (shell, file edits, browser, MCP tools) lets a mod build new functionality, at the risk of a mod being as dangerous as an agent with YOLO on.

## Options considered

1. **UI and chats only.** The most a mod can do is start or message a chat. Anything that runs tools has to go through an agent the person can watch.
2. **Agent tools behind a permission.** A `tools:run` permission lets a mod ask the engine to run tools directly.

## Decision

Option 2 (Philip, 2026-10-28), with these limits:

- `tools:run` is the highest-risk row in the install sheet, worded as "This mod can run commands and change files on this computer, like an agent can".
- Every call goes through the engine's tool policy with the mod as the actor. Each mod has its own policy, which starts at **Ask** whatever the person's chat default is.
- Calls are limited to folders the person picks for that mod, and each run is logged in the activity log under the mod's name.
- Turning a mod off stops every tool run it started.
- Credentials, the engine token and settings other than the mod's own are refused to mod-originated calls, even through tools.

## Consequences

- The engine needs a mod actor in its tool policy and activity log (CUI-10).
- The Verified review matters most for mods that ask for `tools:run`. An unverified mod asking for it gets the strongest warning the app shows.
- If people grant `tools:run` without reading, the next step is a per-run confirmation that cannot be turned off for unverified mods.
