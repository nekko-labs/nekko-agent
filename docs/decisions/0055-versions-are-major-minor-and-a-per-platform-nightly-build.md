---
status: accepted
date: 2026-11-06
---

# 0055. Versions are MAJOR.MINOR from a release tag and a per-platform nightly BUILD

Issue: [#1886](https://github.com/nekko-labs/nekko-agent/issues/1886). Spec: [version numbers](../../spec/product/version-numbers.md). Runbook: [releasing](../runbooks/releasing.md).

The readings of the request below (plain unpadded numbers, the tag as the only bump, per-platform counters, the store formula) were taken as defaults while Philip was unreachable, and are to be confirmed with him.

## Context

Philip asked for an `x.xxx.xxxx` version on everything, with every platform's nightly build counting up, and MAJOR and MINOR bumped by hand with a GitHub tag release.

Before this, each platform numbered itself differently:

- **Desktop and npm**: `package.json` at 0.8.2, bumped in a PR; `version-release.yml` tagged `v<version>` when the bump merged (on a `*/15` schedule and a dispatch from `auto-merge.yml`, because a GITHUB_TOKEN merge starts no workflow run) and dispatched `release.yml` and `docker.yml`. The nightly `installers.yml` built unsigned installers at whatever `package.json` said and kept nothing.
- **iOS**: `MARKETING_VERSION` 0.2.0 from `apps/ios/project.yml`, build number run number + 100 (179 by 2026-11-05).
- **Android**: always `versionName` 0.1.0, `versionCode` 1; the nightly keeps a debug APK artifact. Nothing is uploaded to Play.

Constraints: npm, App Store Connect, Google Play and macOS bundle versions all reject leading zeros, so `x.xxx.xxxx` can only describe capacity. A tag or push made with GITHUB_TOKEN starts no workflow run. App Store Connect refuses a build number it has already seen, and Play needs an increasing integer versionCode no larger than 2100000000.

## Options considered

1. **Where MAJOR.MINOR live**: (a) `package.json`, bumped in a PR, as before. Rejected: Philip asked for a tag, and a version in a file has to be copied into four projects (root, desktop, Local Web UI, iOS, Android) that drift. (b) **The newest release tag** `vMAJOR.MINOR[.PATCH]`. One place, set by a person, visible in the releases list.
2. **Where each platform's BUILD counter lives**: (a) a counter in a repository variable. Needs a token with variables write (GITHUB_TOKEN cannot), is not tied to a commit, and is overwritten, not appended. (b) GitHub's run number. Per workflow, never resets on a new MINOR, and counts runs that built nothing (the iOS "nothing changed" nights). (c) A committed file. Every nightly would push to `main`, which needs the merge queue. (d) A cache or artifact. Expires. (e) **One annotated tag per build, `nightly/<platform>/vMAJOR.MINOR.BUILD`, on the commit built.** Durable, append-only, pushable with GITHUB_TOKEN's `contents: write`, and it records which commit each build came from. The count is derived: the highest BUILD among the platform's tags in the current line, plus one.
3. **What a nightly desktop build becomes**: (a) a GitHub prerelease. Rejected for now: the nightly installers are unsigned (Gatekeeper and SmartScreen block them), and a release list full of nightlies buries the real ones. The updater reads `releases/latest`, which skips prereleases, so it would be safe, but not useful. (b) **A workflow artifact** named with the version, kept 14 days. (c) Nothing kept, as before: then the version has nothing to label.
4. **Store integers**: **MAJOR\*10000000 + MINOR\*10000 + BUILD**. Increases across every BUILD and every new line, fits MAJOR 0-209 under Play's cap, and 0.8.1 gives 80001, above every iOS build uploaded so far (at most 179) and Android's 1, so no offset is needed.

## Decision

MAJOR.MINOR is the newest release tag; a person creates it (`v0.9.0`, or `v0.9`, which `version-release.yml` expands to `v0.9.0` on the same commit and dispatches `release.yml` and `docker.yml` at, since its own GITHUB_TOKEN tag push starts nothing). `release.yml` stamps the tag's version into the desktop and Local Web UI packages, so `package.json` versions are no longer bumped and a merge releases nothing; `auto-merge.yml` no longer dispatches `version-release.yml`, and its schedule is gone.

BUILD is per platform: `scripts/nightly-version.mjs` computes it from the tags and, in a nightly, pushes the counter tag before the build starts, retrying with the next number when a concurrent run took it. Desktop counts from above the highest released PATCH in the line, because its versions share a namespace with the installers and npm packages already shipped (v0.8.2 exists, so the first desktop nightly is 0.8.3). iOS and Android count from 1. Desktop and Android reuse the version a commit already has (a re-run or a night with no new commit); iOS never reuses one. The tags are pushed with GITHUB_TOKEN, so they start no workflow, and they match neither release trigger (`v[0-9]+.[0-9]+.[0-9]+`).

Nightly desktop installers stay artifacts.

## Consequences

- A release is a tag: `git tag -a v0.9.0 -m v0.9.0 && git push origin v0.9.0`. A desktop nightly that proves good can be promoted by tagging its commit with its own version (`v0.9.4`); the next desktop nightly then counts on from 0.9.5.
- About three counter tags a night, roughly a thousand a year, in the tag list under `nightly/`. If that gets in the way, the derivation can move to a ref namespace outside `refs/tags/` without changing the numbers.
- A reserved number whose build then fails is a gap. Harmless: only increasing matters.
- Every iOS nightly is a new marketing version in App Store Connect, so each opens its own version train in TestFlight. Internal testers see it at once; an external group needs Beta App Review per marketing version. If that becomes a cost, iOS can keep MAJOR.MINOR.0 as its marketing version and carry BUILD in the build number only (the build number already holds the whole version).
- 9999 builds per line and 999 minors per major. The script refuses to go past either and says to tag the next line.
- No nightly npm packages: npm still publishes only from a release tag.
