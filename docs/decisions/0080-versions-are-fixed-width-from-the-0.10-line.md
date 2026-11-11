---
status: accepted
date: 2026-11-11
---

# 0080. Versions are fixed width, x.xx.xxxx, from the 0.10 line

Amends [0055](0055-versions-are-major-minor-and-a-per-platform-nightly-build.md). Spec: [version numbers](../../spec/product/version-numbers.md). Runbook: [releasing](../runbooks/releasing.md).

The reading of the request below (no padding, MINOR from 10, BUILD from 1000) was taken while Philip could not be reached and is to be confirmed with him.

## Context

0055 gave every build `MAJOR.MINOR.BUILD` with a capacity of `x.xxx.xxxx`, written without padding, so versions came out as `0.9.8`. On 2026-11-11 Philip asked for release bumps and nightlies to be "based on x.xx.xxxx not x.x.x", starting with the next ones.

npm, App Store Connect, Google Play and macOS bundle versions all refuse leading zeros, so `0.09.0008` cannot ship.

## Options considered

1. **Pad on screen only** (`0.09.0008` in About, `0.9.8` everywhere else). Rejected: two spellings of one version, and the one in tags, installers and stores would still be x.x.x.
2. **Keep plain numbers and cap MINOR at 99.** Rejected: nothing would look different, which is what was asked for.
3. **Fixed width without padding.** MINOR runs 10-99 and BUILD 1000-9999, so every version has the x.xx.xxxx shape with no leading zero: the release is `v0.10.1000`, the nightlies `0.10.1001`, `0.10.1002` and on.

## Decision

Option 3, from the 0.10 line on.

- A short release tag `v0.10` expands to `v0.10.1000` (`canonicalReleaseTag`, and the same rule in bash in `version-release.yml`).
- Every platform counts its nightlies from 1001 in a fixed-width line; desktop still counts above any release PATCH in the line, so a promoted nightly `v0.10.1004` is followed by 0.10.1005.
- `release.yml` and `version-release.yml` refuse an off-shape tag: a fixed-width line below 1000 (`v0.10.0`), MINOR over 99, or a new MAJOR below MINOR 10. A new MAJOR starts at `v1.10`.
- Lines before 0.10 keep their one-digit numbers, so existing tags such as `v0.9.5` can still be rebuilt.
- The store code formula is unchanged, `MAJOR*10000000 + MINOR*10000 + BUILD`: 0.10.1001 is 101001, above every 0.9 build (0.9.8 is 90008), and 209.99.9999 still fits under Google Play's cap.

## Consequences

- 8999 builds per line (1001-9999) and 90 minors per major (10-99). The script refuses past either and says what to tag.
- A new MAJOR skips MINOR 0-9 (`v1.10`, not `v1.0`).
- If Philip meant something else by x.xx.xxxx, the next line can change the rule; versions only have to keep increasing.
