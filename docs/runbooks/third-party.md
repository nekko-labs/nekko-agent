# Adding anything third-party

Read this before adding a package, crate, icon, font, image, sound, model, vendored file or downloaded runtime. Anything we did not make ourselves counts, free or paid.

## Before you add it

1. **Read the license where the thing comes from**, not a summary of it. Check the exact version or set you are taking: an older set from the same author can have different terms.
2. **Check the fit.** Permissive licenses (MIT, BSD, Apache-2.0, ISC) are fine. Stop and ask Philip about anything else: GPL or AGPL, non-commercial terms (CC BY-NC), "free for small teams" terms, or no license at all. Having no license means we have no right to use it.
3. **Save the license text** in the repo if it is not arriving through a package manager.

## When you add it

| What | Do this |
| --- | --- |
| npm package or crate | Nothing by hand: `scripts/third-party.mjs` picks it up. Run `node scripts/third-party.mjs check`. |
| Icon, font, image, sound, model, vendored code, downloaded runtime | Add a row to [ASSETS.md](../../ASSETS.md) with its version, license, license file and source. Use `-` for the file only when a package already carries it, or when a download brings its own notice. |
| Android library | Add it to `OpenSourceLicenses` in `LicensesScreen.kt`. The check does not read Gradle. |

## What runs

- **CI**: the `licenses` job in `ci.yml` runs `node scripts/third-party.mjs check` only when a `package.json`, lockfile, `Cargo.toml` or `ASSETS.md` changes. It fails on a license outside `scripts/license-policy.json`, and `gate` waits for it.
- **Packaging**: `dist` and `release` run `node scripts/third-party.mjs notices`, which writes `THIRD_PARTY_NOTICES.txt` into the app. It lists what the bundler actually used, plus production packages and every crate. Settings opens it from **Open-source licenses**.
- **Credits page**: [ASSETS.md](../../ASSETS.md) is the page at [nekkoagent.com/docs/credits](https://nekkoagent.com/docs/credits), so the list and the page cannot drift.

## When the check fails

Replace the dependency if you can. An exception in `scripts/license-policy.json` needs a reason that someone can check later, and only goes in after a person has read the license. Approval from a vendor goes in the same entry, with its date, and the approval itself goes into the workspace records.

Do not widen `allow` to get past a failure. It is for licenses that are fine everywhere, without review.
