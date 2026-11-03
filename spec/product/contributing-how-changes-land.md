---
title: "Contributing: how changes land (2026-10-17)"
area: product
split-from: SPEC.md (2026-10-22)
---

# Contributing: how changes land (2026-10-17)

`[implemented 2026-10-17; PR tier, queue tier and schedule verified on live runs as noted in TASKS.md]` Many agents open PRs in parallel. A change should wait only for the checks it can break, and nothing should reach `main` untested.

- **On the PR (fast tier):** `build` always (the npm tests, typecheck and the nekkod build, on Linux). `[changed 2026-11-03]` Platform builds (the Rust daemon and capture regressions on Linux, Windows and macOS, the native iOS and Android apps, the installers) do not run per change: a `deploy:linux`, `deploy:windows`, `deploy:macos`, `deploy:ios` or `deploy:android` label opts one PR into that platform's runs, and `gate` waits for them. A docs-only PR waits for `build` alone.
- **In the merge queue (queue tier):** a ready PR is queued, not merged. GitHub tests it on top of `main` and everything ahead of it in the queue, adding the speed contract and the loopback end-to-end tests for changes they can affect, then merges the group. A failure ejects the PR and the rest of the queue continues.
- **Nightly (full tier, about 03:00 JST):** `[changed 2026-11-03]` every job on every OS, plus the native iOS and Android apps, the Windows and macOS installers and the macOS development-identity smoke; the TestFlight upload follows when the iPhone app changed since the last one. CodeQL's Swift scan stays weekly. Full CI is skipped when `main` has not moved. A failure opens or updates one `ci-scheduled` issue. `[planned]` Nightly desktop releases ship only a commit that passed it; today releases still follow version bumps (`version-release.yml`). A `deploy:<platform>` label opts a single PR into a platform's builds when it touches platform-specific code; `ci:perf` opts it into the speed contract.
- **Ready, not draft:** a PR is opened ready once its author's own checks pass; it does not sit in draft waiting for CI. Draft means the author is still working (or is blocked), never "waiting for checks". The queue is what waits, and it merges on green without anyone watching.
- **Big features as stacks:** work larger than one reviewable change is split into a stack of PRs with `gh stack` (GitHub's stacked-PR CLI), each layer built on the one below, so the next layer can start before the first merges. Each layer gets the fast tier; `gh stack merge` adds the stack to the merge queue together.
- **One required check:** `gate` (in `ci.yml`) passes when every job the run needed passed, so protection does not change as jobs are added or path-gated.
