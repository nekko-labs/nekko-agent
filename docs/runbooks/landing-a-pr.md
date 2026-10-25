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
next `docs/decisions/` number, any new TASKS.md task ids. Each agent reads the
same `main`, picks the same "next free" number, and the collision only shows
when the second PR lands.

```
# In the task worktree created above, once your own checks pass:
git add -A   # or a scoped add; never commit .shots/ or other evidence dirs
git commit -m "..."
git push -u origin <branch>
gh pr create --title "..." --body "..."    # ready, not --draft
gh pr merge --auto                          # queue it; it merges itself when `gate` is green
```

`main` requires the merge queue and one check, `gate`. Do not merge with `--admin`:
it skips the queue, and the queue is what tests your PR against everything landing
beside it. The auto-merge workflow also queues every ready PR, so `gh pr merge
--auto` is a belt to its braces. Never add `--squash` (or another method) to it:
with a method, gh arms classic auto-merge, which waits outside the queue forever.
The queue's own setting squashes. The auto-merge workflow also runs on every push,
so a fix to a red PR re-queues itself. Every 15 minutes `queue-sweeper.yml`
re-queues a ready PR whose `gate` is green but which is not in the queue (once per
head commit, so a queue ejection by a flake heals and a real one waits for your
fix), and re-runs a red `gate`'s failed jobs once. To keep a ready PR out of the
queue, mark it draft or label it `hold`. If it is already queued, either one also
fails the group's `gate`, so the queue ejects it rather than merging it. If you need it
queued sooner, `gh pr merge --auto <n>` once `gate` is green still works.

With the `ci:macos` label, `gate` on the PR waits for the macOS runs the label turns on
in other workflows (Native iOS, Dev identity, CodeQL's Swift pass,
Decision models' CoreML job, nekkod-npm's darwin build) and fails if any of them fails,
so the PR is not queued until they are green. macOS runners queue, so that can take an
hour or more. Adding the label re-runs CI.

Native iOS runs in batches, not on every push: about a minute after a push, one run
on `ci/ios-batch` takes every open, ready `ci:macos` PR that touches iOS and merges
cleanly onto main (the largest set that also merges with each other), and reports to
each PR's head as the `Native iOS (batch)` status, which `gate` accepts
(`scripts/ios-batch.mjs`). A PR that conflicts with main gets a red status saying so;
one that conflicts only with others in the batch waits for a later batch. A red batch
marks every PR in it red: run `gh workflow run ios-native.yml --ref <branch>` on your
branch to see whether the failure is yours (a green run on the PR beats a red batch).
Preview the next batch with `node scripts/ios-batch.mjs --dry-run`.

On a PR, Native iOS checks dark mode only when the change touches colours
(`scripts/ios-theme-scope.mjs`); add `ci:theme` to force light and dark for theme work
the script cannot see. The 6-hourly run always checks both.

### Ready, not draft

Open the PR **ready** once your own verification passes (focused tests, and for UI
changes the evidence below). Do not park it in draft to watch CI: the queue waits
for CI, merges on green and ejects on red, with nobody watching. Use draft only
while you are still working, or when a named release blocker holds the PR (see
below). "CI is still running" is never a reason to stay draft.

If the queue ejects your PR, it comes back with the failing run linked. Diagnose
it like any red check below, push the fix, and it re-queues.

### When the queue holds or ejects your PR

- **A queued branch refuses pushes** (GH006, "Branches that are queued for
  merging cannot be updated"). Push a fix right after an ejection, before the
  sweeper re-queues it; if the push is refused, wait for that queue run to finish
  instead of retrying.
- **Green but never queued.** `mergeStateStatus` is `BLOCKED` with every check
  passing: usually an unresolved review thread. The common one is CodeQL's
  "improper code sanitization" on an `apps/desktop/scripts/*-sandbox.cjs` that
  splices `JSON.stringify(...)` into `executeJavaScript`; escape it with the `js()`
  helper the other sandboxes use (see `monitors-trio-sandbox.cjs`) and the thread
  resolves on the rescan. To see the blocker, call the `enqueuePullRequest`
  GraphQL mutation (the one in `queue-sweeper.yml`): it names the reason, and
  queues the PR once it is clear. Auto-merge armed with a merge method also sits
  here forever; re-arm with plain `gh pr merge --auto`.
- **No PR CI after a push** means a conflict with `main` (`mergeable_state:
  dirty`): GitHub computes no merge ref and triggers nothing. Merge `main` in.
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
gh stack merge --yes                     # queue the stack (or up to a layer)
```

Each layer is a normal PR: fast-tier CI, ready not draft, its own Unfinished work
section. Rebasing a lower layer re-runs CI on every layer above it, so keep stacks
short (2-4 layers) and finish lower layers first.

The auto-merge workflow and the sweeper only queue PRs based on `main`, so a
layer whose base is another branch is never queued. Once its parent merges,
retarget the layer to `main`, merge `main` in, and rerun
`node scripts/spec-index.mjs` if `spec/` changed. A squash-merged parent leaves
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
