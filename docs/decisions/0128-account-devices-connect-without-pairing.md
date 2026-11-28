# 0128. Devices of one Nekko Cloud account connect without pairing

Date: 2026-11-28. Status: accepted. Builds on [0102](0102-fleet-links-open-on-the-account-keys.md) (fleet links), [0116](0116-nekko-cloud-relay-is-a-pro-perk-with-signed-tickets.md) (Nekko Cloud Relay) and [0036](0036-the-relay-sees-a-derived-room-credential-never-the-pairing-secret.md).

## Context

Philip (2026-11-28): "I should not need to repair the device. The devices should be able to auto-connect since they are both part of the same user account." and "pairing should only be necessary for tailscale if the user doesn't have nekko cloud or they have it disabled."

Until now a phone learned how to reach a computer only from a pairing link. A phone paired over Tailscale had no Nekko Cloud Relay route until it paired again, and a phone that never paired could not reach the computer at all, though both were devices of the same account holding the same account keys. Decision 0102 already lets one account device reach another without pairing, but only through an organization's fleet, only between desktops, and with only the computer's main relay in the connect block.

## Decision

- **Cloud Relay is on by default for Pro.** While remote access is on and the account includes Nekko Cloud Relay, the computer holds its room there too, beside Tailscale or the LAN. The owner's untick is remembered in `remote.json` as `cloudRelay: "off"` and is never undone. A relay of the owner's own on the internet is left alone.
- **Each computer publishes a `reach` record.** It is a sync record in collection `reach`, with the local id set to the computer's account device id. It is sealed under the account keyring with the ordinary record envelope, so the server learns nothing. Plaintext:
  `{"v":1,"deviceId","name","routes":[...],"room","secret","hostKey"}`
  `routes` holds every relay the room is on (main relay first, at most 4). When remote access goes off, or the owner turns account devices off, the computer writes the tombstone `{"v":1,"deleted":true,"deviceId"}`. It is written whenever sync is ready (signed in, unlocked, on a plan that syncs), whatever the per-kind sync switches say, as `org-key` is (decision 0086).
- **An account HELLO.** A device that has no pairing proves itself with the 0102 fleet HELLO, using an empty `orgId` in the proof:
  - HELLO `deviceId` is `fleet:<accountDeviceId>`;
  - `fleet` is `{"v":1,"accountId","keyId","deviceId","proof"}`;
  - the proof plaintext is `{"v":1,"orgId":"","room","challenge","hostEph","clientEph","helloKey"}`, sealed by `seal_hello_proof` (associated data `nekko-sync/v1 fleet-hello\n{account}\n{keyId}\n{deviceId}`).

  The computer admits the device when all of these hold: the proof opens under its current keyring and matches the handshake, the device is in the current account record, and the owner has not turned off **Devices on my Nekko Cloud account connect without pairing** (`remote.json` `accountDevices: false`; on by default). It re-checks every 15 s, as for 0102 links. The device's class comes from the HELLO `platform`: a phone gets a phone's default access, exactly as a newly paired phone does. Org-scoped proofs (a uuid `orgId`) keep the 0102 rules.
- **Phones read `reach` records.** A phone signed in to Nekko Cloud and approved for sync reads them on launch, on foreground and every few minutes while open:
  - A record whose `room` matches a paired computer adds its routes to that computer. The phone keeps using its pairing; the computer already allows a device whose route is `auto` on every relay.
  - A record with no matching pairing becomes a computer **from your account**, dialled with the account HELLO.
  - A tombstone, or a record that disappears, removes the account computer. A paired computer only loses the routes the record added.
- **Pairing stays** for Tailscale without Nekko Cloud, for a phone not signed in, and for an owner who turned account devices off.

## Alternatives not taken

- **Phones add Nekko Cloud Relay to every pairing on their own.** This would dial the relay for computers that are not there, and it does nothing for a phone that never paired.
- **Reuse the org fleet descriptor.** That needs an organization with sharing on, plus org keys and org APIs on the phones. A solo Pro account has no org.
- **The account channel on the relay** as the source of routes. The channel carries topic-only nudges by design (0116). Routes and the room secret belong in a sealed, persistent record that a phone can read while the computer is offline.

## Consequences

- **The room secret is now in account sync.** It is sealed under the account keyring, as the 0102 connect block already was. The secret alone admits nobody: a HELLO must be from a paired device or carry a fresh account proof. A key-epoch rotation reseals the record, and a device dropped from the account fails the proof.
- **Phones need an update.** iOS and Android must read `reach` records, run sync in the background of the app, and port the HELLO proof. Android has the proof already (`FleetLink.kt`); iOS ports it against the shared vectors.
- **Account devices are not in the paired-device registry.** They show in Remote access as connected devices from the account, with no pairing to revoke. To shut them all out, turn account devices off (or sign the device out of the account).
