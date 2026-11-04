---
status: accepted
date: 2026-11-04
---

# 0048. Keep the spec index and the task log out of PRs

## Context

`main` requires the merge queue, and many agents land PRs in parallel. Two files changed in most of them:

- `spec/README.md`, the generated spec index. Every line carries its file's size, so any edit to a spec file that moved its size by a KB rewrote the index. 111 of the 231 merges into `main` from 2026-10-28 to 2026-11-04 touched it.
- `TASKS.md`, where each change added its task group at the top. 62 of the same 231 merges touched it, all inserting at the same few lines.

Two PRs that both touch either file conflict as soon as the first lands. The queue then shows "Merge conflicts", ejects the second, and it waits until someone (usually the agent session that opened it, often long gone) merges `main` back in. On 2026-11-04 two of six queued PRs (#1674, #1686) were stuck this way, both on `spec/README.md`.

## Options considered

1. **Keep both, resolve the conflicts automatically.** A bot can regenerate the index after a merge, but the task log needs a human or a model to reorder entries. Treats the symptom.
2. **One file per task entry** (the changesets pattern). No conflicts, but hundreds of tiny files, and it duplicates the GitHub issue every change already has.
3. **Generate the index on demand; make the issue the task.** The index is printed by `node scripts/spec-index.mjs` and written to a gitignored `spec/INDEX.md`. `TASKS.md` keeps only the technical plan, which changes rarely. A change's plan notes live in its issue (one per change is already the rule), and how it was built lives in its PR. Floop already imports the issues.

## Decision

Option 3. Every change already has an issue, so the task log duplicated it, and the index is cheap to compute. `spec/README.md` becomes a static guide, and the task log up to 2026-11-04 is frozen verbatim in `docs/history/tasks-archive.md`, which is where the task IDs that code comments cite (IO-20, AN-32, T185, ...) now resolve. CI still validates every spec file's frontmatter (`node scripts/spec-index.mjs --check`, through `npm test`).

## Consequences

- PRs that add or edit spec files, or record their task, no longer conflict with each other on shared files.
- Browsing the index on github.com is gone; the area folders under `spec/` remain browsable, and the script prints the index in well under a second.
- Task history now spans two places: the archive (up to 2026-11-04) and issues plus PRs (after). Floop's planned two-way GitHub sync makes the issues the one view.
- PRs open when this lands conflict on `spec/README.md` and `TASKS.md` one last time; take `main`'s version of both and move a dropped task note into the PR's issue.
- If agents start adding task lists back into `TASKS.md`, or skip the issue, this was wrong: the rule lives in AGENTS.md, "Landing work".
