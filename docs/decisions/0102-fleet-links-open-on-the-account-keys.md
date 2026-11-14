---
status: accepted
date: 2026-11-14
---

# 0102. A computer in an org's list opens from your own desktop on the account's keys, with no pairing

Issue: [#2799](https://github.com/nekko-labs/nekko-agent/issues/2799). Umbrellas: [#2160](https://github.com/nekko-labs/nekko-agent/issues/2160), [#2585](https://github.com/nekko-labs/nekko-agent/issues/2585). Builds on [0066](0066-account-fleet-reuses-encrypted-account-trust.md) and [0086](0086-organizations-own-the-computer-fleet.md); keeps the handshake of [0041](0041-a-computer-proves-itself-and-every-connection-has-its-own-key.md). Encryption details: [docs/SYNC-ENCRYPTION.md](../SYNC-ENCRYPTION.md#connecting-to-your-own-computer-in-an-orgs-list).

## Context

Since 0086 a laptop signed in to the same account, and unlocked once, lists the Windows PC under Nekko Labs > Computers. It can't use it: discovery was deliberately not execution. The next request is to open a chat on the listed PC from the laptop and send prompts, still with no pairing code, QR or link.

A desktop can already drive another computer through Settings > Computers: a relay link that pairs once with a code, pins the computer's host key, then runs the protocol-6 handshake on every connection. What is missing is how the laptop learns where to dial, and why the PC should let it in without a code.

## Options considered

1. **Mint a pairing grant automatically.** The PC publishes a fresh code in its descriptor and the laptop pairs with it. Simple, but it puts a live credential in a blob every org-key holder can read, and leaves a permanent paired-registry entry that outlives the account trust that made it.
2. **Sign the HELLO with the account device key.** Each sync device has a P-256 key the account record lists. Using it for ECDSA as well as the ECDH it already does is key reuse, and an exact per-device proof isn't needed when every trusted device is equally trusted.
3. **Prove the account's current keyring inside the HELLO, and seal the connection details under it.** Only devices holding the account's current keys (the trusted, unrevoked ones) can read where to dial or make the proof. Revocation already rotates that keyring.

## Decision

Option 3.

- **The connect block.** While remote access is on, a sharing computer adds `connect` to its descriptor: relay routes, room, room secret and the relay agent's host key, sealed under the **account** keyring, bound to account, epoch, org, device and fleet revision. The org key opens the descriptor but not the block, so handing the org key to other members later gives them nothing to dial. The room secret is included because the relay and the room key need it; since protocol 6 the room secret alone gets nobody in, and the block reaches only devices of the same account.
- **The HELLO proof.** The device dials as a paired computer would and pins the host key from the block. Its HELLO adds a `fleet` object: the proof, sealed under the account's current keyring, binds the org, room, challenge, both ephemeral keys and the HELLO key. The computer compares each with the handshake it ran.
- **Admission from local state.** Same account, signed in and unlocked, the same key epoch, the device in the current account record, sharing on for that org. The device is welcomed as a computer under `fleet:<deviceId>`, an id pairing may never take, with its HELLO key as Change key. It is kept in memory only: no pairing code, no paired-registry entry, no activity file. The phone access policy and step-up checks apply unchanged.
- **Live revocation.** The computer checks every fleet device again on each Nekko Cloud status change and every 15 seconds, and kicks those no longer allowed. The connecting desktop drops its fleet links when it is signed out or locked. A fleet link is never saved, so a restart forgets it.
- **Catching up.** A computer whose account record or epoch is behind refuses with `fleet-device` or `fleet-epoch` and reads the account again in the background. The desktop tries once more after 3 seconds.
- **Scope.** v1 is one account. Another member's computer is listed but can't be opened. Phones get the same protocol later (separate issues), and the desktop is first.

## Consequences

- Philip's laptop opens a chat on the PC with no code, as soon as both are signed in and unlocked and the PC shares with the org with remote access on.
- Turning remote access off withdraws the block on the next beat, and nothing new can connect. A live link stays until the next check, at most 15 seconds, only when the change is sharing, the account or the record. Turning remote access off stops the relay agent at once.
- Any trusted device of the account can claim to be another one in its proof. Every one of them already holds the same keys and data, so this grants nothing new. It is written down as a stated limit.
- The outside cryptography review required before sync is switched on for anyone covers these two envelopes as well.
- It was wrong if a device without the account's current keyring could open a chat, if a revoked device's live link survived the next check, or if another account's member could read the room secret.
