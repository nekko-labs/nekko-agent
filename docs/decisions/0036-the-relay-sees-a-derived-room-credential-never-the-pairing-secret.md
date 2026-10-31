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
- Not covered here: binding the HELLO to a per-device signing key, so that a
  holder of the pairing secret alone cannot act as an enrolled phone. The
  Change key (`device:registerKey`) needs the owner's unlock on every use, so
  it cannot sign every connection; that needs a second, silent device key on
  both phones. Tracked as follow-up work.
- Spec: [spec/phone/relay-credential-and-re-pairing.md](../../spec/phone/relay-credential-and-re-pairing.md).
