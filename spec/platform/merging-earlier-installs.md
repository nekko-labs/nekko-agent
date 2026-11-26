---
title: "Merging earlier installs"
area: platform
---

# Merging earlier installs

**Status: [implemented; the runner and data-folder rules below implemented 2026-11-26, not yet verified on a real old profile].** Code: `packages/profile/src/legacy-profiles.ts`. How it was built: [legacy profile consolidation](../../docs/legacy-profile-consolidation.md).

## Intent

Earlier names of the app each left a data folder behind. On launch the desktop app offers to fold them into the current data folder (**Merge and clean up**, **Merge, keep old copies**, **Not now**); `nekko-agent migrate` does the same from a terminal. A person should end up with one folder holding everything they made, and never lose something because it lived in an old one.

## Acceptance criteria

- Nothing in the current data folder is overwritten: on a clash the current copy wins and the old one stays where it was.
- An old folder is deleted only when everything a person made in it is in the current folder. A file that could not be placed keeps the whole old folder, and the result names it.
- What counts: settings, sign-ins, chats, usage history, memory, models, CI runners, and every other known data folder (skills, plugins, voice, computers, sandboxes, workflow checkouts and the rest).
- What does not: one machine's caches, downloads and running state (`desktop`, `run`, `logs`, `bin`, `runtime`, `fonts`, `agent-browser`), a runner's per-install state (`install-id`, `memory.json`, `vms`), and a runner's unfinished image builds, replaced images and downloads (`images/*.new`, `*.old`, `cache`, `*-cache`). These are deleted with the old folder.
- CI runners: records merge by id, the current one winning. An image moves when the current folder has none of that name; one it has supersedes it. Other runner JSON files (such as the key file used where there is no OS keychain) gain the keys the current one lacks, and keep the old folder until it has them all. Rotated VM console logs move when missing; one that clashes does not keep the old folder. The merge result says how many runners came over. The backup keeps the old `runners.json`.
- A moved file is rewritten only when it holds a path into the old folder; anything else (a checkout's `package.json`) keeps its exact bytes.
- A backup of the changed small files is written before the first change.

## Known limits

- A runner's GitHub App key lives in the OS keychain, filed under the data folder it was saved from. A runner merged from a folder with a different keychain scope keeps its record, repos, label and image, but may ask for **Connect GitHub** again. Moving keychain items is not built.
- A browser profile (`desktop`, `agent-browser`) cannot be merged, so sign-ins inside the agent's browser in an old folder are not carried over.

## History

- 2026-11-26: **Merge and clean up** deleted a CI runner because the merge and its safety check only knew root files, `sessions`, `models`, `memory` and `engine` ([#3482](https://github.com/nekko-labs/nekko-agent/issues/3482)). Since then every known data folder is merged and checked.
