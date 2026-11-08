# Versions and releases

Every build is `MAJOR.MINOR.BUILD` ([spec](../../spec/product/version-numbers.md), [decision 0055](../decisions/0055-versions-are-major-minor-and-a-per-platform-nightly-build.md)). MAJOR.MINOR come from the newest release tag; BUILD is counted per platform by the nightlies. Never bump a `package.json`, `project.yml` or `build.gradle.kts` version in a PR: nothing reads them for a release any more.

## Start a new MAJOR.MINOR (a release)

Only on Philip's say-so. On an up-to-date `main`:

```sh
git fetch origin
git tag -a v0.9.0 -m v0.9.0 origin/main
git push origin v0.9.0
```

That push starts `release.yml` (installers, the update feed, the GitHub release, the npm packages, all at 0.9.0) and `docker.yml`. Creating a GitHub release with a new `v0.9.0` tag from the web page does the same.

The short form `v0.9` also works: `version-release.yml` adds `v0.9.0` on the same commit and dispatches both workflows there (its own tag push, made with GITHUB_TOKEN, would start nothing). Prefer the full form; a GitHub release made on `v0.9` stays an empty release beside the real `v0.9.0`.

From the next night on, every platform counts from 1 again: desktop 0.9.1, iOS 0.9.1 (build 90001), Android 0.9.1 (versionCode 90001).

## Release a desktop nightly

A nightly desktop build that should go to users as it is: tag its commit with its own version. Find both from the counter tag:

```sh
git fetch origin --tags
git tag -l 'nightly/desktop/v0.9.*' --sort=-v:refname | head
git tag -a v0.9.4 -m v0.9.4 nightly/desktop/v0.9.4^{commit}
git push origin v0.9.4
```

The next desktop nightly counts on above it (0.9.5).

## Check what the next nightly will be

```sh
node scripts/nightly-version.mjs --platform desktop   # or ios, android; a dry run, pushes nothing
```

It reads the local tags, so fetch them first. `--reserve` is what the nightly workflows run; never run it by hand, it pushes a counter tag.

## The counters

- `nightly/desktop/v…`, `nightly/ios/v…`, `nightly/android/v…`: one annotated tag per build, on the commit built. Never delete or move one; the next number is the highest in the line plus one, so a deleted tag lets its number be handed out again (fatal for iOS, which refuses a repeated build number).
- A gap (a reserved number whose build failed) is normal.
- The script refuses BUILD above 9999 or MINOR above 999: tag the next line.

## Where each platform stamps it

| Workflow | Stamps |
| --- | --- |
| `installers.yml` (nightly) | root, `apps/desktop` and `apps/local-web-ui` versions before building; artifact `desktop-<version>-<os>` |
| `release.yml` (tag) | the same three from the tag name; the CLI and Local Web UI npm packages as before |
| `ios-testflight.yml` | `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (the store code) on the archive. See [ios-release.md](ios-release.md) |
| `android-native.yml` (nightly) | `-PnekkoVersionName` and `-PnekkoVersionCode` |

## Local desktop development versions

`npm run dev` and `npm run local` identify unpackaged source as `<latest-reachable-release>-dev.<distance>+g<commit>` (`.dirty` for tracked edits). They do not stamp or rewrite package manifests. About, Settings and the launcher share this identity. Fetch release tags when a clone is stale: `git fetch origin 'refs/tags/v*:refs/tags/v*'`. A source archive or missing Git is labeled `-dev.unknown`; a clone without release tags uses the manifest base with a development suffix. Installed builds still show their exact stamped release/nightly version. Restart a running development app after pulling this change or creating a release tag; an existing main process keeps its launch-time identity.
