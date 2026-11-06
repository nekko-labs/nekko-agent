# Failing checks

What to do when a required check is red, on your PR or on `main`, and how long to keep investigating before reporting a blocker.

## When a check fails on `main` too

The repo's required check is `gate`, which passes when every job its run needed
passed. CI runs in two tiers (`scripts/ci-scope.mjs`); there is no merge queue
(decision 0056):

| Tier | When | Runs |
| --- | --- | --- |
| PR | every push to a PR | `build`; `daemon` and `capture` only on the OSes a `deploy:linux` / `deploy:windows` / `deploy:macos` label names, when the change touches what they test; `perf` only with `ci:perf` |
| Full | nightly at 03:17 JST (skipped if `main` has not moved), or `gh workflow run ci.yml --ref <branch>` | every job on every OS, macOS included, plus `perf` and the itests |

Every other platform build is nightly too, or on a PR with its label:
`deploy:ios` (Native iOS, CodeQL Swift), `deploy:android` (Native Android),
`deploy:macos` (dev identity, nekkod darwin, decision-model CoreML, the macOS
installer), `deploy:windows` (the Windows installer). Add the label to a PR that
changes that platform's code (`cfg(target_os = ...)`, ConPTY, the dev bundle,
signing, native capture, the phone apps), and `ci:perf` to one that changes a hot
path the speed contract measures and wants the numbers before it merges. Labels
are read when a run starts: adding one re-runs CI. A skipped job is not a missing
check. A failed nightly run opens or updates the `ci-scheduled` issue; whoever
lands the next fix to that area clears it.

When one of them is red:

1. Diagnose the failing step. If the failure is in something this PR touches, fix it.
2. Otherwise compare against `main`: the same job on the merge-base commit, or the
   most recent full runs (`gh run list --workflow ci.yml --event schedule`). If
   `main` fails the same way on the same metric, the failure is a baseline problem.
3. A baseline failure is not this PR's fault, but it blocks every PR that runs
   that job, so it is the most urgent thing in the repo. Make sure an issue exists
   (search first, file one if not), then fix it forward or revert the commit that
   caused it, in its own small PR, before re-running yours.
   Record it in this PR's Unfinished work with the run that proves it. Do not
   weaken a budget or delete a check to get past it; recalibrating a noisy gate
   from measured data is a separate, explicit decision (see `docs/perf-history.md`).
4. A failure that only this PR produces is a release blocker until it is fixed or
   shown to be runner noise with two matched base/head measurements.

This is the policy the "Bound failed-check investigations" rules below apply to.

### `perf` fails nightly after a PR landed

`perf` is skipped on PR runs unless the PR has `ci:perf`, so a change to a UI
path the speed contract drives can pass its own CI, merge, and turn the nightly
run red. Read which phase failed:

- A missing selector, a layout the script waits for, or a phase that times out
  waiting for the UI belongs to the PR that changed what the script drives.
- Only a timing budget missed, on a PR that does not touch that path, is the
  known flap on unchanged code (issue #704): add the run there and compare the
  nightly runs just before and after.

Run it locally, headless (or add `ci:perf`), before landing a change to such a path:

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
