---
status: accepted
date: 2026-10-22
---

# 0007. Authenticate keyring wraps, approve devices with a join code, and keep one account record per key epoch

## Context

An internal adversarial review of sync ([reports/crypto-review-internal-2026-10-22.md](../../reports/crypto-review-internal-2026-10-22.md)) found the record crypto sound but the trust around it weak:

- A keyring wrap was plain ECIES, which anyone who knows a device's public key can make. Devices took any wrap that opened, for any epoch the server announced, so **anyone who could sign in to the account** (an emailed code is enough) could start an epoch, wrap a keyring of their own to every device, and read everything written afterwards. No server compromise was needed.
- Approval compared a fingerprint on two screens, then wrapped to whatever key the server returned at the click. The new device never checked who approved it.
- A `conflict` answer could lower a device's rollback guard. Records under an old epoch stayed acceptable, so a removed device that kept the old keyring could plant changes.
- Smaller gaps: tokens not rebound after signing in again (revoking missed them), every token could do everything, the iPhone kept one account's keys after signing in to another, and restore invented an account record when the server withheld it.

## Options considered

1. **Signing keys per device** (Ed25519 or P-256 ECDSA) over every wrap and rotation. The standard answer, but the iPhone's Secure Enclave key is a key-agreement key: a second key per device, a second public key to register, pin and compare.
2. **Static-static ECDH in the wrap derivation** (the shape of HPKE's Auth mode). The recipient opens a wrap only as coming from a sender it names, using a public key from its own trusted list. No new key type; one more ECDH per wrap.
3. **For approval: show both fingerprints and compare twice**, or **type a one-time code** whose tag binds the new device's key (checked by the approver) and whose derived key is mixed into the wrap (checked by the new device, the shape of HPKE's PSK mode).
4. **For old epochs: keep reading them** and only refuse new revisions, or **seal everything again under the new epoch** and accept only the current one.

## Decision

- **Option 2.** Device wraps are authenticated by the sending device. A device takes epoch *n+1* only from a device listed in its epoch-*n* account record, one epoch at a time, and only once epoch *n+1*'s own record lists it.
- **One account record per epoch** (local id `epoch-n`, `"v":2` with the epoch inside). A device accepts records only under the epoch it holds, deletes older keyrings, and the device that rotates seals every chat again under the new epoch.
- **Option 3, the typed join code** (80 bits). It checks both directions, can't be skipped, and needs no second comparison. The server sees only the tag.
- **The rollback guard never goes down.** A `conflict` below what a device has seen is an error. Restore refuses to run without the account's own record.
- **Server-side checks as a second layer.** Starting an epoch, adding wraps, pushing, removing other devices and wiping all need a token bound to a device holding the current epoch, or, for wiping, a sign-in from the last 10 minutes. Wraps are never overwritten and only go to the current epoch. Tokens are rebound on every sign-in. Linking an existing account by email needs a verified email. Migration `0004` adds `sync_devices.join_tag`.
- Nothing was stored in the earlier formats, so they were replaced in place (still `nekko-sync/v1`; the formats freeze for the outside review).

## Consequences

- Someone who can only sign in can no longer get a key trusted, and the server can't swap a key at approval, roll a device back, or use an old epoch.
- **Still open, and in the outside review's questions:** a malicious server colluding with a removed device can fork devices that haven't seen a rotation, and can give a device restoring with the recovery key an epoch the removed device made (the recovery wrap has no sender to authenticate). Fork consistency between devices is future work. The id key doesn't rotate.
- Approving a device means typing 16 characters instead of comparing them. A QR code for phone ↔ computer is a later convenience.
- `crates/nekko-cloud/tests/attacks.rs` keeps the attacks as tests, through a proxy that rewrites the real API's answers.
- Supersedes the account-record part of [0005](0005-recovery-key-as-a-p256-key-and-sealed-account-record.md) (one record for the account → one per epoch); the recovery key as a P-256 key pair stands.
