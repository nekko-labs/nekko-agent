# Landing a PR

How every change in this repo goes from a worktree to `main`. [AGENTS.md](../../AGENTS.md) holds the short rules; this is the full procedure.

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

A worktree without its own `node_modules` resolves the workspace packages
(`@nekko-agent/shared` and the rest) through the primary checkout's, so builds and
tests there can run against the primary checkout's code. Run `npm ci` in the worktree
before building or testing it. The desktop typecheck reads `shared` from source either
way (`customConditions: ["source"]`, #1153).

## Start from an issue

Every feature or change is tracked as a GitHub issue in `nekko-labs/nekko-agent`, and its PR links to it. Search first (`gh issue list --search "<words>"`); file one only when none fits:

```
gh issue create --title "<what changes, in plain words>" --body "<what and why>"
```

Put the requester's prompt, screenshots or other chat context in the issue only when they said to (the app's Settings > Project management holds the same choice for its own users). Then put `Closes #<n>` in the PR description. A fix for a baseline failure links the issue for that failure.

## Always land work as a PR

The default for every change is: commit it to a branch, push, open a PR, and merge it.
Do not leave finished work sitting uncommitted in a working tree. When several
in-flight batches share the tree (parallel agents), land them together in one PR
rather than letting the tree drift further from `main`.

When you fan work out to parallel agents, hand each one its ids up front: the
next `docs/decisions/` number and its GitHub issue. Each agent reads the
same `main`, picks the same "next free" number, and the collision only shows
when the second PR lands.

```
# In the task worktree created above, once your own checks pass:
git add -A   # or a scoped add; never commit .shots/ or other evidence dirs
git commit -m "..."
git push -u origin <branch>
gh pr create --title "..." --body "..."    # ready, not --draft
gh pr merge --auto --squash                 # native auto-merge after protections pass
```

### Native PR auto-merge (decision #1855)

After the settings cutover, main requires `gate`, `native-premerge`, and resolved review threads,
not a merge queue. GitHub native auto-merge uses squash (the same method the
old queue used); never use `--admin` or force a merge. Performance checks run
on PRs when their paths are affected, and loopback integration tests run for
every PR needing a build. Both hold gate. Budgets and platform label opt-ins
are unchanged. Combined queue groups are no longer tested; the existing
non-strict required-status-check policy is unchanged.

`auto-merge.yml` runs trusted main policy with a repository-scoped App token
after PR CI completes and on PR readiness/hold changes. It checks the current
head, successful gate, main base, same repository, draft and hold before using
`gh pr merge --auto --squash --match-head-commit <sha>`. Draft/hold or an
incomplete/failed gate disables an existing auto-merge request. PR gate itself
also checks draft/hold. Forks and stacked layers are not auto-armed. App merges
trigger push/release workflows normally; the scheduled release remains a backstop.
Queue sweeper and queue repair are retired manual no-ops: no automatic reruns,
requeues or Codex dispatch. Diagnose failures before any permitted retry.

**Cutover:** land this migration with all required checks through the still-active
queue first (plain `gh pr merge --auto`). Only then remove the merge_queue rule
from ruleset 23611651 and add required `native-premerge` from GitHub Actions.
This new context depends on migrated gate, so stale green PR gates cannot merge
without the new coverage. Retain every other rule/parameter/bypass actor exactly,
and verify native auto-merge remains enabled. Keep merge_group CI compatibility
for this transition. Never release held PRs as part of the settings change.

Platform builds run nightly, not per change. With a `deploy:linux`, `deploy:windows`,
`deploy:macos`, `deploy:ios` or `deploy:android` label, `gate` on the PR waits for the
runs the label turns on (ci.yml's per-OS daemon and capture, Native iOS, Native Android,
Installers, Dev identity, CodeQL's Swift pass, Decision models' CoreML job, nekkod-npm's
darwin build) and fails if any of them fails, so the PR does not merge until they are
green. macOS runners queue, so that can take an hour or more. Adding the label re-runs CI.

