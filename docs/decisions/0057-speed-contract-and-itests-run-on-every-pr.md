# 0057: The speed contract and itests run on every PR

- Status: accepted (supersedes [0056](0056-no-merge-queue-speed-contract-and-itests-run-nightly.md)'s nightly-only speed contract and itests; the rest of 0056 stands)
- Date: 2026-11-06
- Decided by: Philip

## Context

[Decision 0056](0056-no-merge-queue-speed-contract-and-itests-run-nightly.md)
removed the merge queue and moved the speed contract (`perf`) and the loopback
itests to the nightly full run, with `perf` on a PR only with the `ci:perf`
label. Before that, the queue ran both on every group that could affect them, so
a regression in either was stopped before `main`.

With no queue, a PR's own `gate` is the last check before `main`. Nightly-only
coverage means a speed or itest regression lands, sits on `main` until the next
nightly run, and is then nobody's PR: whoever lands after it inherits a red
nightly run and has to bisect it. #1856 proposed running both suites on every PR;
0056 deferred that because of the cold-chat paint flake.

## Decision

Run both suites on every PR again, path-gated the way the queue tier ran them
(`scripts/ci-scope.mjs`), and make `gate` wait for both:

- `perf` runs on a PR that changes what it measures (`scripts/perf/`, the
  renderer, the Local Web UI, `packages/`, the Rust crates), when CI itself or
  the changed-file list is unknown, or with `ci:perf`.
- `itests` run on every PR that needs `build` (everything but a change only to
  the native phone apps).
- The nightly full run keeps both, on every OS.

Everything else in 0056 stands: no merge queue, native auto-merge (squash) on
`gate`, draft and `hold` disarm auto-merge. No ruleset change: `gate` stays the
one required check, and it now covers both suites.

## Consequences

- A regression the speed contract or the itests can see is stopped on its own
  PR, where the author is still around to fix it.
- PRs that touch a measured path wait longer: `perf` builds a release `nekkod`
  and measures up to three attempts (a 25-minute job limit), and the itests
  build `nekkod` and run the loopback scripts (a 30-minute limit). Both run beside
  `build`, not after it.
- Until the cold-chat first-paint flake (#712) is fixed, `perf` fails on
  unchanged code about half the time: 17 of the 35 queue runs that ran it on
  2026-11-05/06 failed only on that row, and the last two nightly runs did too.
  Those PRs go red until `queue-sweeper.yml`'s one re-run or a hand re-run
  passes. That is accepted rather than weakening the 33 ms gate; fixing #712 is
  the remedy. A PR whose only red row is the cold-chat paint, and that does not
  touch that path, is the known flake (see
  [failing checks](../runbooks/failing-checks.md)).

## Alternatives

- Keep 0056 (nightly only): rejected; it lets regressions reach `main` with no
  owner, and with no queue there is nothing else between a PR and `main`.
- Restore the merge queue to run them once per group: rejected; 0056's reasons
  (ejections, four pieces of automation to keep it moving) still hold.
- Raise or skip the cold-chat paint budget on PRs: rejected; budgets are not
  weakened to get past a flake (#712 tracks the fix).
