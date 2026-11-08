---
title: Account-synced computer fleet
area: phone
status: in-progress
---

# Account-synced computer fleet

Tracking: [#2160](https://github.com/nekko-labs/nekko-agent/issues/2160).

## Goal and trust decision

A user-owned Windows, macOS or Linux computer explicitly shares its local model through Nekko Cloud. A phone on the same **unlocked encrypted account** discovers it without scanning a QR code, copying a pairing link, or pairing with each computer. Inference runs on the selected computer, not a cloud model; no silent fallback. This is neither a provisioned `/v1/machines` computer nor the existing paired-computer list.

The account is unlocked once per device using the existing recovery key or trusted-device approval. **Account sign-in alone does not grant fleet discovery or execution.** Existing encrypted sync's malicious-server protections remain: the server cannot appoint a trusted device by changing a database row. Fleet sharing and transcript sync must have distinct user consent; merely signing in or reading the fleet must not expose a computer or upload its chats.

## Implemented foundation (not usable fleet access yet)

`apps/nekko-agent-api/src/fleet.ts` provides an experimental discovery registry, absent unless `NEKKO_FLEET_ENABLED=1` (including the local development server). It is inside the existing authenticated-route rate-limit scope. It does not open a port, start a relay, create a pairing grant, provision a machine, or execute a request.

| Route | Contract |
| --- | --- |
| `GET /v1/fleet` | Current-epoch proof and a live device wrap required. Returns only this account's current-epoch advertisements from unrevoked devices and live, proven publisher tokens. `Cache-Control: no-store`. |
| `PUT /v1/fleet/self` | Pro/Team and current-epoch proof required. `{keyId, revision, descriptor}` only. Device and account identity derive from the caller, not input. Sealed v1 envelope, canonical unpadded base64url, 305–16,384 bytes. Revision starts at 1 and must increase by exactly 1. |
| `POST /v1/fleet/self/heartbeat` | Same authorization as publish; only the publishing token can renew a non-withdrawn current-epoch advertisement. A fresh sign-in or key rotation requires republishing. |
| `DELETE /v1/fleet/self` | Live device-bound sign-in required; no paid plan or key unlock needed to withdraw oneself. Hides the advertisement and advances its revision, invalidating queued old publishes. Idempotent while withdrawn. |

- One advertisement per sync device, at most 100 retained advertisements per account. Every successful publish/heartbeat renews a **90-second** server-clock presence lease. An expired lease is returned as `online: false`; clients must never treat it as runnable.
- Publish conflicts return `currentRevision`; epoch conflicts return `currentKeyId`. A client must refresh trust, reseal with the correct associated data and obtain explicit sharing consent as needed, never blindly retry a stale payload with a new number.
- The server stores only opaque descriptor bytes plus device/account/token references, epoch, revision, withdrawal state and last-seen time. It checks framing/size, **not whether bytes are genuinely encrypted or authentic**. That is a client responsibility.
- Host sign-out/token expiry, revocation or missing wraps hide the advertisement. A revoked phone cannot read the registry. Rotation hides previous-epoch advertisements and requires fresh proof. Sync deletion and account deletion cascade to fleet rows.
- Withdrawal retains ciphertext and the revision guard until device/sync/account deletion. No automatic retention purge is implemented yet. A full 100-device registry requires removing obsolete sync devices before adding another computer.
- Discovery is **not an execution credential**. Nothing in this implementation authorizes or terminates a remote connection. Live-connection revocation is still required below.

## Still to implement before the first computer is ready

1. **Descriptor codec and trust checks.** Seal computer identity, host authentication key and connection coordinates using the existing `nekko-sync` record format. Bind the account, host sync-device id, key epoch and revision in associated data; reject tampering, rollback, untrusted hosts and old epochs. Never put room secrets, model names, local URLs or tokens in plaintext fleet metadata. Do not treat a server-owned device id as cryptographic proof of the descriptor's author.
2. **Computer enrollment.** Explicit sharing control, off by default; outbound relay only; publish/heartbeat while enabled and unlocked. Withdraw and close fleet connections on disable/sign-out. Fail closed on stale account authorization; handle sleep, restart and reconnection. Do not enable transcript uploads merely to share a model.
3. **Connection authentication.** Extend or adapt the existing protocol-6 mutual authentication and per-connection ephemeral encryption to authenticate account-trusted devices without minting a pairing code or silently adding them to the direct-pairing registry. Account/device/epoch and the connection challenge must be bound to the proof. Existing phone channel permissions and guarded-action checks still apply. Revocation must cut off existing fleet connections, not only discovery.
4. **Native phone discovery.** iOS first real-device test, with Android parity tracked explicitly. Clear Cloud account computer grouping, online/offline state, model selection and visible compute location. Unlock once, then discover/connect automatically; no hidden pairing-link shortcut. Sign-out/account switch must remove account-scoped connection material and close sockets.
5. **Local-model end-to-end test.** On this Windows PC, a phone without a saved pairing discovers the PC through Cloud, chooses a genuinely local model and receives a streamed answer. No cloud-provider fallback. Test revocation during a live connection and offline/unavailable errors.
6. **Production readiness.** Configure Supabase identity and Fly deployment access, enable only the authorized internal test account, complete required encryption review before broad release, and capture desktop/phone UI evidence. Existing external crypto-review requirement in `docs/SYNC-ENCRYPTION.md` is not waived.

## Verification status

The registry has Fastify/PGlite request tests for feature gating, account isolation, proof requirements, malformed bodies, revision conflicts, withdrawal, stale presence, sign-out, revocation, epoch rotation, plan downgrade, account/sync deletion and registry capacity. These test server policy with synthetic descriptor envelopes; they do **not** prove encryption, model inference, native UI behavior, or physical-phone access.

As inspected on 2026-11-07 UTC, the production auth-config endpoint returned `503 sign-in-not-configured`; this PC's Fly CLI had no access token. No production setting or user's running app was changed. The registry remains disabled by default.