Native iOS runs in batches, not on every push: about a minute after a push, one run
on `ci/ios-batch` takes every open, ready `deploy:ios` PR that touches iOS and merges
cleanly onto main (the largest set that also merges with each other), and reports to
each PR's head as the `Native iOS (batch)` status, which `gate` accepts
(`scripts/ios-batch.mjs`). A PR that conflicts with main gets a red status saying so;
one that conflicts only with others in the batch waits for a later batch. A red batch
marks every PR in it red: run `gh workflow run ios-native.yml --ref <branch>` on your
branch to see whether the failure is yours (a green run on the PR beats a red batch).
A head with a green batch is left out of later ones, so main moving can't turn it
pending and disarm auto-merge; a new push gets a new batch. Main moving
re-runs the same heads only when it changes a file Native iOS tests (a desktop-only
merge leaves the last result standing), and that new batch cancels the older run.
Preview the next batch with `node scripts/ios-batch.mjs --dry-run`.

On a PR, Native iOS checks dark mode only when the change touches colours
(`scripts/ios-theme-scope.mjs`); add `ci:theme` to force light and dark for theme work
the script cannot see. The nightly run always checks both.

### Ready, not draft

Open the PR **ready** once your own verification passes (focused tests, and for UI
changes the evidence below). Do not park it in draft to watch CI: native auto-merge waits
for CI and protections, and does not merge on red. Use draft only
while you are still working, or when a named release blocker holds the PR (see
below). "CI is still running" is never a reason to stay draft.

### A PR does not merge

- Inspect its current gate, reviews, unresolved threads, draft/hold and conflicts.
- No PR CI after a push usually means GitHub cannot compute the merge ref.
  Merge main in an isolated worktree, resolve conflicts without dropping either
  change, and push; no recovery workflow now does this for you.
- A stale worktree's node_modules can produce spurious import failures after
  merging main. Run npm ci --ignore-scripts before believing them.
- Native auto-merge is not a retry engine. Diagnose a red check; fix and push, or
  rerun once only for a named transient cause. See failing-checks.md.
- A green, ready, non-held main-base PR can be reconciled with
  `gh workflow run auto-merge.yml -f pr=<number>` after cutover; this does not
  rerun checks or bypass protection. Read the workflow result.

### Big features: stack them

When a feature is more than one reviewable change (roughly: several hundred lines,
or a part that can land before the rest), split it into a stack with GitHub's
stacked-PR CLI instead of one large PR or a chain of drafts (the old queue-specific stack merge command is not the native landing path):

```
gh extension install github/gh-stack     # once per machine
gh stack init                            # first layer, based on main
# commit layer 1, then:
gh stack add <next-branch>               # each layer builds on the one below
gh stack submit                          # one PR per layer, linked as a stack
gh stack sync                            # after main or a lower layer moves
# Verify and merge the main-base layer using native auto-merge, then retarget the next.
```

Each layer is a normal PR: path-gated PR CI, ready not draft, its own Unfinished work
section. Rebasing a lower layer re-runs CI on every layer above it, so keep stacks
short (2-4 layers) and finish lower layers first.

The auto-merge workflow only arms PRs based on `main`, so a layer whose base is
another branch is never auto-merged. Once its parent merges,
retarget the layer to `main` and merge `main` in. A squash-merged parent leaves
its original commits in the child's history, so git's merge conflicts wherever
both layers touched the same lines; a three-way `git merge-file` per file, using
the parent commit the child was built on as the base (not git's merge-base),
resolves most of them cleanly. The app's **Continue as stacked
PR** action creates the same native stacks from an agent chat.

## PR descriptions must record unfinished work

Every PR description includes an explicit **Unfinished work / release blockers**
section. List incomplete scope, known bugs, unsupported platforms, missing tests
or visual evidence, and verification limitations with concrete next steps. Write
"None" only when verified. Keep the section current after each pushed batch;
notes only in chat, review comments, or local files are not sufficient.

Read back the published description to verify the update succeeded. If publishing
fails, report the failure and preserve the pending description locally; do not
claim the notes are published.

An entry in this section is not by itself a reason to stay draft. Residual notes
(a platform not checked, a tuned pixel offset, a test that already fails on
`main`) are recorded and the PR lands. Only a **release blocker** holds a PR:
the change breaks something that worked, a required check is red because of this
PR, the evidence this repo requires for the change is missing, or the user said
to wait. Name which one applies when you keep a PR draft.

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
6. **Queue it.** Open the PR ready (or `gh pr ready <n>` once verification is
   done) and let the queue merge it. A draft never merges: the auto-merge
   workflow only queues ready PRs.
