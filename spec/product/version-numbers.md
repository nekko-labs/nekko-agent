---
title: "Version numbers: x.xx.xxxx, MAJOR.MINOR from a release tag, BUILD per nightly (2026-11-06, fixed width 2026-11-11)"
area: product
---

# Version numbers (2026-11-06)

`[implemented 2026-11-06 (#1886); scripts unit-tested, including the tag push against a local remote; workflows linted; not yet seen in a real nightly, release or App Store Connect run]`

**User intent.** Every build of Nekko Agent, on every device, says which version it is in one format, `MAJOR.MINOR.BUILD` (capacity `x.xxx.xxxx`). Nightly builds count up on their own; MAJOR and MINOR move only when a person decides, with a GitHub tag release. Why each choice: [decision 0055](../../docs/decisions/0055-versions-are-major-minor-and-a-per-platform-nightly-build.md). How to cut a release: [releasing](../../docs/runbooks/releasing.md).

**Format.** Plain numbers without padding, because npm, App Store Connect, Google Play and macOS reject leading zeros: never `0.09.0042`. `[changed 2026-11-11, implemented, not yet seen in a real release or nightly]` **From the 0.10 line on, every version is fixed width, `x.xx.xxxx`** (Philip: "based on x.xx.xxxx not x.x.x"; [decision 0080](../../docs/decisions/0080-versions-are-fixed-width-from-the-0.10-line.md)): MINOR runs 10-99 and BUILD 1000-9999, so the shape holds without a leading zero. The release is `0.10.1000` and the nightlies `0.10.1001`, `0.10.1002` and on. A new MAJOR starts at MINOR 10 (`v1.10`). The release workflows refuse an off-shape tag (`v0.10.0`, `v1.0`, MINOR over 99) and say what to tag instead. Lines before 0.10 (up to 0.9.x) kept one-digit numbers and their tags can still be rebuilt. The version script refuses BUILD past 9999 or MINOR past 99 and says to tag the next line.

**MAJOR.MINOR.** The newest release tag, `vMAJOR.MINOR.PATCH` or the short `vMAJOR.MINOR` (a tag with a suffix such as `-rc.1` is a prerelease and does not start a line). A person pushes it, or creates a GitHub release with it. A short tag is expanded to the full one on the same commit (`v0.10` to `v0.10.1000`; before 0.10, `v0.9` to `v0.9.0`), and that tag is released: installers, npm packages and Docker images at that version. Package versions in the repository are no longer bumped and do not decide release versions; a merge never releases.

**BUILD.** Each platform counts its own nightly builds since the newest release tag, and the count starts again on the next one:

| Platform | What counts | Stamped as | First version after this change |
| --- | --- | --- | --- |
| Desktop (Windows, macOS installers) | each nightly `installers.yml` run on `main`; both OSes share the number | app and installer version; artifact `desktop-<version>-<os>`, kept 14 days | 0.8.3 (above the released v0.8.2) |
| iOS (TestFlight) | each upload | `CFBundleShortVersionString` = the version, `CFBundleVersion` = the store code, on the app and every extension | 0.8.1, build 80001 |
| Android | each nightly `android-native.yml` run on `main` | `versionName` = the version, `versionCode` = the store code | 0.8.1, versionCode 80001 |

After a `v0.10` tag: desktop 0.10.1000 is the release, and the nightlies are 0.10.1001, 0.10.1002 and so on, per platform (before 0.10: release 0.9.0, nightlies from 0.9.1).

