---
title: "Third-party licensing and credits (2026-11-03)"
area: platform
---

# Third-party licensing and credits

## Intent

Everything Nekko Agent ships that someone else made is used under its license and credited properly. People can see what the app is built on, and the people who made it get their recognition. A new dependency with terms we have not reviewed cannot land by accident.

## What people see

- **In the desktop app:** Settings, under Updates, has **Open-source licenses**. It shows every package and crate in that build with its license text, and a **Credits** link opens the public page. Only packaged builds carry the file, so a development or Local Web UI run shows just the link.
- **On the web:** nekkoagent.com/docs/credits thanks the projects behind the app and lists the assets a package manager cannot see: icons, fonts, downloaded runtimes, models and vendored code.
- **On Android:** the existing Open-source licenses screen under About.
- **On iPhone:** there are no third-party packages. The one vendored library, Mermaid, ships with its license beside it.

## Rules

- Anything third-party is checked against its actual license before it is added, per [the runbook](../../docs/runbooks/third-party.md). This covers packages, crates, icons, fonts, images, sounds, models, vendored code and downloaded runtimes.
- [ASSETS.md](../../ASSETS.md) is both the assets list and the credits page, so the two cannot drift.
- `scripts/license-policy.json` holds the licenses accepted without review, and each reviewed exception with its reason.
- Remotion is not open source. Nekko Labs uses it with direct approval from Remotion, recorded 2026-11-03.

## Acceptance

- A pull request that changes dependencies or `ASSETS.md` fails `gate` when a license is outside the policy. Other pull requests skip the check.
- A packaged desktop app contains `THIRD_PARTY_NOTICES.txt`, and it includes packages the bundler pulled in from devDependencies, such as React.
- A packaged macOS app contains Chromium's notices.

## Known limits

- The Docker image's notices list npm packages only, because its build stage has no Rust toolchain.
- The check does not read Android's Gradle dependencies. That list stays hand-kept in `LicensesScreen.kt`.
- The `apps/cli` npm package and the `nekkod` npm packages do not carry a notices file yet.
