---
status: accepted
date: 2026-10-22
---

# 0005. Seal key epochs to the recovery key's public half, and pin trust in a sealed account record

## Context

Round 1 wrapped each key epoch's keyring to the recovery key symmetrically. Revoking a device starts a new epoch, and that epoch must be recoverable too, but devices don't keep the recovery key (it's shown once). Rotation also has to decide which devices to wrap the new keyring to; trusting the server's device list would let a malicious server add its own key.

## Options considered

1. **Keep the recovery key on every device.** Simple, but a device compromise then also leaks the recovery key, and "shown once" stops meaning anything.
2. **Recovery key as a P-256 key pair; devices keep only its public half.** Rotations seal to it with the same ECIES as device wraps. Costs a deterministic key derivation (HKDF with a counter until the scalar is valid).
3. **Ask for the recovery key at every rotation.** Correct, but turns removing a lost phone into a scavenger hunt.

## Decision

Option 2, plus a sealed `account` record (collection `account`, local id `account`) holding the recovery public key and the trusted devices. Devices pin the recovery public key and ignore a record naming another. Rotation wraps only to devices in the sealed record that the server also lists as live. Nothing was stored in the round 1 format, so it was replaced (migration `0003` changes the size check).

## Consequences

- The recovery path survives any number of rotations without a device holding the secret.
- The server can't slip its own key into a rotation or swap the recovery key.
- The formats are frozen as `nekko-sync/v1` for the outside review; a later HPKE move is a version bump.
