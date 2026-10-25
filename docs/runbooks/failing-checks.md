# Failing checks

What to do when a required check is red, on your PR or on `main`, and how long to keep investigating before reporting a blocker.

## When a check fails on `main` too

The repo's required check is `gate`, which passes when every job its run needed
passed. CI runs in three tiers (`scripts/ci-scope.mjs`):

| Tier | When | Runs |
| --- | --- | --- |
| PR | every push to a PR | `build`; `daemon` on Linux if Rust or `packages/{host,core,shared}` changed; `capture` on Windows if desktop code or `packages/` changed |
| Queue | `merge_group` | the PR tier, plus `daemon` on Windows and `perf` when the group changes what it measures |
| Full | every 6 hours (skipped if `main` has not moved), or `gh workflow run ci.yml --ref <branch>` | every job on every OS, macOS included |

The same goes for every other macOS job (native iOS, the mobile iOS build,
dev identity, nekkod darwin, decision-model CoreML, CodeQL Swift): scheduled, or
`ci:macos` on the PR. Add `ci:macos` to a PR that changes macOS-specific code (`cfg(target_os =
"macos")`, the dev bundle, signing, native capture), and `ci:perf` to one that
changes a hot path the speed contract measures and wants the numbers before
queueing. Labels are read when a run starts: add the label, then push. A skipped
job is not a missing check. A failed 6-hourly run opens or updates the
`ci-scheduled` issue; whoever lands the next fix to that area clears it.

When one of them is red:

1. Diagnose the failing step. If the failure is in something this PR touches, fix it.
2. Otherwise compare against `main`: the same job on the merge-base commit, or the
   most recent full runs (`gh run list --workflow ci.yml --event schedule`). If
   `main` fails the same way on the same metric, the failure is a baseline problem.
3. A baseline failure is not this PR's fault, but in the queue it blocks every
   group that runs that job, so it is the most urgent thing in the repo. Make sure
   an issue exists (search first, file one if not), then fix it forward or revert
   the commit that caused it, in its own small PR, before re-queueing yours.
   Record it in this PR's Unfinished work with the run that proves it. Do not
   weaken a budget or delete a check to get past it; recalibrating a noisy gate
   from measured data is a separate, explicit decision (see `docs/perf-history.md`).
4. A failure that only this PR produces is a release blocker until it is fixed or
   shown to be runner noise with two matched base/head measurements.

This is the policy the "Bound failed-check investigations" rules below apply to.

### `perf` fails in the queue but not on the PR

`perf` is skipped on PR runs unless the PR has `ci:perf`, so a change to a UI
path the speed contract drives can pass its own CI and leave the queue on
`perf`. Read which phase failed:

- A missing selector, a layout the script waits for, or a phase that times out
  waiting for the UI is the PR's: it changed something the script drives.
- Only a timing budget missed, on a PR that does not touch that path, is the
  known flap on unchanged code (issue #704): add the run there and compare the
  queue runs just before and after.

Run it locally, headless, before queuing a change to such a path:

```
npm run build:web
cargo build -p nekkod
NEKKOD_PATH=target/debug/nekkod node scripts/perf/run.mjs --quick --no-gpu
```

Set `PERF_BROWSER` to a Chromium binary when auto-detection picks the wrong one.
CI measures a release `nekkod` (`cargo build -p nekkod --release`), so a debug
build proves the flow, not the budget.

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

## Bound failed-check investigations

- A watch waits for running or queued work, not completed failures. When checks finish red, diagnose the failed step before registering another watch.
- Carry a cumulative investigation budget across wake-ups. After two wake-ups with no new evidence, or 30 minutes of active investigation without a narrowed cause, stop repeating the same approach. Report the exact blocker, what is proven, and the next distinct experiment or decision needed.
- Permit one rerun only after a concrete transient cause is identified. A recurring failure requires evidence-driven diagnosis, not rerun-until-green.
- Measure the failing metric on both unchanged base and head with matching workload, toolchain and runner conditions. A baseline failure is not permission to bypass a gate or silently weaken a budget.
- Save traces and profiles for the failing metric, together with actual app revisions and commands. Confirm artifacts exist before calling diagnostics complete. CPU profiles alone cannot explain browser layout/paint work.
- Keep unrelated baseline performance remediation separate when possible. Do not turn a verified small UI fix into speculative optimization work. Present a baseline-repair dependency or explicit policy decision if it blocks landing.
- State waiting versus blocked accurately. Give a total elapsed scope and a concrete next action, not another unchanged progress message. Never register a watch when no background work can produce new evidence.
