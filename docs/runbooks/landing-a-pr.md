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
queue, mark it draft or label it `hold`. If you need it queued sooner, `gh pr merge
--auto <n>` once `gate` is green still works.

### Ready, not draft

Open the PR **ready** once your own verification passes (focused tests, and for UI
changes the evidence below). Do not park it in draft to watch CI: the queue waits
for CI, merges on green and ejects on red, with nobody watching. Use draft only
while you are still working, or when a named release blocker holds the PR (see
below). "CI is still running" is never a reason to stay draft.

If the queue ejects your PR, it comes back with the failing run linked. Diagnose
it like any red check below, push the fix, and it re-queues.

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
short (2-4 layers) and finish lower layers first. The app's **Continue as stacked
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
