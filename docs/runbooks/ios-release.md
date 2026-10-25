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

On 2026-10-25, [run 40186663943](https://github.com/nekko-labs/nekko-agent/actions/runs/40186663943) failed during archive because the account had reached its certificate limit and profiles were unavailable for the app and its extensions. Treat this as a known signing blocker until a later run proves it resolved.
