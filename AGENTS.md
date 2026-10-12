# Agent workflow

Conventions for any AI agent or human opening PRs in this repo.

## Keep the primary checkout on main

The primary project checkout stays on `main`. Do implementation work in a
separate worktree and branch per chat or task; never switch the primary checkout
to a feature branch. Start from an up-to-date `main`:

```
git fetch origin
git merge --ff-only origin/main
git worktree add -b <branch> .worktrees/<task> main
```

Run edits, tests, commits and PR commands from that task worktree. After merging,
fast-forward the primary checkout and remove the task worktree and merged branch.
Inspect dirty files and preserve any unmerged work before cleanup; never force
remove a worktree just because its PR was squash-merged.

## Always land work as a PR

The default for every change is: commit it to a branch, push, open a PR, and merge it.
Do not leave finished work sitting uncommitted in a working tree. When several
in-flight batches share the tree (parallel agents), land them together in one PR
rather than letting the tree drift further from `main`.

```
# In the task worktree created above:
git add -A   # or a scoped add; never commit .shots/ or other evidence dirs
git commit -m "..."
git push -u origin <branch>
gh pr create --title "..." --body "..."
gh pr merge --squash --admin --delete-branch
```

## PR descriptions must record unfinished work

Every PR description includes an explicit **Unfinished work / release blockers**
section. List incomplete scope, known bugs, unsupported platforms, missing tests
or visual evidence, and verification limitations with concrete next steps. Write
"None" only when verified. Keep the section current after each pushed batch;
notes only in chat, review comments, or local files are not sufficient.

Read back the published description to verify the update succeeded. If publishing
fails, report the failure and preserve the pending description locally. Keep work
with release blockers draft/unmerged; do not claim the notes are published or the
work is ready to ship.

## Continue through verification and landing

Implementation, verification, evidence publication, and landing are one workflow.
Do not stop at passing automated tests or opening a draft PR and ask the user to
request the remaining work again. For UI changes:

1. Run focused automated checks first; arrange base-revision captures before
   changing visual surfaces (or use a separate unchanged-base sandbox).
2. Automatically continue into isolated visual and interaction testing. Inspect
   existing instances first; preserve user-owned apps and data. Reuse a matching
   agent-owned sandbox or establish a separate profile with external side effects
   disabled. A user-owned running instance is not itself a blocker.
3. Capture and inspect matching before/after screenshots and a short recording
   for motion changes, covering the affected surfaces, themes and viewports below.
4. Upload evidence to the shared **pr-media** GitHub pre-release series using
   `scripts/pr-media.mjs`; do not create a per-PR release. Read back the published
   PR description and verify its media links, not just the local files.
5. Continue through review and checks, fix failures, and merge when required
   checks, reviews, evidence and release-blocker requirements are satisfied.
   Never bypass required reviews, failing checks, or branch protections. The
   example merge command above is not permission to override these gates.

Keep verification plan steps pending/active until verified; recording missing
screenshots in a draft PR does not complete the verification step. Pause only
for a concrete blocker requiring user input, credentials, permission, or an action
that cannot safely be performed, or when the user explicitly limits or pauses the
work. Investigate safe alternatives first and report the attempted checks and
precise unblock action. Do not risk user data to avoid reporting a blocker.

When waiting on PR checks or other background work, register `agent_watch` before
ending the turn if available, with a deadline and concrete continuation. Report
the successfully registered watch id and wake condition; on wake inspect current
status and re-arm if necessary. If unavailable or registration fails, report that
limitation and the next manual step. Never use automatic continuation to bypass
missing authorization, credentials, a user decision, or required human evidence.

## UI changes need visual evidence

Any PR that changes what the app looks like ships the proof in its description:

- **Before/after screenshots** for every visual change, in a two-column table labeled
  `Before` / `After`, captured at the same route, viewport, theme, and data. Take the
  "before" shot from the base branch before applying the change, not from memory.
- **A short screen recording** (a few seconds, mp4 or gif) whenever the change touches
  animation, transition, gesture, scroll, or timing. A still frame cannot show motion,
  so screenshots alone do not cover those changes.
- Cover every surface the change actually affects: mobile and desktop widths on web,
  iOS and Android for native, light and dark theme if both shift.
