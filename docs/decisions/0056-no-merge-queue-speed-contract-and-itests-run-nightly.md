# 0056: No merge queue; the speed contract and itests run nightly

- Status: partly superseded by [0059](0059-speed-contract-and-itests-run-on-every-pr.md) (2026-11-06): the speed contract and itests run on every PR again; the rest (no merge queue, native auto-merge, draft and `hold` disarm it) stands
- Date: 2026-11-06
- Decided by: Philip

## Context

`main` required GitHub's merge queue from 2026-10-17. The queue tier added the
speed contract (`perf`) and the loopback itests to every group, so a regression
in either was stopped before `main`. Keeping the queue moving took four pieces of
automation (auto-merge.yml's enqueue, queue-sweeper.yml, queue-repair.yml and the
label gate's group check), and its most common failure was the speed contract
flapping on unchanged code (#704), which ejected PRs that had nothing to do with
it. #1856 proposed moving both suites onto every PR instead.

## Decision

Remove the `merge_queue` rule from the `main` ruleset (done 2026-11-06; the rest
of the ruleset is unchanged: a PR, the `gate` check, resolved review threads, no
force pushes or deletion). PRs merge through GitHub's native auto-merge (squash)
once `gate` passes. The speed contract and itests run in the nightly full run,
and on a PR only with the `ci:perf` label (the speed contract) or a hand
dispatch. Draft and `hold` keep a PR from merging by disarming auto-merge.

## Consequences

- Faster, steadier landing: no queue ejections, no flaky `perf` on PRs that do
  not touch it.
- A speed or itest regression can reach `main` and is caught by the next nightly
  run, which opens or updates the `ci-scheduled` issue. A PR that changes a path
  the speed contract measures should carry `ci:perf`.
- Two PRs that pass `gate` separately are no longer tested together before
  merging; `gate` does not require an up-to-date branch. A semantic conflict
  between them shows up on the next PR's CI or the nightly run.
- `hold` and draft are enforced by auto-merge.yml disarming auto-merge, not by a
  required check. A person with merge rights can still merge a held PR by hand.

## Alternatives

- Keep the queue (status quo): rejected for the cost and flakiness above.
- Run the speed contract and itests on every PR (#1856): rejected for now; it
  puts the #704 flap on every PR's critical path. Revisit once that flap is fixed.
