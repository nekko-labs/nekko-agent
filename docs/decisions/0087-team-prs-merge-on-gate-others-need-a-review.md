---
status: accepted
date: 2026-11-11
---

# 0087. PRs from nekkolabs-devs merge on a green gate; everyone else's need one review

Issue: [#2605](https://github.com/nekko-labs/nekko-agent/issues/2605). Builds on [0056](0056-no-merge-queue-speed-contract-and-itests-run-nightly.md).

## Context

The main ruleset required no approvals, and auto-merge.yml arms auto-merge on every ready PR, so a PR from any collaborator with write access merged as soon as `gate` went green. The repo has outside collaborators with write access besides the nekkolabs-devs team. Philip wants the team's PRs to keep landing with nobody watching, and everyone else's to wait for a review.

## Options considered

1. **Ruleset bypass for the team.** Bypass is granted to whoever merges, not to the PR's author, so it would let a team member merge anyone's PR unreviewed, and auto-merge (armed by a bot) would not use it at all.
2. **A custom required check that passes for team authors or an approval.** Exact, but it has to re-run on every review event, and a fork's review event gets no secrets to read team membership with.
3. **Require one approval, and approve team PRs automatically.** GitHub's own review rule does the enforcing; a `pull_request_target` workflow approves a PR whose author is an active member of nekkolabs-devs, with the repo's GitHub App.

## Decision

Option 3.

- The main ruleset requires 1 approving review. `gate` and resolved threads stay required.
- `team-auto-approve.yml` approves a ready PR into main when its author is an active nekkolabs-devs member, on open, reopen, ready and push, unless the App's approval already stands. `workflow_dispatch` walks every open ready PR.
- It never checks out the PR, so `pull_request_target` runs only main's code.
- Team membership needs the App's organization permission "Members: read". When the lookup fails, nothing is approved: the PR waits for a person.
- PRs from anyone else, including the runtime-updates App itself (an App cannot approve its own PR), need a person with write access to approve. Auto-merge is still armed, so they merge once that review and `gate` are in.

## Consequences

- Team members work as before.
- A collaborator with write access can still run a workflow from their own branch with the repo's secrets, so this is a process rule, not a security boundary. Contributors who should not be able to get around it should work from forks with read access.
- Runtime-update PRs now wait for a review.