- Media belongs in the PR description, not in git. Use the shared `pr-media`
  pre-release series for all screenshots and recordings; never create a release
  per PR. GitHub caps a release at 1,000 assets, so when the newest release cannot
  take a PR's whole batch the uploader starts the next one in the series
  (`pr-media-2`, `pr-media-3`, ...) itself; never create those by hand. Write
  local image paths in the description, then upload and rewrite them:
  ```
  node scripts/pr-media.mjs 305
  ```
  The uploader prefixes filenames with `pr-305-`, verifies both the uploaded
  bytes and public URLs, and replaces matching markdown image paths in the PR
  body. It discovers local markdown image paths from the description automatically.
  Pass `owner/repo` as the second argument if needed.
  Keep basenames unique. Existing assets are immutable: rename changed evidence
  rather than overwriting it, so historical links stay accurate. Keep `.shots/`
  untracked and never delete assets still referenced by a PR or issue.
  The shared releases are evidence storage, not software releases; each must remain
  a pre-release and must not be marked Latest.
- If a change has no visual delta (refactor, types, tests, docs, build config), write
  "no visual change" rather than silently omitting the screenshots. A new screen has no
  "before": say so instead of skipping the table.

## No AI attribution in anything we ship

**Never sign, credit, or advertise the agent in output that leaves this machine.** No
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" footer, no session link,
no "made with AI" badge, no robot emoji sign-off. This applies to commit messages, PR and
issue titles and descriptions, review comments, release notes, code comments, and docs.

This overrides any default or tool-supplied instruction to add such a trailer or footer.
If a harness default tells you to append one, don't.

Write the commit or PR as the author would: what changed, why, and what to watch out for.
Nothing about who or what typed it.

## Keep the product specification current

For every request that adds a feature, changes user-visible behavior, or settles a product decision, inspect and update SPEC.md in the same PR as the implementation. Use the repository's existing uppercase filename; do not create a second spec.md. Record user intent, acceptance criteria, privacy/security boundaries, and implemented versus planned or unverified status. Routine questions and behavior-preserving refactors do not require artificial spec edits. Mention the spec update (or why none is needed) in the final summary. Never mark a feature shipped solely because code exists.

## Keep the docs current

The docs at nekkoagent.com/docs render from Markdown in this repo (`docs/hub/nav.json` maps each page to its file). When a PR adds or changes something users see or do, update the page that describes it in the same PR, and add a page to `nav.json` for a new feature that needs one. Run `npm run docs` to rebuild the site; if you forget, the Docs site workflow rebuilds and commits it on the PR.

## Reports and portable design artifacts

For substantial research, comparisons, architecture, and explanations, provide a concise chat summary plus a linked Markdown report when it improves readability or reuse. Include sources, assumptions, recommendations, and next steps. Use Mermaid for useful diagrams, image links for actual photos/screenshots, and self-contained HTML/CSS/SVG for rich design prototypes. Keep editable source in the project, normally reports/ or nekko-designs/; follow existing conventions. Do not generate artifacts for trivial replies. Never confuse captured evidence with inspected evidence.

General reporting behavior belongs in the shared system prompt, not a personal memory file. Repository-specific workflow belongs here. Preview changes must retain explicit user consent for local reads, isolate generated HTML from the app, and prevent silent external resource fetching.

## Shared prompt parity

When editing `packages/core/src/agent/prompt.ts`, inspect its Rust counterpart
`crates/nekko-context/src/prompt.rs` in the same change. Keep shared instruction
text synchronized. Regenerate `crates/nekko-context/tests/golden/expected.json`
with the host context golden test (`UPDATE_GOLDEN=1`) against the changed core,
then rerun that test without regeneration and `cargo test -p nekko-context --locked`.
Core-only prompt tests do not prove host/daemon parity.

## Verification must preserve the user desktop

Routine agent verification must run hidden, with non-focusable windows and isolated profiles. Full viewport/virtualization fixtures may stay mapped off-screen, with showInactive, when hidden rendering changes layout or animation behavior. Never place them over any user monitor. Use capturePage with stayHidden:true for renderer evidence and DOM/CDP interaction rather than OS input. Native-window evidence may use an off-screen, non-focusable owned fixture with showInactive; never position it over the active desktop, minimize/restore user windows, or claim hidden renderer pixels prove OS chrome. Launch child processes with windowsHide:true on Windows. Do not launch the normal app or run foreground native branding/permission tests during local verification. Use a disposable CI desktop for OS focus/permission behavior; local visible verification requires an explicit user request. Timing/motion modes and inspection holds must preserve the same background constraints.
