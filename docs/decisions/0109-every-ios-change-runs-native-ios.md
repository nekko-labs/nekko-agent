# 0109. Every iOS change runs Native iOS

Date: 2026-11-20. Status: accepted. Issue: #3094.

## Context

`gate` required the iOS simulator suite only on PRs with the `deploy:ios` label, and `main` ran it only nightly. iOS changes without the label merged after the fast checks alone (#2952, #3026), and so did admin merges (#2946, #2947). Each left `main`'s suite red, and the failure surfaced days later on an unrelated labelled PR, which then could not merge. A test that failed early in the suite hid the rest for three days (#2936). Intermittent tests (#2454, #2965, #3060, #3061, #3062, #3093) made a fully green four-shard run rare on top of that.

## Decision

- **An iOS change needs Native iOS, label or not.** `gate` and the iOS batch take every PR that touches iOS (`IOS_PATHS` in `scripts/ios-batch.mjs`). `deploy:ios` still starts a run on the PR itself, and the other `deploy:*` labels stay opt-in.
- **`main` runs Native iOS after each merge that touches iOS.** One run at a time: a newer merge waits instead of cancelling the running one, so a red run names a small set of changes. A red run comments on the merged PR.
- **Known-intermittent tests are quarantined, not deleted.** `apps/ios/UITests/quarantine.txt` lists them with their issues. PRs, batches and main runs skip them; the nightly run still runs them. A test that fails deterministically is fixed, never listed.

## Consequences

More iOS PRs join batches, and every iOS merge costs one more suite on the 5 shared macOS runners. Quarantined tests stop guarding PRs until their issues are fixed. The nightly run and those issues are what keeps them honest.
