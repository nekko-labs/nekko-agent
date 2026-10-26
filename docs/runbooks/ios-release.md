# Release native iOS to TestFlight

Use the GitHub Actions **iOS TestFlight** workflow (`.github/workflows/ios-testflight.yml`) for a requested iOS release. Release the native app in `apps/ios`, not the older Expo app in `apps/mobile`. Do not use EAS for this path.

## Trigger

From an authenticated checkout:

```sh
gh workflow run ios-testflight.yml --repo nekko-labs/nekko-agent --ref main \
  -f notes='What testers should check' -f only_if_changed=false
gh run list --repo nekko-labs/nekko-agent --workflow ios-testflight.yml --limit 5
```

A manual dispatch forces an upload attempt, even without source changes. Main pushes affecting shipping iOS sources also trigger the workflow, with a changed-source check. The existing `v*` tag workflow releases desktop, not iOS; no iOS release tag is needed. Re-read the workflow before releasing if its triggers change.

## Verification

1. Record the run URL and its head SHA. Follow the archive and export/upload steps, not just successful dispatch.
2. Read the summary for marketing version and build number. The version comes from `apps/ios/project.yml`; the build number is the workflow run number plus 100.
3. Confirm export/upload succeeded. Apple processing and TestFlight group availability are separate checks in App Store Connect; a green workflow alone does not prove testers can install.
4. After processing, add the build to the intended TestFlight group if needed. Do not imply this publishes an App Store production release.

```sh
gh run view <run-id> --repo nekko-labs/nekko-agent
gh run view <run-id> --repo nekko-labs/nekko-agent --log-failed
```

While a run is pending, finish independent verification and documentation. Register a bounded continuation before ending a turn waiting for it.

## Signing failures

The workflow uses the repository's App Store Connect API key and Apple team configuration. Never print private keys or export credentials into documentation. If Xcode reports the certificate quota is full or provisioning profiles cannot be created, stop retrying. Reuse an existing signing certificate and private key, or have the owner identify an unused certificate safe to revoke. Do not revoke certificates autonomously: other releases may depend on them.

### Why the certificate quota kept filling (fixed 2026-10-26)

`xcodebuild archive` with automatic signing signs every target with an **Apple Development** identity first; the App Store export re-signs afterwards with the cloud-managed distribution certificate. A GitHub runner starts with an empty keychain, so on every run Xcode created a new `Apple Development: Created via API` certificate through the API key, and its private key was thrown away with the runner. Twelve uploads from 2026-10-23 filled the team's development certificate cap, and from 2026-10-25 every archive failed with "Your account has reached the maximum number of certificates". Revoking certificates only bought a few more runs.

The workflow now imports one fixed CI development identity before archiving, and Xcode reuses it instead of minting one. It lives in two repository secrets:

| Secret | What it is |
| --- | --- |
| `IOS_DEV_CERT_P12` | base64 of a `.p12` holding an `Apple Development` certificate on team `3HM5598S99` **and its private key** |
| `IOS_DEV_CERT_PASSWORD` | that `.p12`'s password |

Without them the run still works but logs a warning, and mints a certificate as before. To set them (one command at a time, see the stdin warning in [docs/signing.md](../signing.md)):

```sh
gh secret set IOS_DEV_CERT_P12 --repo nekko-labs/nekko-agent < <(base64 -i nekko-agent-ci-dev.p12)
read -rs "P?p12 password: " && gh secret set IOS_DEV_CERT_PASSWORD --repo nekko-labs/nekko-agent --body "$P" && unset P
```

The certificate expires after a year; when it does, the archive fails on signing. Make a new one, re-set the two secrets, and revoke the old one. Any `Apple Development: Created via API` certificate on the account other than the CI one is an orphan from a past run (its key is gone) and is safe to revoke.
