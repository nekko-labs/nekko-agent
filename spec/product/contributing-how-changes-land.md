---
title: "Contributing: how changes land (2026-10-17)"
area: product
split-from: SPEC.md (2026-10-22)
---

# Contributing: how changes land (2026-10-17)

`[implemented 2026-10-17; PR tier, queue tier and schedule verified on live runs as noted in TASKS.md]` Many agents open PRs in parallel. A change should wait only for the checks it can break, and nothing should reach `main` untested.

- **On the PR (fast tier, about 8 minutes):** `build` always; the Rust daemon on Linux when `crates/` or the shared packages change; capture regressions on Windows when desktop code or packages change. A docs-only PR waits for `build` alone.
- **In the merge queue (queue tier):** a ready PR is queued, not merged. GitHub tests it on top of `main` and everything ahead of it in the queue, adding the Windows daemon and the speed contract for changes they can affect, then merges the group. A failure ejects the PR and the rest of the queue continues.
- **Every 6 hours (full tier):** every job on every OS, including macOS, which is never run per change because the Team plan allows five macOS jobs at once across all workflows. It is skipped when `main` has not moved. The other macOS checks follow the same rule: the native iOS build, the mobile app's iOS build and the macOS development-identity smoke run every 6 hours, CodeQL's Swift scan weekly, and none of them per change. A failure opens or updates one `ci-scheduled` issue. `[planned]` Nightly desktop releases ship only a commit that passed it; today releases still follow version bumps (`version-release.yml`). `ci:macos` and `ci:perf` labels opt a single PR in when it touches macOS-only code or a measured hot path.
- **Ready, not draft:** a PR is opened ready once its author's own checks pass; it does not sit in draft waiting for CI. Draft means the author is still working (or is blocked), never "waiting for checks". The queue is what waits, and it merges on green without anyone watching.
- **Big features as stacks:** work larger than one reviewable change is split into a stack of PRs with `gh stack` (GitHub's stacked-PR CLI), each layer built on the one below, so the next layer can start before the first merges. Each layer gets the fast tier; `gh stack merge` adds the stack to the merge queue together.
- **One required check:** `gate` (in `ci.yml`) passes when every job the run needed passed, so protection does not change as jobs are added or path-gated.
