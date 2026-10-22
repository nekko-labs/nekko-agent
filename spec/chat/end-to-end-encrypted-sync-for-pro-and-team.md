---
title: "End-to-end encrypted sync for Pro and Team (2026-10-22)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# End-to-end encrypted sync for Pro and Team (2026-10-22)

`[foundation implemented and tested: format, Nekko Cloud storage API, iPhone crypto; not usable yet: no Cloud sign-in, no sync engine or screens]` Design and threat model: [docs/SYNC-ENCRYPTION.md](docs/SYNC-ENCRYPTION.md).

**User intent:** Philip asked (2026-10-22) for end-to-end encryption, "extremely secure", for storing and syncing messages on the server, as a Pro-and-up feature: Nekko Labs must not be able to see users' messages unless they explicitly allow us to use them to improve the app anonymously, and even then the data stays encrypted.

**Decisions:**
- **Zero-knowledge by construction.** Chats are sealed on the user's devices; Nekko Cloud stores only ciphertext, Padmé-padded sizes, keyed-hash object ids, revisions and device public keys. Keys: a 64-byte keyring per key epoch (record key ‖ id key) wrapped to each device's P-256 key (Secure Enclave on iPhone) and to a 256-bit recovery key; one AES-256-GCM key per record revision via HKDF from a fresh salt; account, epoch, collection, object id and revision bound as associated data (no relabelling or rollback).
- **No password recovery.** The only recovery is the recovery key shown once (55 Crockford base32 characters with a checksum). A password-derived key could be brute-forced by the server, which holds the wrapped keyring. Losing every device and the recovery key loses the synced copy, by design.
- **Revocation rotates.** Revoking a device kills its tokens and wraps; the remaining devices start a new key epoch, and Cloud accepts writes only under the newest one.
- **Pro and Team only for writes; never locked out of your own data.** Free keeps everything local. After a downgrade, pull, decrypt and *Delete everything synced* keep working; only uploads stop. Storage: Pro 5 GB, Team 20 GB per account (encrypted bytes).
- **Help improve Nekko Agent stays encrypted.** Off by default; turning it off changes no feature. The user picks what to share, the device redacts it, and seals it to Nekko Labs' research key, whose private half is offline only. Uploads carry no account, device or IP (unauthenticated route, request logging off, day-granular date), can be withdrawn with a delete token the device keeps, and expire after 180 days. Opting in never gives Nekko Labs the sync keys.
- **Adding a device needs an existing one** (fingerprint comparison, or the hand-over over the phone's already encrypted pairing), so a server-registered key can't be trusted silently.

**Acceptance criteria:** a database copy reveals no chat text, titles or the chat a record belongs to; a modified, relabelled, rolled-back or cross-account record fails to open; a revoked device can't read writes made after rotation; Rust and Swift produce identical bytes for the shared vectors; Free-plan writes answer 402 while reads and deletion work; donations are stored with no sender information and open only with the research key.

**Implemented 2026-10-22:** `crates/nekko-sync` (reference implementation, 13 tests incl. bit-flip, relabel, rollback, rotation, wrong-device and recovery-typo cases; vectors cross-checked against Node `crypto`); `apps/nekko-agent-api` migration `0002_e2ee_sync.sql`, bearer tokens (SHA-256 only), `/v1/sync/*` and `/v1/donations` (15 tests on PGlite); `NekkoProtocol/SyncCrypto.swift` with `SyncCryptoTests` on the shared vectors (runs on macOS CI, not run locally). **Planned:** Cloud sign-in issuing tokens (PF14 step 4), the nekkod sync engine and *Settings → Sync*, iPhone sync screens and offline reading of synced chats, Android port, the offline research key and on-device redaction, and an outside cryptography review before sync is switched on.
