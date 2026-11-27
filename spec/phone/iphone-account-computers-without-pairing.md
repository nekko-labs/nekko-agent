---
title: "iPhone: the account's computers connect without pairing (2026-11-28)"
area: phone
---

# iPhone: the account's computers connect without pairing (2026-11-28)

`[implemented 2026-11-28, iPhone only: the reach records, the route merge, the account HELLO and the refusals are unit-tested in NekkoKit and NekkoProtocol (swift test on macOS). The SwiftUI changes are small and were not compiled or run here (the local Xcode 27 build stops in the Watch widgets target, unrelated), and nothing was tried against a real computer, relay or device. Android is #3611]` Issue: [#3610](https://github.com/nekko-labs/nekko-agent/issues/3610). Decision 0128 (devices of one Nekko Cloud account connect without pairing; it lands with the engine side), building on [0102](../../docs/decisions/0102-fleet-links-open-on-the-account-keys.md) and [0116](../../docs/decisions/0116-nekko-cloud-relay-is-a-pro-perk-with-signed-tickets.md). The computer's side: [Nekko Cloud Relay](../platform/nekko-cloud-relay.md).

## User intent

Philip (2026-11-28): "I should not need to repair the device. The devices should be able to auto-connect since they are both part of the same user account." and "pairing should only be necessary for tailscale if the user doesn't have nekko cloud or they have it disabled."

## What the user sees

- Signed in to Nekko Cloud and joined to sync, the iPhone lists the account's computers that have remote access on, with no pairing and no QR. Such a computer reads **From your Nekko Cloud account** under its name in Computers.
- A computer already paired over Tailscale gains the Nekko Cloud Relay route by itself, so it stays reachable away from the tailnet without pairing again. The per-computer **Connect through** choice still limits which routes the phone dials.
- A computer from the account has no **Forget** and no **Sign out this phone** (there is no pairing to revoke). Signing out of Nekko Cloud removes it. It leaves too when the computer turns remote access off or account devices off.
- When the computer refuses, the connection row says why in plain words: account devices are off there (offer **Pair again**), it is signed out or locked, it belongs to another account, or it has not caught up with this iPhone or the newest sync key yet (the iPhone syncs and tries again, at most twice).

## How it works

- **Reading.** `CloudSync` opens `reach` records (the ordinary record envelope, current key epoch only, no older revision than one seen, and the opened record must hash back to the object id filed under its `deviceId`). A tombstone removes the record, this iPhone's own device id is ignored, routes must be `ws://` or `wss://` and at most four. The records are kept in the Keychain (they hold each room's secret) and dropped on sign-out or when the keys are forgotten.
- **Syncing.** The app now syncs on launch, on foreground and every 3 minutes while open (`CloudSync.syncQuietly`, started in `AppModel`), whenever the iPhone is signed in and joined, not only from the Cloud screens.
- **A paired computer.** `ComputersStore.applyReach` matches a record's `room` to a pairing's room. The record's routes are added at connect time (`withReach`, used by `relayConfig` and the route checks); the saved pairing is not rewritten. A changed route set rebuilds that link. A tombstone or a missing record takes the added routes away.
- **No pairing.** A record with no matching pairing is a computer with id `account:<device id>`, kept only in memory (never in the saved list), dialled with the record's routes, room, secret and pinned host key. Its HELLO has `deviceId` `fleet:<this iPhone's account device id>`, `platform` `ios`, no `pair`, and a `fleet` object `{v, accountId, keyId, deviceId, proof}`. The proof is the record envelope sealed under the current epoch's account keyring with associated data `nekko-sync/v1 fleet-hello\n{accountId}\n{keyId}\n{deviceId}`, over `{v:1, orgId:"", room, challenge, hostEph, clientEph, helloKey}` (`FleetLink`). The HELLO is still signed with the iPhone's HELLO key. Locked or signed out, no HELLO is sent.
- **Pairing later.** Pairing a computer the account already shows replaces the account entry with the pairing.
- **Pushes.** Only pairings enrol this iPhone for background pushes. A computer reached without pairing has not.

## Acceptance

- The proof matches the known-answer vector Android and `nekko-sync` use (`FleetLinkTests`).
- Reach records are applied, tombstoned and kept across a relaunch; tampered, swapped, flipped, rolled-back, other-epoch, own-id and malformed ones are ignored (`AccountReachTests`).
- A paired computer's routes merge by room without touching the pairing, and **Connect through** filters them; an account computer is dialled with the account HELLO and a pinned key and is never saved or signed out (`AccountComputersTests`).
- The HELLO of an account device carries `fleet`, never `pair`, and is signed (`RelayClientTests`).

## Not yet verified

- On a real iPhone, relay and computer. The engine side (publishing records, admitting `fleet:` HELLOs) is built in parallel and has not been exercised against this app.
- The SwiftUI changes (the Computers row subtitle, the hidden Forget and Sign out) and `AppModel`'s background sync compile in review only.
- A computer's name from the record is shown as is; renaming one from the iPhone is not saved.
- The retry after `fleet-device` and `fleet-epoch` waits two seconds after one sync. It has not been tuned against the computer's 15 second catch-up.
