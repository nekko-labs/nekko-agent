---
title: "Issue per change and work tracking preferences"
area: code
---

# Issue per change and work tracking preferences

Added 2026-10-23. Every agent chat whose work lands as a PR tracks that work as an issue: before opening the PR it finds the issue for the feature or change, or files one (GitHub Issues through `gh` or the GitHub connector, or the tracker the project already uses, such as Linear or Jira), with a plain-language title and the what and why. The PR then links to it (for example `Closes #123`). Since 2026-11-14 this covers any work that changes something, not only PR work (below).

## Issue first for any work, broken down

Added 2026-11-14. Issue-first is the default for any work that changes something (code, docs, configuration, a document, a chore), not only work that ends in a PR. Before starting, the agent finds the issue for the work or files one. Work of more than one real step is broken into small pieces that can each be done and checked on their own: a checklist in the issue, or sub-issues under a parent issue for pieces someone could pick up separately. The agent ticks checklist items off as they land, links a PR to its issue, and closes an issue that needed no PR once its work is done. Questions, explanations and chats that change nothing file nothing. When the work has no tracker the agent can reach, it says so once and carries on rather than inventing one. The "file an issue for each change" toggle still turns all of this off.

## Assign the issue while working on it

Added 2026-11-12. So everyone on a project, people and other agents alike, can see what is being worked on and nobody picks up the same work twice, the agent checks who is assigned before starting and assigns the issue to the account doing the work as soon as it starts on it (`gh issue edit <number> --add-assignee @me` on GitHub, or the tracker's equivalent), whether it found the issue, filed it, or the user named it. This applies to every user and every chat that tracks work as an issue; it is part of the base system prompt, not a setting, and it follows the "file an issue for each change" toggle (off means no issue, so nothing to assign).

- An issue already assigned to someone else is not taken over: the agent tells the user and lets them decide.
- If the agent stops without opening a PR, it unassigns itself and leaves a short comment saying where the work stands, so the issue does not look taken when it is not.
- Merging the linked PR closes the issue; the assignee stays as the record of who did it.

## What goes into the ticket

The user decides, once, whether their own material goes into issues and PR descriptions:

- **Issues** (Settings > Project management): file an issue for each change (on by default), include my prompt, include my screenshots, include other chat context (attachments, pasted logs, a short summary).
- **Pull requests** (Settings > Pull requests): link each PR to its issue (on by default), watch each PR until it is merge-ready (on by default; see [Watch PRs until they are merge-ready](../agents/watch-prs-until-merge-ready.md)), include my prompt, include my screenshots.

The first-run wizard asks these as quick toggles on its **Work tracking** step, with every include off until checked; Next saves explicit answers, so the agent never asks again. A user who skipped the step, or predates it, has the include choices unset: Settings shows them as a dash with "Not set yet: Nekko asks the first time", and the agent asks in the first chat that needs the answer, the same way it already asked about PR images.

## How it reaches the agent

- The default (file and link an issue, ask before including the user's material) is part of the base system prompt (`crates/nekko-context/src/prompt.rs`).
- Explicit choices become a "Work tracking preferences" block inside the custom system instructions, one line per answered choice (`work_tracking` in `crates/nekko-turn/src/plan.rs`), shown in the Context Inspector too. Unset choices add nothing.
- Sandboxed (container) chats leave the block out, as they do the user's own instructions.

## Boundaries

- Never secrets, credentials or unrelated personal data in an issue, whatever the toggles say. User-sent screenshots stay distinct from the agent's own verification evidence.
- The agent does not invent a tracker: it uses the one the project already has, and falls back to GitHub Issues for a GitHub repository.

## Status

Implemented: prompt default, settings, both Settings sections, onboarding step, unit and render tests, hidden-window screenshots. Not verified: a live chat filing an issue end to end against a real repository. Issue assignment (2026-11-12): prompt text and golden fixtures only; not yet seen in a live chat. Issue first for any work and breaking it down (2026-11-14): prompt text and golden fixtures only; not yet seen in a live chat.