- Desktop's BUILD stays above any release in the line, so a nightly never carries a released number. A good desktop nightly can be released by tagging its commit with its version.
- Desktop and Android give a commit that already has a version the same one again (a re-run, a night with no new commits). iOS never does, because App Store Connect refuses a repeated build number.
- A PR build, or a run started by hand off `main`, keeps the checked-in version (0.9.8 everywhere since 2026-11-11, #2540; before that desktop 0.8.2, iOS 0.2.0, Android 0.1.0, crates 0.1.0) and counts nothing. An iOS upload started by hand from a branch does count, since it reaches TestFlight.

`[changed 2026-11-08]` **The scheduled iOS nightly can go to external testers; uploads started by hand are internal only** (Philip; from 2026-11-06 to 2026-11-08 every upload was internal only). The nightly can be added to an external TestFlight group by hand, and because each iOS nightly has its own marketing version, each needs Beta App Review before external testers can install it. An upload started by hand is marked internal testing only (`testFlightInternalTestingOnly`) unless `internal_only` is turned off, so App Store Connect refuses to add it to an external group, send it to Beta App Review or submit it to the App Store. After Apple's processing, the workflow adds every upload to every internal TestFlight group that does not already receive every build.

**Store code.** `MAJOR*10000000 + MINOR*10000 + BUILD`: always increasing, under Google Play's 2100000000 cap up to MAJOR 209, and above every build uploaded before (TestFlight reached 179). 0.10.1001 is 101001, above every 0.9 build (0.9.8 is 90008).

**Where the counts live.** An annotated tag per build, `nightly/<platform>/vMAJOR.MINOR.BUILD`, on the commit built, pushed before the build starts (`scripts/nightly-version.mjs`). A lost race takes the next number; a failed build leaves a gap. `git tag -l 'nightly/ios/*'` lists every iOS build and its commit.

**Not part of this.** Nightly desktop builds are not GitHub releases and are unsigned. No nightly npm packages. Nothing is uploaded to Google Play.

## Desktop development identity

**Implemented, pending release verification.** Unpackaged desktop builds (`npm run dev`, `npm run local`) report the highest numeric stable release tag reachable from their checkout, followed by `-dev.<commits-since-tag>+g<commit>`. Tracked local edits add `.dirty`. The same identity reaches About, Settings and the development-launch banner through the engine app-info bridge. Tags are read locally, with no network requests, uploads or counter reservations. Fetch release tags to refresh a stale clone. An archive, missing Git or missing tags falls back to the manifest version with an explicit development suffix, never an apparently released version. Packaged installers continue to use only their workflow-stamped version; development identity does not change update feeds or package manifests.

**Acceptance:** numeric tag ordering, short tags, unrelated branches, dirty sources, missing Git/tags and unchanged packaged versions are regression-tested. Hidden desktop evidence verifies the About label independently of the user profile. macOS release signing/notarization is verified by the release workflow, not by this development fixture.

## Existing-tag desktop release recovery

**Implemented; cross-platform recovery publication unverified.** Release tooling
may be dispatched from current main with an explicit existing full `release_tag`.
Application code is checked out from that immutable tag, while only the official
Electron and packaging-tool downloaders come from the workflow revision. This reserves no version,
rewrites no tag and skips all npm publication in recovery mode. Electron archives
come only from the official GitHub release-assets API and must match exact
version/platform, size and official SHASUMS256; available GitHub asset digests must
also match. Checksum or API errors fail closed, without retry loops. The verified
ZIP goes to electron-builder without changing macOS signing/notarization, Windows
publisher checks, feed checks or the complete-matrix publication dependency.
Acceptance: tagged application SHA is logged and checked independently from the
workflow SHA; published installer metadata, hashes, signing and notarization still
require real release artifact verification. No user app/profile is touched.

**Packaging-tool recovery implemented; end-to-end publication unverified.** For
locked electron-builder 26.17.0, native Linux x64, macOS arm64 and Windows x64
packaging archives (icons, 7zip, AppImage/FPM, DMG and NSIS/Windows resources)
come from the official electron-builder-binaries release-assets API. Exact
release/name/size, upstream pinned SHA256 and available GitHub digest must match.
A fresh runner-local archive cache is seeded; builder rechecks its original pins
and performs its own extraction. No extracted-cache trust, patched dependency,
mirror, disabled checksum or signing bypass. Changed builder versions/pins or
unsupported platforms fail for review rather than silently changing tool identity.
