---
title: "Contributing: how changes land (2026-10-17)"
area: product
split-from: SPEC.md (2026-10-22)
---

# Contributing: how changes land (2026-10-17)

`[implemented 2026-10-17; PR tier and schedule verified on live runs as noted in TASKS.md]` `[changed 2026-11-06, Philip: merge queue removed]` Many agents open PRs in parallel. A change should wait only for the checks it can break, and land as soon as they pass.

- **On the PR (fast tier):** `build` always (the npm tests, typecheck and the nekkod build, on Linux). `[changed 2026-11-06]` The speed contract when the PR touches what it measures, and the loopback end-to-end tests whenever it needs `build` ([decision 0059](../../docs/decisions/0059-speed-contract-and-itests-run-on-every-pr.md)). `[changed 2026-11-03]` Platform builds (the Rust daemon and capture regressions on Linux, Windows and macOS, the native iOS and Android apps, the installers) do not run per change: a `deploy:linux`, `deploy:windows`, `deploy:macos`, `deploy:ios` or `deploy:android` label opts one PR into that platform's runs, and `gate` waits for them. A docs-only PR waits for `build` and the loopback tests.
- **Merging (no queue):** `[changed 2026-11-06]` a ready PR merges itself through GitHub's native auto-merge (squash) as soon as `gate` passes. The merge queue that used to test each group on top of `main`, with the speed contract and the loopback end-to-end tests, was removed ([decision 0056](../../docs/decisions/0056-no-merge-queue-speed-contract-and-itests-run-nightly.md)); those two suites run on the PR instead, path-gated as the queue ran them, so `gate` is the last check before `main` ([decision 0059](../../docs/decisions/0059-speed-contract-and-itests-run-on-every-pr.md)). What a PR does not run, the next nightly run catches.
- **Nightly (full tier, about 03:00 JST):** `[changed 2026-11-03]` every job on every OS, the speed contract and the loopback end-to-end tests, plus the native iOS and Android apps, the Windows and macOS installers and the macOS development-identity smoke; the TestFlight upload follows when the iPhone app changed since the last one. `[changed 2026-11-11]` CodeQL's Swift scan runs nightly on `main` and never on a PR, `deploy:ios` included: it needs a macOS runner, and the five macOS runners are the CI's bottleneck. Full CI is skipped when `main` has not moved. A failure opens or updates one `ci-scheduled` issue. `[changed 2026-11-06]` Each nightly desktop, iOS and Android build carries its own version, `MAJOR.MINOR.BUILD`, and a release starts only from a release tag a person pushes, no longer from a version bump in a PR ([version numbers](version-numbers.md)). `[planned]` Nightly desktop releases ship only a commit that passed it. A `deploy:<platform>` label opts a single PR into a platform's builds when it touches platform-specific code; `ci:perf` forces the speed contract on a PR that touches none of its paths.
- **Ready, not draft:** a PR is opened ready once its author's own checks pass; it does not sit in draft waiting for CI. Draft means the author is still working (or is blocked), never "waiting for checks". Auto-merge is what waits, and it merges on green without anyone watching. Draft or a `hold` label turns auto-merge off; marking ready or removing `hold` turns it back on.
- **Big features as stacks:** work larger than one reviewable change is split into a stack of PRs with `gh stack` (GitHub's stacked-PR CLI), each layer built on the one below, so the next layer can start before the first merges. Each layer gets the fast tier; `gh stack merge` lands the stack together.
- **iPhone evidence runs on a Mac, not on CI:** `[changed 2026-11-11]` before/after iPhone screenshots and diagnostics are captured with `scripts/ios-evidence-local.mjs` on a Mac with Xcode. The evidence workflows remain, dispatch-only, for a machine without Xcode; none of them (Card details evidence included, which used to run on every chat-list PR) starts on its own, and a check fails any workflow that adds automatic macOS jobs outside the platform builds. Why: the org's 5 macOS runners were full a quarter of the time, and Native iOS runs, which `gate` waits for, queued for up to hours behind evidence runs.
- **One required check:** `gate` (in `ci.yml`) passes when every job the run needed passed, so protection does not change as jobs are added or path-gated.
- **Tasks are GitHub issues; nothing every PR edits is committed.** `[implemented 2026-11-04]` Every change has an issue, and the issue is the task: its plan notes and checklist live there, and how it was built goes in the PR description. `TASKS.md` holds only the technical plan; the task log it carried until 2026-11-04 is frozen in `docs/history/tasks-archive.md`. The spec index is generated on demand (`node scripts/spec-index.mjs`) instead of committed. Both used to change in most PRs (the index in 111 and the task log in 62 of the 231 merges from 2026-10-28 to 2026-11-04) and made parallel PRs conflict with each other. Floop mirrors the issues; two-way sync is `[planned]`. See [decision 0049](../../docs/decisions/0049-keep-the-spec-index-and-task-log-out-of-prs.md).

## Shared build-failure recovery (#2232)

Implemented in the repair script; local decision/request tests and a real-Git
merge fixture verified. Hosted build outcomes and live App-backed recovery
verification are recorded in PR #2233. The current no-queue,
non-strict merge policy is retained: independently green PRs are not guaranteed
to have been tested together against the latest main. Semantic merge races remain
possible; this is recovery, not a new merge-prevention guarantee.

Queue repair treats matching failed job names across other PRs as a suspected
shared baseline failure, not proof of the same root cause. It uses each branch's
latest completed success/failure CI run (repository-qualified branch identity
also retains merged runs with empty PR metadata); pending/cancelled runs do not
erase confirmed failures. A recovered green gate or an in-flight/stale-head gate
is never retried merely because an old baseline comment remains.

For a baseline-marked completed red gate, newer main is merged using the existing
App token and an expected-head check, without rewriting history or automatically
resolving code conflicts. This triggers new-head CI rather than replaying an old
Actions merge snapshot. If main is already included, repair waits for the shared
signal to clear before retrying failed jobs, at most twice per head. Conflicts,
concurrent pushes and denied updates require human resolution; no token scopes,
required checks, performance budgets or ruleset settings are weakened. See the
[failing-checks runbook](../../docs/runbooks/failing-checks.md).

## Native iOS batch completion (#2035)

Implemented in source with local selector, reporting and workflow regression tests;
hosted macOS/Xcode execution and timeout reduction are not yet verified. Native iOS
splits the broad fixture suite, themed pairing retries and remaining live journeys
into three isolated required jobs. Every job keeps its 85-minute budget, existing
assertions/retries, theme scope, build/bundle audits and screenshot diagnostics.
The fixture selection remains open-ended for newly added non-live suites.

A failure does not cancel the other shards. Only the aggregate reporter may mark
`Native iOS (batch)` successful, after every shard passes; skipped, cancelled,
missing and unknown results cannot pass. Per-shard evidence artifacts have distinct
names. Existing label-gate acceptance is unchanged. See the
[landing runbook](../../docs/runbooks/landing-a-pr.md#native-ios-suite-shards-2035)
for diagnostics and the remaining hosted verification. This is a CI scheduling
repair, not an iOS app behavior change or a measured speed claim.

## Workflow-changing PRs sit out of the Native iOS batch (#2030)

`[implemented 2026-11-10; unit-tested and dry-run against live PRs (#2480 left out, #2513 batched); a hosted compose with such a PR is not yet observed]`
The batch composer pushes with the workflow's own token, which may not create or
update files under `.github/workflows/`. One candidate changing a workflow (#2480's
`native-mode-evidence.yml`, and #1971/#1993/#2004 before it) made GitHub refuse the
whole push, so no PR in that batch got a `Native iOS (batch)` status. The composer
now leaves out a PR whose merge onto main changes such a file, starts
`ios-native.yml` on that PR's branch once per head (unless a run is already there),
then marks the head red with a status naming `gh workflow run ios-native.yml --ref
<branch>`. `gate` waits while that run goes and follows its result, as for any
PR-level Native iOS run. The rest of the batch (conflict handling, statuses, the
manifest) is unchanged. No token is broadened: giving the batch a GitHub App token
with Workflows write, so such PRs can batch too, stays Philip's settings call.
