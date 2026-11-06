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
gh pr merge --auto --squash                 # it merges itself when `gate` is green
```

`main` requires one check, `gate`, a PR, and resolved review threads. There is no
merge queue (removed 2026-11-06, [decision 0056](../decisions/0056-no-merge-queue-speed-contract-and-itests-run-nightly.md)):
a PR merges itself through GitHub's native auto-merge (squash) as soon as `gate`
passes. With no queue, `gate` on the PR is the last check before `main`, so it
also waits for the speed contract (`perf`, when the PR touches what it measures:
the renderer, the Local Web UI, `packages/`, the Rust crates or `scripts/perf/`;
`ci:perf` forces it) and the loopback itests (every PR that needs `build`)
([decision 0059](../decisions/0059-speed-contract-and-itests-run-on-every-pr.md)).
Both also run nightly. Until #712 is fixed, `perf` misses the cold-chat paint
budget on unchanged code about half the time; see
[failing checks](failing-checks.md). Do not merge with `--admin`: it skips `gate`.

The auto-merge workflow arms auto-merge on every ready PR into main, so `gh pr
merge --auto --squash` is a belt to its braces. It also runs on every push, so a
fix to a red PR merges itself once `gate` goes green. Every 15 minutes
`queue-sweeper.yml` arms auto-merge on a ready PR whose `gate` is green but which
has no auto-merge request, and re-runs a red `gate`'s failed jobs once.
`queue-repair.yml` picks up what is left: it merges `main` into a conflicting PR
(settling conflicts in the append-only files by rule), and hands a code conflict
or a `gate` still red after the re-run to Codex with a `@codex` comment. If Codex
is not set up or does not push a fix within an hour, the PR gets the
`needs-human` label; your next push clears it. (Both files keep their queue-era
names.) To keep a ready PR from merging, mark it draft or label it `hold`: the
auto-merge workflow turns auto-merge off for either, and back on when you mark it
ready or remove `hold`.

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
pending and hold its `gate`; a new push gets a new batch. Main moving
re-runs the same heads only when it changes a file Native iOS tests (a desktop-only
merge leaves the last result standing), and that new batch cancels the older run.
Preview the next batch with `node scripts/ios-batch.mjs --dry-run`.

On a PR, Native iOS checks dark mode only when the change touches colours
(`scripts/ios-theme-scope.mjs`); add `ci:theme` to force light and dark for theme work
the script cannot see. The nightly run always checks both.

### Ready, not draft

Open the PR **ready** once your own verification passes (focused tests, and for UI
changes the evidence below). Do not park it in draft to watch CI: auto-merge waits
for CI and merges on green, with nobody watching. Use draft only
while you are still working, or when a named release blocker holds the PR (see
below). "CI is still running" is never a reason to stay draft.

### When a green PR does not merge

- **Green but not merging.** `mergeStateStatus` is `BLOCKED` with every check
  passing: usually an unresolved review thread. The common one is CodeQL's
  "improper code sanitization" on an `apps/desktop/scripts/*-sandbox.cjs` that
  splices `JSON.stringify(...)` into `executeJavaScript`; escape it with the `js()`
  helper the other sandboxes use (see `monitors-trio-sandbox.cjs`) and the thread
  resolves on the rescan. `gh pr view <n> --json mergeStateStatus,reviewDecision`
  and the PR page name the blocker.
- **A stack's bottom layer is never merged by the bots.** The auto-merge workflow
  skips PRs not based on main. Once its `gate` is green, run `gh stack merge <pr>
  --yes` yourself.
- **No PR CI after a push** means a conflict with `main` (`mergeable_state:
  dirty`): GitHub computes no merge ref and triggers nothing. Merge `main` in,
  or let `queue-repair.yml` do it within 15 minutes.
- **A `@codex` comment you did not write** is `queue-repair.yml` asking Codex to
  fix the PR. Pushing your own fix first is fine: a new commit supersedes it.
- **Typecheck fails on a new import after merging `main`**: your worktree's
  `node_modules` is stale. Run `npm ci --ignore-scripts` before believing it.

### Big features: stack them

When a feature is more than one reviewable change (roughly: several hundred lines,
or a part that can land before the rest), split it into a stack with GitHub's
stacked-PR CLI instead of one large PR or a chain of drafts:

```
gh extension install github/gh-stack     # once per machine
gh stack init                            # first layer, based on main
# commit layer 1, then:
gh stack add <next-branch>               # each layer builds on the one below
gh stack submit                          # one PR per layer, linked as a stack
gh stack sync                            # after main or a lower layer moves
gh stack merge --yes                     # merge the stack (or up to a layer)
```

Each layer is a normal PR: fast-tier CI, ready not draft, its own Unfinished work
section. Rebasing a lower layer re-runs CI on every layer above it, so keep stacks
short (2-4 layers) and finish lower layers first.

The auto-merge workflow and the sweeper only arm auto-merge on PRs based on `main`,
so a layer whose base is another branch never merges by itself. Once its parent merges,
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
6. **Let it merge.** Open the PR ready (or `gh pr ready <n>` once verification is
   done) and let auto-merge land it. A draft never merges: the auto-merge
   workflow only arms ready PRs.
