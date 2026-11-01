# Release signing

How Nekko Agent's macOS and Windows builds get signed (and, on macOS,
notarized), what is wired, and what needs a human with an Apple or Azure account.

Everything here is **secret-gated**. With no signing secrets configured the
release still builds and publishes, just unsigned, so nothing below can block a
release. A *partially* configured set fails the job before building, because a
signed-but-unnotarized app is still blocked by Gatekeeper while looking like it
worked.

## Status at a glance

| Platform | Mechanism | Wired | Blocked on |
| --- | --- | --- | --- |
| macOS | Developer ID codesign + notarization | ✅ live since v0.6.0 | nothing |
| Windows | Authenticode via Azure Artifact Signing | ✅ secret-gated | Azure identity validation + the secrets below |
| Linux | none (AppImage/deb are unsigned) | n/a | n/a |

## How the app checks an update before installing it

Besides the SHA-512 from the release feed, the in-app updater checks the
publisher of what it is about to install against the app that is running, so
the check does not depend on `publisherName` in `app-update.yml`:

- **macOS:** when the running app is signed by a Developer ID team, the new
  bundle must pass `codesign --verify --deep --strict` against a requirement
  anchored to Apple that names the same team, before it replaces the app. If
  it does not, the update is dropped and the running app is reopened.
- **Windows:** when the running app is validly Authenticode-signed, the
  installer must be validly signed with the same certificate subject (and,
  when `publisherName` is set, by one of those names, as before).
- A local or unsigned build skips these checks, since it has no publisher to
  compare against.

## macOS

Nekko Agent is packaged by electron-builder, which does the signing, hardened
runtime, and notarization itself. There is no hand-rolled `codesign` pipeline
here, and no `Developer ID Installer` certificate is needed, because the
artifacts are `.dmg`/`.zip` rather than a `.pkg`.

What is configured, in `apps/desktop/electron-builder.yml`:

- `hardenedRuntime: true` — required for notarization
- `entitlements` / `entitlementsInherit` → `build/entitlements.mac.plist`
- `notarize: false` by default, flipped on with `-c.mac.notarize=true` by the
  release workflow, so a local `npm run dist` does not need the Apple API key

`apps/desktop/scripts/after-pack.cjs` ad-hoc signs the app **only when no real
certificate is present**, so unsigned local builds still launch on Apple
Silicon. It steps aside when `CSC_LINK` is set.

### The entitlements, and why each one is there

