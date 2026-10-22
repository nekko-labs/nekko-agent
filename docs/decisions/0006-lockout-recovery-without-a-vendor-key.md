---
status: proposed
date: 2026-10-22
---

# 0006. Recover lockouts without a key Nekko Labs can use

## Context

Philip asked what other companies do for users locked out of E2EE data, and whether they keep a backup key. Research: [reports/e2ee-lockout-recovery-2026-10-22.md](../../reports/e2ee-lockout-recovery-2026-10-22.md). None of the serious vendors keep a key they can use alone. They combine a key the user keeps, other devices, a trusted contact (Apple splits the secret with the contact), a short PIN or passcode held in HSMs or enclaves that erase after about 10 guesses (Apple, Google, WhatsApp, Signal), or an organization admin key (Bitwarden, 1Password, Dashlane, Tresorit).

## Options considered

1. **A backup key Nekko Labs holds.** Easiest for users. Breaks "Nekko Labs can't read your chats" and is exactly what a government can compel. Rejected.
2. **Recovery key and other devices only** (built): printable kit with a QR code, confirm by retyping, a prompt to add a second device.
3. **A recovery contact** (Apple-style split): the contact holds one half, Nekko Cloud the other, release needs both plus a delay any of the user's devices can cancel.
4. **Team admin recovery**, opt-in per member, with a team key only admins' devices hold and members pin.
5. **PIN recovery in hardware** (Juicebox across independent operators, or a Nitro Enclave with a guess limit): best experience, weakens the claim to "provided the hardware and our published code hold".

## Decision

Accepted now: never option 1; option 2 is built. Proposed, for Philip to decide: option 3 as the first addition after launch, option 4 with the Team plan, option 5 only if lockouts become a real support cost.

## Consequences

Users who lose every device and their recovery key lose the synced copy (their chats still exist on any device that had them). Support must say so plainly, and the onboarding has to make the recovery key hard to skip.
