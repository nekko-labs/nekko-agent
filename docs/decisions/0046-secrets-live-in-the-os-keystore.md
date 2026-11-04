---
status: accepted
date: 2026-11-03
---

# 0046. Secrets live in the OS keystore

## Context

The 2026-11-03 GDPR audit (GD11, issue #1631) found provider API keys,
connector and MCP tokens in `settings.json` and every sign-in token in
`tokens.json`, as plain JSON. On macOS and Linux the files are 0600; on
Windows anything running as the user can read them, and both files travel
with any copy of the data folder. Nekko Cloud's token, linked computers' keys
and CI runners' keys already live in the OS keystore (`nekko_cloud::vault`).
Spec: [where API keys and sign-ins are kept](../../spec/models/models-providers.md#where-api-keys-and-sign-ins-are-kept-gd11-issue-1631).

`settings.json` is a byte-for-byte port of the old TS store with a golden
test, and about 20 modules read `apiKey` from the settings value, so the
change has to be invisible to readers.

## Options considered

1. **Encrypt the JSON files** with a key in the keystore. One keystore item,
   but the files keep their shape and every copy of the data folder still
   carries the ciphertext, plus a key-rotation story of its own.
2. **Change the settings format**: providers hold a reference, and readers
   look the key up. Every reader changes, the TS types change, and the golden
   no longer describes the file.
3. **The store moves the secrets, readers see no change**: the settings store
   and the token store keep secrets in the keystore and out of the files,
   filling them back into what they hand out. Migration happens on the first
   read: save, read back, then remove from the JSON.

## Decision

Option 3. `SettingsStore::with_vault` keeps a fixed list of secret fields
(`SECRETS` in `crates/nekko-settings`, mirrored as `SECRET_FIELDS` in
packages/shared) in the keystore, one item per secret named by its place
(`providers.<id>.apiKey`); `TokenStore::with_vault` keeps all sign-ins as one
item. Values are split over 1000-character items, since Credential Manager
holds 2560 bytes of UTF-16 and ChatGPT tokens are longer.

- **Never lose a key.** A secret leaves the file only after the keystore reads
  it back unchanged. A refused save leaves it in the file and leaves nothing
  half-written in the keystore, so a later removal cannot bring an old value
  back. Two list entries with one id keep the second in the file.
- **No keystore, no move.** Linux keeps the 0600 files (Secret Service needs a
  desktop session and D-Bus, which headless installs lack), as the cloud vault
  already does. Moving secrets from one 0600 file to another would gain nothing.
- **Backups carry no keys.** Settings export leaves every secret out and says
  so; import keeps this computer's keys for matching entries. A backup is a
  file people mail and sync; keys are re-entered on a new computer.
- **Tests never touch the login keychain.** Unit tests get no keystore; daemon
  tests run with `NEKKO_FILE_VAULT=1`, a file stand-in, as the cloud vault does.

## Consequences

- Readers are unchanged, but anything that reads `settings.json` or
  `tokens.json` from disk sees no secrets. `Accounts` now reads through the
  stores, and `claude_plan::migrate` saves the store's providers, not the
  file's. New code must read secrets through the stores.
- A new secret field is one line in `SECRETS` and one in `SECRET_FIELDS`.
- A dev build signed differently from the one that saved a Keychain item may
  be asked for Keychain access, as with the cloud vault.
- Resetting the settings and Delete everything delete the keystore items. An
  item whose entry was removed from `settings.json` by hand, outside the app,
  is not found and stays until the keystore is cleared (the Windows
  uninstaller's "delete data" clears every `dev.nekkolabs.nekko-agent.` item).