The hardened runtime disables things Electron and Nekko Agent need. See the
comments in [`build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist);
the short version:

| Entitlement | Needed for |
| --- | --- |
| `allow-jit`, `allow-unsigned-executable-memory` | V8 |
| `disable-library-validation` | the `@lydell/node-pty` prebuilt `.node`, dlopen'd from outside the asar |
| `allow-dyld-environment-variables` | spawning shells, agents, and MCP servers |
| `files.user-selected.read-write` | the user's project folders |
| `network.client` / `network.server` | model providers and the local phone-relay server |
| `device.camera` | the QR pairing scanner |

`NSCameraUsageDescription` is set via `mac.extendInfo`. Without it macOS kills
the process instead of prompting when the QR scanner opens.

### The VM helper's entitlement

`Contents/Resources/bin/nekko-vm`, the CI runner VM helper, is the only binary
that carries `com.apple.security.virtualization`. Virtualization.framework
refuses to create a VM without it. It is never in `build/entitlements.mac.plist`:
that file is both `entitlements` and `entitlementsInherit`, so the app, its
helpers, nekkod and everything nekkod starts would hold it too, and any agent
process could then boot a VM.

- **Release signing:** `mac.sign` in `electron-builder.yml` points at
  `apps/desktop/scripts/sign-mac.cjs`, the stock osx-sign run (through
  `app-builder-lib`, pinned to the same version as `electron-builder`) except
  that `nekko-vm` is signed with `crates/nekkod/vm/nekko-vm.entitlements`, which
  grants that one entitlement and nothing else.
- **Unsigned builds:** `after-pack.cjs` ad-hoc signs the app with `--deep`,
  then signs `nekko-vm` again with its own file and reseals the app.
- **Staging:** `stage-daemon.mjs` builds `nekko-vm` with `xcrun swiftc` and
  stages it beside nekkod. On Apple silicon a packaged build fails if it cannot.
  The image builder's guest scripts go beside it in `runner-image/`. They are
  text, so they are never signed, and `check-mac-entitlements.sh` skips that folder.
  Building with the macOS 27 SDK is what gives `nekko-vm` first-boot support, so
  `release.yml` and `installers.yml` build macOS on the `xcode-27` runner.

`scripts/check-mac-entitlements.sh <app>` reads the entitlements of the app,
every helper app under `Contents/Frameworks` and every file under
`Contents/Resources/bin`, and fails if `nekko-vm` is missing, lacks the
entitlement, anything else has it, or `codesign` cannot read a file. Where it
runs:

- `release.yml`, step `Check the virtualization entitlement`, right after the
  build, on every macOS release, signed or not.
- `installers.yml`, on PRs that touch packaging: the same check on the unsigned
  build, then `Signed dry-run through the release hook`, which runs
  `apps/desktop/scripts/sign-mac-dry-run.cjs` on a copy of the app. That is the
  real `sign-mac.cjs` hook with the ad-hoc identity `-` in place of the
  Developer ID, followed by `codesign --verify --deep --strict`, the check, and
  `nekko-vm count-vms`.

By hand, on an Apple silicon Mac, with no credentials (build first: the
workspace `dist` packages what `npm run build` left, and the root `npm run dist`
does both):

```bash
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist -w @nekko-agent/desktop -- --publish never
scripts/check-mac-entitlements.sh "apps/desktop/release/mac-arm64/Nekko Agent.app"
ditto "apps/desktop/release/mac-arm64/Nekko Agent.app" /tmp/dry-run.app
node apps/desktop/scripts/sign-mac-dry-run.cjs /tmp/dry-run.app
```

Still needs Philip (Developer ID certificate, a real release):

- [ ] `npm run build`, then
  `CSC_NAME="Nekko Labs LLC (3HM5598S99)" npm run dist -w @nekko-agent/desktop -- --publish never`,
  then the check above exits 0 and `codesign --verify --deep --strict --verbose=2`
  passes on the app; open it, connect a runner and see one VM boot from the
  signed `nekko-vm`.
- [ ] On the next tag, `Check the virtualization entitlement` is green on the
  signed, notarized macOS build and `Verify the signed app` still passes.

## Secrets

These are **`nekko-labs` organization secrets**, shared with `hypergate` and
`lightwrite`, so the certificate is uploaded and rotated in exactly one place.

| Secret | What it is |
| --- | --- |
| `MACOS_SIGNING_CERTS_P12` | base64 of the Developer ID `.p12` (→ `CSC_LINK`) |
| `MACOS_CERT_PASSWORD` | password for that `.p12` (→ `CSC_KEY_PASSWORD`) |
| `APPLE_API_KEY_P8` | App Store Connect API key contents |
| `APPLE_API_KEY_ID` | ASC key id |
| `APPLE_API_ISSUER` | ASC issuer id (a UUID) |
| `AZURE_SIGNING_TENANT_ID` | Entra tenant of the signing service principal |
| `AZURE_SIGNING_CLIENT_ID` | its application (client) id; the Windows gate |
| `AZURE_SIGNING_CLIENT_SECRET` | its client secret |

Plus four non-secret **organization variables** (`gh variable set --org`), also
read by the Windows leg: `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
`AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_PUBLISHER`. See [Windows](#windows).

Certificate: `Developer ID Application: Nekko Labs LLC (3HM5598S99)`.

### Uploading them

Run on a Mac that has the Developer ID certificate **and its private key** in
the login keychain (`security find-identity -v -p codesigning` to confirm).
Requires org-admin on `nekko-labs`.

Export the `.p12` from **Keychain Access** (login → My Certificates → expand the
`Developer ID Application: Nekko Labs LLC` row so the private key goes with it →
Export), rather than with `security export -t identities`, which dumps *every*
identity in the keychain into one bundle. Either way you choose an export
password, which becomes `MACOS_CERT_PASSWORD`.

Then, and read the warning below before pasting:

```bash
gh secret set MACOS_SIGNING_CERTS_P12 --org nekko-labs --visibility all < <(base64 -i /tmp/nekko-signing.p12)
gh secret set APPLE_API_KEY_P8 --org nekko-labs --visibility all < AuthKey_XXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --org nekko-labs --visibility all --body AuthKeyIdHere
```

> **Do not paste those as a block with the two interactive ones.** `gh secret
> set` without `--body` reads its value from **stdin**, so a pasted command on
> the following line is consumed as the secret. That is how `MACOS_CERT_PASSWORD`
> once ended up holding the literal text `gh secret set MACOS_CERT_PASSWORD
> --org nekko-labs --visibility all`, which surfaced only as `MAC verification
> failed during PKCS12 import (wrong password?)` in a release job.

Set the two interactive secrets one at a time. In zsh the prompt form is
`"VAR?prompt"`, not bash's `-p`:

```bash
read -rs "P?p12 password: " && gh secret set MACOS_CERT_PASSWORD --org nekko-labs --visibility all --body "$P" && unset P
read -rs "P?issuer UUID: " && gh secret set APPLE_API_ISSUER --org nekko-labs --visibility all --body "$P" && unset P
```

Then delete the export: `rm -P /tmp/nekko-signing.p12`.

**Verifying the `.p12` locally is a trap.** Keychain encrypts the payload with
`RC2-40-CBC`, which OpenSSL 3 moved to the legacy provider, so
`openssl pkcs12 -info` fails with `unsupported ... RC2-40-CBC` and reads like a
bad password. Pass `-legacy`. The password check that actually matters is the
MAC: a genuinely wrong password says `Mac verify error: invalid password?`,
while reaching the cipher error at all means the password was accepted.

```bash
openssl pkcs12 -in /tmp/nekko-signing.p12 -info -noout -legacy
```

Look for a **Shrouded Keybag** line, which confirms the private key is in the
export. macOS `security import` reads the legacy encryption natively, so no
re-export is needed for CI.

### When the App Store Connect key rotates

The notary key is the one credential here that can die without any secret
changing: an App Store Connect API key gets revoked or rotated in Apple's
portal, and `APPLE_API_KEY_ID` / `APPLE_API_KEY_P8` quietly keep pointing at a
key that no longer exists. That happened on 2026-09-06, when the team's key was
replaced and the old one revoked. Every release from v0.7.1 on then signed
fine and died in notarization, five minutes into the job, with:

```
Failed to notarize via notarytool. ... HTTP status code: 401. Unauthenticated.
```

The release workflow now checks the key *before* building ("Validate the
notary credentials"), using the same read-only call you can run locally
against a candidate `.p8`:

```bash
xcrun notarytool history --key AuthKey_XXXXXXXX.p8 --key-id XXXXXXXX --issuer <issuer UUID>
```

A live key lists past submissions (Nekko Agent's and hypergate's, since they
share the team). A revoked one returns the 401 above. The issuer id is per
team and does not change when the key does.

To rotate, with a key whose App Store Connect role is Developer or above, and
after confirming the file really is a private key
(`openssl pkey -in AuthKey_XXXXXXXX.p8 -noout` exits 0):

```bash
gh secret set APPLE_API_KEY_P8 --org nekko-labs --visibility all < AuthKey_XXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --org nekko-labs --visibility all --body XXXXXXXX
```

Then re-run the Release workflow at the tag that failed:

```bash
gh workflow run release.yml --repo nekko-labs/nekko-agent --ref vX.Y.Z
```

The secrets are organization-wide, so one rotation also repairs hypergate and
lightwrite.

## Windows

Windows installers are signed with **Azure Artifact Signing** (Microsoft's
managed code signing, formerly Trusted Signing). A `.p12` is no longer an
option: since June 2023 the CA/B Forum requires every new code-signing key to
live in a hardware module, so no new Authenticode certificate can be exported
to a file for CI. Artifact Signing holds the key, issues short-lived
certificates in the validated organization's name, and costs about $10 a month
on the Basic tier.

electron-builder 26 signs through it natively (`win.azureSignOptions`, which
runs the `TrustedSigning` PowerShell module on the runner). The release
workflow passes the options as `-c` flags only when `AZURE_SIGNING_CLIENT_ID`
is set, so a local `npm run dist` never tries to reach Azure. It signs the app
`.exe`, the uninstaller and the NSIS installer, and then "Verify the signed
installer" fails the job unless each one has a `Valid` signature from
`CN=<AZURE_SIGNING_PUBLISHER>` with a timestamp. With no client id the build is
unsigned (SmartScreen shows "unknown publisher") and the release still ships;
a client id without the rest fails before packaging.

`AZURE_SIGNING_PUBLISHER` is also written into `app-update.yml`, and
electron-updater refuses an update not signed by that publisher. Set it to the
certificate's common name exactly (the validated legal name, e.g.
`Nekko Labs LLC`) and never change it casually: installs on the old name would
stop accepting updates.

### One-time setup (needs Philip: Azure owner + company documents)

1. In the Azure portal, register the `Microsoft.CodeSigning` resource provider
   on the subscription, then create an **Artifact Signing account** (Basic)
   in a supported region, e.g. East US (`https://eus.codesigning.azure.net`).
2. **Identity validation → Public Trust → Organization** for Nekko Labs LLC.
   This is the slow, human step: Microsoft verifies the business (registration
   documents, a domain email) and usually answers in a few business days. Only
   a validated identity can back a public certificate.
3. Create a **certificate profile** (type *Public Trust*) on that identity.
4. Create the CI identity and give it signing rights on the account only:

```bash
az ad sp create-for-rbac --name nekko-agent-release-signing
# note appId (client id), password (client secret), tenant
az role assignment create --assignee <appId> \
  --role "Trusted Signing Certificate Profile Signer" \
  --scope <the signing account's resource id>
```

   (Newer tenants may list it as "Artifact Signing Certificate Profile
   Signer" after the rename; it is the same role.)

5. Store them on the org. Set the client secret interactively, one command at
   a time (see the stdin warning under macOS):

```bash
gh secret set AZURE_SIGNING_TENANT_ID --org nekko-labs --visibility all --body <tenant>
gh secret set AZURE_SIGNING_CLIENT_ID --org nekko-labs --visibility all --body <appId>
read -rs "P?client secret: " && gh secret set AZURE_SIGNING_CLIENT_SECRET --org nekko-labs --visibility all --body "$P" && unset P
gh variable set AZURE_SIGNING_ENDPOINT --org nekko-labs --visibility all --body https://eus.codesigning.azure.net
gh variable set AZURE_SIGNING_ACCOUNT --org nekko-labs --visibility all --body <account name>
gh variable set AZURE_SIGNING_PROFILE --org nekko-labs --visibility all --body <certificate profile name>
gh variable set AZURE_SIGNING_PUBLISHER --org nekko-labs --visibility all --body "Nekko Labs LLC"
```

6. Re-run the release at the latest tag
   (`gh workflow run release.yml --repo nekko-labs/nekko-agent --ref vX.Y.Z`)
   and check the "Verify the signed installer" step.

The client secret expires (two years by default with `create-for-rbac`); when
it does, the Windows leg fails in the signing step with an Entra `AADSTS7000222`
error. Rotate with `az ad sp credential reset --id <appId>` and re-set
`AZURE_SIGNING_CLIENT_SECRET`.

SmartScreen reputation: Artifact Signing certificates carry the validated
organization name, and reputation accrues to that identity rather than to one
certificate, so warnings fade as installs accumulate instead of resetting with
every short-lived certificate.

### The installer itself

The NSIS installer is **one click**: double-clicking it shows a short branded
progress window, installs per user into `%LOCALAPPDATA%\Programs`, adds Start
Menu and desktop shortcuts and the Add/Remove Programs entry, and opens the
app. There is no UAC prompt and no wizard page. Uninstalling still asks whether
to remove chats and settings (`build/installer.nsh`); a silent uninstall,
including the one electron-updater runs, keeps them.

Certificates expire (Developer ID is 5 years). When it rolls, re-export and
re-run the two `MACOS_*` commands; nothing in this repo changes.

## The macOS drag-to-install window

The `.dmg` opens to a Finder window with the app on the left, the Applications
folder on the right, and a pixel Nekko leaping between them under "Drag the cat
into Applications". The art is generated, not drawn by hand:

```bash
node apps/desktop/scripts/gen-dmg-art.mjs
```

writes `build/background.png` (640x400) and `build/background@2x.png`, which
dmg-builder merges into a HiDPI `.background.tiff`. The icon positions in the
`dmg` section of `electron-builder.yml` must match `APP_X` / `APPS_X` / `ICON_Y`
in the script. Two Finder facts shaped the layout: icon labels are drawn
**black** even in dark mode, so they sit on light sage ledges, and a user who
shows Finder's path and status bars loses the bottom ~50px of the window, so
the copy is at the top.

The `Installers` workflow (`.github/workflows/installers.yml`) builds both
installers unsigned on any PR that touches their config, installs and
uninstalls the Windows one silently, and checks the disk image has its
background, layout and Applications link.

## npm publishing

The `publish-cli` job uses npm Trusted Publishing as its primary authentication
path. npm's documented requirements are Node `22.14.0` or newer and npm
`11.5.1` or newer; the workflow uses Node 24 and installs npm 11.5.1
explicitly. It prints both versions before publishing and disables
`setup-node` dependency caching because npm's release guidance says not to use
package-manager caching in release builds.

Trusted Publishing uses the GitHub Actions OIDC token from
`id-token: write`. npm automatically generates provenance attestations for
trusted publishes, so the OIDC path does not need `--provenance`. While
bootstrapping, `NPM_TOKEN` remains an optional fallback; that path explicitly
adds `--provenance`. If neither credential works, the workflow prints a
message directing the maintainer to configure the trusted publisher or add
`NPM_TOKEN`.

### First publish bootstrap

npm's documented setup is under an existing package's settings, and npm does
not currently provide a PyPI-style pending publisher for a package name that
has never been published. Publish `nekko-agent` once manually with account
authentication and 2FA:

```bash
npm login
npm publish --workspace=apps/cli --access public
```

Then open the `nekko-agent` package settings on npmjs.com and add a GitHub Actions
trusted publisher with:

| Field | Value |
| --- | --- |
| Organization or user | `nekko-labs` |
| Repository | `nekko-agent` |
| Workflow filename | `release.yml` |
| Allowed action | `npm publish` |

The workflow file is `.github/workflows/release.yml`; npm wants only the
filename in this field. After confirming a tagged publish succeeds through
OIDC, harden the package's Publishing access settings by requiring 2FA and
disallowing token-based publishing, then revoke the temporary `NPM_TOKEN`
secret. The release job will continue using OIDC after the token is removed.

### The @nekko-agent scope

`publish-web` publishes the engine as one package per platform
(`@nekko-agent/nekkod-win32-x64`, `-linux-x64`, `-linux-arm64`,
`-darwin-arm64`) before `nekko-agent-local-web-ui`, and `publish-cli` pins the
same packages, so both jobs need the scope. v0.8.1 failed here with
`404 Not Found - PUT .../@nekko-agent%2fnekkod-darwin-arm64`: npm answers 404,
not 403, when the scope's organization does not exist or the token cannot
write to it.

One-time setup, on npmjs.com, signed in as the account that owns
`nekko-agent`:

1. Create the free organization `nekko-agent` (this is the `@nekko-agent` scope).
2. Create a granular access token with **Read and write** on packages and on
   the `@nekko-agent` scope (a token limited to selected packages cannot
   create new ones), and store it as the repository secret `NPM_TOKEN`.
3. After the first tagged release publishes them, add the same trusted
   publisher as above to each `@nekko-agent/nekkod-*` package and to
   `nekko-agent-local-web-ui`, then harden and revoke the token as above.

Re-running a failed release is safe: each publish skips a version that is
already on npm.

## Verifying a release

## Installer and updater targets

The release workflow intentionally publishes only targets with a clear
installation story:

| Platform | Artifact | `electron-updater` support |
| --- | --- | --- |
| Windows | NSIS `.exe` | ✅ automatic updates |
| macOS | `.dmg` plus required `.zip` metadata artifact | ✅ automatic updates |
| Linux | AppImage | ✅ automatic updates |
| Linux | `.deb` | ✅ supported by current electron-builder updater docs |

The Windows MSI and ZIP targets are not built: MSI is not an updater target and
the ZIP would duplicate the NSIS installation path without adding an updater
benefit. The current electron-builder documentation lists macOS DMG, Windows
NSIS, and Linux AppImage/DEB as auto-updatable targets. Unsigned builds can
still be installed, but signing warnings are independent of updater support.

The release workflow already runs these on every signed macOS build and fails
if any of them do. To check a downloaded `.dmg` by hand:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Nekko Agent.app
spctl --assess --type execute --verbose=4 /Applications/Nekko Agent.app
xcrun stapler validate /Applications/Nekko Agent.app
```

`spctl` should say `accepted` with `source=Notarized Developer ID`.

## Building signed locally

Only needed when debugging the signing config itself.

```bash
CSC_NAME="Nekko Labs LLC (3HM5598S99)" npm run dist -w @nekko-agent/desktop
```

`CSC_NAME` takes the certificate's **common name without the type prefix**.
Passing the full `Developer ID Application: ...` string fails with *"Please
remove prefix ... appropriate certificate will be chosen automatically"*.

That signs with the local keychain identity but does **not** notarize, so
`stapler validate` will fail on the result. That is expected; Gatekeeper on the
build machine still accepts it because the machine trusts the developer.
