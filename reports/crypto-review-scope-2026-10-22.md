# Outside cryptography review: scope and request for proposal

*Prepared 2026-10-22 for Nekko Labs (Nekko Agent). This is the packet to send to review firms. An internal adversarial review was done first; its findings and fixes are in [crypto-review-internal-2026-10-22.md](crypto-review-internal-2026-10-22.md) and [decision 0007](../docs/decisions/0007-authenticated-wraps-and-join-codes.md). It does not replace this review.*

## What we want reviewed

End-to-end encrypted chat sync for Nekko Agent's paid plans, before it is switched on for any user. The goal is that Nekko Labs, and anyone holding Nekko Cloud's servers or database, cannot read users' chats, forge or swap them, roll them back unnoticed, slip a device of their own into an account, or get keys. A device the user revokes must not read anything written after that.

## In scope

| Area | Code | Size (lines, 2026-10-22) |
| --- | --- | --- |
| Crypto primitives and formats (reference) | `crates/nekko-sync` | 1,006 Rust |
| Client protocol: sign-in, device registration, keyring setup, recovery, approval, revocation and key rotation, pull/push/merge | `crates/nekko-cloud` | 2,045 Rust |
| Server: token exchange (Supabase JWT via JWKS), device tokens, plan gating, storage API, donations | `apps/nekko-agent-api/src`, `migrations/` | 1,152 TypeScript and SQL |
| iPhone port of the crypto and the phone's client protocol | `apps/ios/Protocol/Sources/NekkoProtocol/SyncCrypto.swift`, `NekkoKit/CloudSync.swift` | 1,262 Swift |
| Offline research-key tooling (donations) | `scripts/research-key.mjs` | 94 JavaScript |

Design and threat model: `docs/SYNC-ENCRYPTION.md`. Shared test vectors: `crates/nekko-sync/tests/golden/sync-crypto.json`. A local stack to run everything end to end without any cloud account: `apps/nekko-agent-api` → `npm run dev:local` (Postgres in memory and a stand-in for Supabase Auth), then `cargo test -p nekko-cloud --test live --test attacks` with `NEKKO_CLOUD_ITEST_URL` (the attacks test runs the internal review's attacks through a proxy that rewrites the server's answers).

## Out of scope

The relay between phone and computer (an older, separate E2E layer, reviewed separately if wanted), the desktop app's UI, Supabase itself, and hosting (Fly.io, Neon).

## Questions we most want answered

1. Is the construction sound: per-record keys from HKDF with a random salt, AES-256-GCM with the record's identity as associated data, Padmé padding, HMAC object ids, and hand-rolled ECIES over P-256 (in place of HPKE): Auth-mode-like for device wraps (static-static ECDH), PSK-mode-like for join wraps, base mode for the recovery wrap and donations?
2. The recovery key derives a P-256 key pair (HKDF with a counter until the scalar is valid). Is the derivation and its use sound?
3. Trust establishment: the first device, joining by recovery key, joining by approval with an 80-bit typed join code (tag over the new key; PSK in the wrap), and the per-epoch sealed account record (trusted devices and the pinned recovery public key), with epochs taken one at a time only from trusted senders. Can someone who can only sign in, or a malicious server, get a key of its own trusted, or downgrade any of these?
4. Revocation and rotation: does a revoked device lose access to everything written afterwards? Are there races between rotation and other devices' pushes?
5. Rollback, omission and forks: what can a server do by replaying, withholding or reordering objects, or by showing devices different views? Two limits are known (internal review C4b and C5): a server colluding with a removed device can keep a rotation from a device that hasn't seen it, and can give a device restoring with the recovery key an epoch the removed device made. What is the most practical fix (fork consistency between devices, authenticating the recovery wrap, something else)?
6. Metadata: what the server learns (sizes after padding, counts, timing, device labels, plan). Anything avoidable?
7. Server authentication: Supabase JWT verification (algorithms, issuer, audience, anonymous users), linking existing accounts by email, device token lifetime and revocation, rate limits.
8. Swift and Rust agreement, and anything platform-specific (Secure Enclave key-agreement keys, the Keychain, OS keystores on macOS and Windows, the 0600 file on Linux).
9. Donations: are they unlinkable to the sender as designed, and is the offline key handling (`docs/research-key-ceremony.md`) sound?
10. Lockout recovery options under consideration (`reports/e2ee-lockout-recovery-2026-10-22.md`): a recovery contact split with the server, an optional team admin recovery key, and HSM- or enclave-backed PIN recovery. We'd value a view on which preserve the guarantee.

## What we'd like back

A written report with findings rated by severity, each with a reproduction or a clear path through the code; a fix review after we address them; and a short public summary we can link from nekkoagent.com/security.

## Firms to ask

All have published reviews of E2EE products. Ask each for a quote and earliest start date. Their prices and availability have not been checked for this document.

- **Trail of Bits**: cryptography and application assurance teams; published reviews of E2EE messaging and key management.
- **NCC Group (Cryptography Services)**: long record of E2EE and protocol reviews.
- **Cure53**: frequent public audits of E2EE apps and libraries, including password managers.
- **Least Authority**: privacy and E2EE-focused audits.
- **Radically Open Security**: non-profit, publishes reports openly.
- **Quarkslab**: cryptography and mobile (iOS) expertise.

## Internal timeline

1. Send this packet with the tagged commit and the local-stack instructions.
2. Pick a firm; freeze the formats (`nekko-sync/v1`) for the review window.
3. Fix, get the fix review, publish the summary.
4. Only then does sync go live for anyone (TASKS ES-10).
