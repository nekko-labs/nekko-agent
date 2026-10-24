---
title: "Issue per change and work tracking preferences"
area: code
---

# Issue per change and work tracking preferences

Added 2026-10-23. Every agent chat whose work lands as a PR tracks that work as an issue: before opening the PR it finds the issue for the feature or change, or files one (GitHub Issues through `gh` or the GitHub connector, or the tracker the project already uses, such as Linear or Jira), with a plain-language title and the what and why. The PR then links to it (for example `Closes #123`). Questions and chats that open no PR file nothing.

## What goes into the ticket

The user decides, once, whether their own material goes into issues and PR descriptions:

- **Issues** (Settings > Project management): file an issue for each change (on by default), include my prompt, include my screenshots, include other chat context (attachments, pasted logs, a short summary).
- **Pull requests** (Settings > Pull requests): link each PR to its issue (on by default), include my prompt, include my screenshots.

The first-run wizard asks these as quick toggles on its **Work tracking** step, with every include off until checked; Next saves explicit answers, so the agent never asks again. A user who skipped the step, or predates it, has the include choices unset: Settings shows them as a dash with "Not set yet: Nekko asks the first time", and the agent asks in the first chat that needs the answer, the same way it already asked about PR images.

## How it reaches the agent

- The default (file and link an issue, ask before including the user's material) is part of the base system prompt (`crates/nekko-context/src/prompt.rs`).
- Explicit choices become a "Work tracking preferences" block inside the custom system instructions, one line per answered choice (`work_tracking` in `crates/nekko-turn/src/plan.rs`), shown in the Context Inspector too. Unset choices add nothing.
- Sandboxed (container) chats leave the block out, as they do the user's own instructions.

## Boundaries

- Never secrets, credentials or unrelated personal data in an issue, whatever the toggles say. User-sent screenshots stay distinct from the agent's own verification evidence.
- The agent does not invent a tracker: it uses the one the project already has, and falls back to GitHub Issues for a GitHub repository.

## Status

Implemented: prompt default, settings, both Settings sections, onboarding step, unit and render tests, hidden-window screenshots. Not verified: a live chat filing an issue end to end against a real repository.
