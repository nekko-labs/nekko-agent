---
status: accepted
date: 2026-11-01
---

# 0036. The relay sees a derived room credential, never the pairing secret

## Context

A computer and its phones share a pairing secret (16 random bytes, in the
pairing QR). Two things were made from it: the AES-256-GCM key every relayed
frame is sealed with (PBKDF2-HMAC-SHA256, 100,000 rounds, salt
`nekko-relay:<room>`), and the `key=` both ends presented to the relay so it
could tell that a phone belongs in a room. Both came from the same value, and
the relay should hold nothing the E2E key is derived from: docs/REMOTE.md
promises that the relay routes ciphertext it cannot read, and that should not
depend on how a relay treats its inputs.

## Decision

1. **A separate credential for the relay.** Both ends present
   `relayAuth(secret, room) = hex(HMAC-SHA256(key = secret, "nekko-relay-auth:" + room))`
   as `key=`. HMAC is one-way, so the relay can still check that both ends hold
   the same pairing, and still keeps a hash of what the first agent claimed the
   room with, but it never receives anything the E2E key can be derived from.
   The E2E key derivation is unchanged: its input, the secret, now never leaves
   the two ends. Every implementation derives it the same way, checked against
   one shared vector (`crates/nekko-remote/tests/golden/crypto.json`,
   `e2e-vector.json` on both phones, `packages/shared/src/e2e.test.ts`).
2. **A pairing from before this is replaced, not reused.** Secrets created
   earlier reached the relay, so the computer gives itself a
   new room and secret the first time it starts with this version (`pairing: 2`
   in `remote.json`), keeping the list of paired devices and their settings.
   No compatibility path: a phone pairs again by scanning the new QR.
3. **Phones say so.** Both phone apps store the pairing format with each
   computer (`v: 2`). A computer saved before it is not dialed: the app shows
   the existing "pairing key changed" refusal, which tells the owner to pair
   again from *Settings → Remote access* on the computer. The same refusal
   shows when the relay answers `bad pairing key` (a computer and a phone on
   different sides of this change). The browser client drops a saved pairing
   without the version and asks to pair again.

## Options considered

1. **Derived relay credential, same E2E key derivation (chosen).** The smallest
   change that removes the secret from the relay's view on all four clients,
   with one new primitive (HMAC-SHA256) every platform already has.
2. **Also relabel the E2E derivation.** Changing the salt label would not add
   anything once the relay never sees the secret, and it would change the key
   every phone caches.
3. **An authenticated key exchange per connection.** Forward secrecy and no
   shared long-term secret, but a new handshake on four platforms; worth doing
   later, not needed to close this.

## Consequences

- Every phone pairs again once after the computer updates. A phone on an older
  app cannot connect to an updated computer (the relay refuses its credential),
  and an updated phone cannot connect to an older computer; both show the
  pair-again refusal or the app's existing bad-key message.
- A Nekko Cloud machine and the Local Web UI's relay-agent mode take the room
  and secret from their operator (`remote:attach`) and only change how the
  credential is derived; whoever created that secret still holds it.
- The HELLO is bound to a per-device key as well; see the addendum below.
- Spec: [spec/phone/relay-credential-and-re-pairing.md](../../spec/phone/relay-credential-and-re-pairing.md).

## Addendum (2026-11-01): the HELLO is signed with a device key

The pairing secret is shared by every phone of a computer and travels in the
pairing QR, so holding it should not be enough to connect as an enrolled
phone. Phone protocol 5 binds each HELLO to a key the device made itself:

- **A silent device key on each client.** iPhone: a P-256 key in the Secure
  Enclave with `.privateKeyUsage` only (a software key on the simulator).
  Android: an EC P-256 key in the Android Keystore without user
  authentication. Browser: a WebCrypto P-256 key kept beside the saved
  pairing. Unlike the Change key it never asks the owner, since every
  connection uses it.
- **What it signs.** `nekko-hello-v1`, the deviceId, the room and the
  connection's challenge, one per line (ECDSA P-256 SHA-256, raw r||s). The
  HELLO carries the public key (`helloKey`, X9.63) and the signature
  (`sig`). The challenge is fresh per connection, so a signature is good for
  one HELLO to one room.
- **Enrollment.** A HELLO with the live pairing code must be signed with the
  key it carries; the computer keeps that key (`remote-hello-keys.json` beside
  `remote.json`). Without the code, a known device must sign with the key it
  enrolled with. A device paired before device keys, or whose signature does
  not verify (a reinstalled app), is refused with `bad-key`, which both phone
  apps show as the pair-again message. A HELLO below protocol 5 is refused with
  `update-required`; the `acceptLegacyPhones` setting no longer admits phones
  older than this. Signing out every phone forgets every device key.
- **The Change key.** `device:registerKey` stays first-use for a device that
  has none, but it is now reachable only from a connection whose HELLO was
  signed with the enrolled device key, and an existing Change key is still
  never replaced (`key-mismatch`).
- One shared vector (`helloKey` in `crates/nekko-remote/tests/golden/relay-handshake.json`)
  is checked by the computer, both phones and the TypeScript client.
