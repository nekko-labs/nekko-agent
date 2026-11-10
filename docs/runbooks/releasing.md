# Versions and releases

Every build is `MAJOR.MINOR.BUILD` ([spec](../../spec/product/version-numbers.md), [decision 0055](../decisions/0055-versions-are-major-minor-and-a-per-platform-nightly-build.md)), fixed width `x.xx.xxxx` from the 0.10 line on ([decision 0080](../decisions/0080-versions-are-fixed-width-from-the-0.10-line.md)): MINOR 10-99, BUILD 1000-9999, the release at `.1000`. MAJOR.MINOR come from the newest release tag; BUILD is counted per platform by the nightlies. Do not bump a `package.json`, `Cargo.toml`, `project.yml` or `build.gradle.kts` version in a PR unless Philip asks: nothing reads them for a release, they are only what local and PR builds report (all 0.9.8 since #2540).

## Start a new MAJOR.MINOR (a release)

Only on Philip's say-so. On an up-to-date `main`:

```sh
git fetch origin
git tag -a v0.10.1000 -m v0.10.1000 origin/main
git push origin v0.10.1000
```

That push starts `release.yml` (installers, the update feed, the GitHub release, the npm packages, all at 0.10.1000) and `docker.yml`. Creating a GitHub release with a new `v0.10.1000` tag from the web page does the same. A line is released at `.1000`; `release.yml` refuses `v0.10.0`, `v1.0.0` or a MINOR over 99. The line after 0.99 is `v1.10.1000`.

The short form `v0.10` also works: `version-release.yml` adds `v0.10.1000` on the same commit and dispatches both workflows there (its own tag push, made with GITHUB_TOKEN, would start nothing). Prefer the full form; a GitHub release made on `v0.10` stays an empty release beside the real `v0.10.1000`.

From the next night on, every platform counts from 1001: desktop 0.10.1001, iOS 0.10.1001 (build 101001), Android 0.10.1001 (versionCode 101001).

## Release a desktop nightly

A nightly desktop build that should go to users as it is: tag its commit with its own version. Find both from the counter tag:

```sh
git fetch origin --tags
git tag -l 'nightly/desktop/v0.10.*' --sort=-v:refname | head
git tag -a v0.10.1004 -m v0.10.1004 nightly/desktop/v0.10.1004^{commit}
git push origin v0.10.1004
```

The next desktop nightly counts on above it (0.10.1005).

## Check what the next nightly will be

```sh
node scripts/nightly-version.mjs --platform desktop   # or ios, android; a dry run, pushes nothing
```

It reads the local tags, so fetch them first. `--reserve` is what the nightly workflows run; never run it by hand, it pushes a counter tag.

## The counters

- `nightly/desktop/v…`, `nightly/ios/v…`, `nightly/android/v…`: one annotated tag per build, on the commit built. Never delete or move one; the next number is the highest in the line plus one, so a deleted tag lets its number be handed out again (fatal for iOS, which refuses a repeated build number).
- A gap (a reserved number whose build failed) is normal.
- The script refuses BUILD above 9999 or MINOR above 99: tag the next line (`v1.10` after 0.99).

## Where each platform stamps it

| Workflow | Stamps |
| --- | --- |
| `installers.yml` (nightly) | root, `apps/desktop` and `apps/local-web-ui` versions before building; artifact `desktop-<version>-<os>` |
| `release.yml` (tag) | the same three from the tag name; the CLI and Local Web UI npm packages as before |
| `ios-testflight.yml` | `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (the store code) on the archive. See [ios-release.md](ios-release.md) |
| `android-native.yml` (nightly) | `-PnekkoVersionName` and `-PnekkoVersionCode` |

## Local desktop development versions

`npm run dev` and `npm run local` identify unpackaged source as `<latest-reachable-release>-dev.<distance>+g<commit>` (`.dirty` for tracked edits). They do not stamp or rewrite package manifests. About, Settings and the launcher share this identity. Fetch release tags when a clone is stale: `git fetch origin 'refs/tags/v*:refs/tags/v*'`. A source archive or missing Git is labeled `-dev.unknown`; a clone without release tags uses the manifest base with a development suffix. Installed builds still show their exact stamped release/nightly version. Restart a running development app after pulling this change or creating a release tag; an existing main process keeps its launch-time identity.

## Recover an existing desktop tag without moving it

The Release workflow downloads the official Electron ZIP and SHASUMS through
GitHub's release-assets API, not the browser download URLs (which returned 504
across all platforms on 2026-11-08). It requires the published version, exact
platform asset, archive size and SHA256 from SHASUMS; when GitHub supplies asset
SHA256 digests those must match too. No third-party mirror or checksum bypass.
Only the verified ZIP is passed to electron-builder's `electronDist` option;
Developer ID/notarization, entitlement and publisher checks remain unchanged.

If a tag's older workflow cannot package, dispatch the **current** workflow with
an existing full tag explicitly, rather than rewriting that tag:

```sh
gh workflow run release.yml --ref main -f release_tag=v0.9.5
```

This recovery mode checks out `refs/tags/v0.9.5` as application source, records
its commit in the log, stamps 0.9.5, and uses only the download helpers from the
workflow revision. It publishes desktop installers/feeds only; daemon npm, Local
Web UI npm and CLI npm jobs are skipped to avoid mixing main's packages with the
tag. The original tag-local workflow still handles npm. Workflow head SHA is the
tooling revision, **not** the application revision: verify the recorded checkout
against the annotated tag and verify the downloaded installers after publication.
Do not run competing release attempts or publish a partial desktop matrix.

Implemented recovery path is locally unit-tested and workflow-linted; end-to-end
cross-platform recovery publication remains unverified until the first run passes.

Packaging tools are fetched through the official electron-builder-binaries API
and seeded into a fresh runner-local archive cache, with upstream 26.17.0
SHA256 pins checked before builder performs its normal extraction. This covers
icons/7zip plus native AppImage/FPM, DMG and Windows/NSIS tools. The helper
fails for unsupported platforms or changed builder versions/pins: review its
inventory against the new locked builder sources before updating it. A cache
hit alone does not prove artifact integrity or release publication.
