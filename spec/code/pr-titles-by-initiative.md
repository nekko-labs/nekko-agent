---
title: "PR titles name their initiative"
area: code
---

# PR titles name their initiative

Added 2026-11-27 (#3581). A project's PR list reads as a flat stream of hundreds of changes. Grouping PRs by the initiative or goal they serve (Fleet, Nekko Cloud, Optimizations, CI, ...) shows at a glance what each body of work has landed. A platform prefix alone ("iPhone:", "Android:") says where a change is, not what it is for.

## What the agent does

By default, an agent opening a PR titles it `<Initiative>: <what changed>`, for example `Optimizations: Android: write saved chats off the main thread` or `Nekko Cloud: Sync: each chat belongs to the computer that started it`.

- The initiative is the body of work the change belongs to: a feature area, a product or a goal such as Optimizations, CI or Security & Privacy. It is never just the platform the change touches.
- Before naming one, the agent looks at the repository's recent PR titles and reuses an initiative they already use, so the set stays small and stable.
- A narrower prefix the title already had stays after the initiative (`Optimizations: Android: ...`); words the initiative repeats are dropped.
- A change that serves no initiative keeps a plain title.

## The project's own convention wins

The default applies only when nothing already sets a title convention. The agent follows, in their place:

- the project's guidelines and agent instructions (AGENTS.md, CLAUDE.md and the others the app loads),
- the user's work tracking preferences and custom instructions,
- the convention the repository's recent PR titles already follow (for example Conventional Commits `feat(ui): ...`).

## How it reaches the agent

A rule in the base system prompt (`crates/nekko-context/src/prompt.rs`), in the large and medium prompt profiles. The small profile leaves it out, as it leaves out the rest of the PR process. It is not a setting: a user or project that wants another convention states it in its guidelines or instructions, which take precedence.

This repository uses the same convention, with its initiative list in [the landing runbook](../../docs/runbooks/landing-a-pr.md#title-a-pr-by-its-initiative). The author's PRs from November 2026 were retitled to it.

## Status

Implemented: prompt rule (large and medium), a unit test, golden fixtures. Not verified: a live chat opening a PR with an initiative title, or deferring to a project's own convention.
