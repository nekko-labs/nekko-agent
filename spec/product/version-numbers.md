---
title: "Version numbers: MAJOR.MINOR from a release tag, BUILD per nightly (2026-11-06)"
area: product
---

# Version numbers (2026-11-06)

`[implemented 2026-11-06 (#1886); scripts unit-tested, including the tag push against a local remote; workflows linted; not yet seen in a real nightly, release or App Store Connect run]`

**User intent.** Every build of Nekko Agent, on every device, says which version it is in one format, `MAJOR.MINOR.BUILD` (capacity `x.xxx.xxxx`). Nightly builds count up on their own; MAJOR and MINOR move only when a person decides, with a GitHub tag release. Why each choice: [decision 0055](../../docs/decisions/0055-versions-are-major-minor-and-a-per-platform-nightly-build.md). How to cut a release: [releasing](../../docs/runbooks/releasing.md).

**Format.** Plain numbers without padding, because npm, App Store Connect, Google Play and macOS reject leading zeros: `0.9.42`, never `0.009.0042`. MINOR runs 0-999 and BUILD 0-9999; the version script refuses anything beyond and says to tag the next line.

**MAJOR.MINOR.** The newest release tag, `vMAJOR.MINOR.PATCH` or the short `vMAJOR.MINOR` (a tag with a suffix such as `-rc.1` is a prerelease and does not start a line). A person pushes it, or creates a GitHub release with it. A short tag is expanded to `vMAJOR.MINOR.0` on the same commit, and that tag is released: installers, npm packages and Docker images at `MAJOR.MINOR.0`. Package versions in the repository are no longer bumped and no longer decide anything; a merge never releases.

**BUILD.** Each platform counts its own nightly builds since the newest release tag, and the count starts again on the next one:

| Platform | What counts | Stamped as | First version after this change |
| --- | --- | --- | --- |
| Desktop (Windows, macOS installers) | each nightly `installers.yml` run on `main`; both OSes share the number | app and installer version; artifact `desktop-<version>-<os>`, kept 14 days | 0.8.3 (above the released v0.8.2) |
| iOS (TestFlight) | each upload | `CFBundleShortVersionString` = the version, `CFBundleVersion` = the store code, on the app and every extension | 0.8.1, build 80001 |
| Android | each nightly `android-native.yml` run on `main` | `versionName` = the version, `versionCode` = the store code | 0.8.1, versionCode 80001 |

After a `v0.9` tag: desktop 0.9.0 is the release, and the nightlies are 0.9.1, 0.9.2 and so on, per platform.

- Desktop's BUILD stays above any release in the line, so a nightly never carries a released number. A good desktop nightly can be released by tagging its commit with its version.
- Desktop and Android give a commit that already has a version the same one again (a re-run, a night with no new commits). iOS never does, because App Store Connect refuses a repeated build number.
- A PR build, or a run started by hand off `main`, keeps the checked-in version (desktop 0.8.2, iOS 0.2.0, Android 0.1.0) and counts nothing. An iOS upload started by hand from a branch does count, since it reaches TestFlight.

**iOS nightlies are for internal testers only** (Philip, 2026-11-06). Every iOS nightly has its own marketing version, which would need Beta App Review per build for external testers, so none goes to them. Each upload is marked internal testing only (`testFlightInternalTestingOnly`), so App Store Connect refuses to add it to an external group, send it to Beta App Review or submit it to the App Store. After Apple's processing, the workflow adds it to every internal TestFlight group that does not already receive every build. Only an upload started by hand with `internal_only` off can go further.

**Store code.** `MAJOR*10000000 + MINOR*10000 + BUILD`: always increasing, under Google Play's 2100000000 cap up to MAJOR 209, and above every build uploaded before (TestFlight reached 179).

**Where the counts live.** An annotated tag per build, `nightly/<platform>/vMAJOR.MINOR.BUILD`, on the commit built, pushed before the build starts (`scripts/nightly-version.mjs`). A lost race takes the next number; a failed build leaves a gap. `git tag -l 'nightly/ios/*'` lists every iOS build and its commit.

**Not part of this.** Nightly desktop builds are not GitHub releases and are unsigned. No nightly npm packages. Nothing is uploaded to Google Play.
