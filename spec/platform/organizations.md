---
title: Organizations and the shared computer fleet
area: platform
status: in-progress
---

# Organizations and the shared computer fleet

Tracking: umbrella [#2585](https://github.com/nekko-labs/nekko-agent/issues/2585); Cloud API [#2586](https://github.com/nekko-labs/nekko-agent/issues/2586), engine [#2587](https://github.com/nekko-labs/nekko-agent/issues/2587), desktop [#2588](https://github.com/nekko-labs/nekko-agent/issues/2588). Decisions: [0086](../../docs/decisions/0086-organizations-own-the-computer-fleet.md), and [0102](../../docs/decisions/0102-fleet-links-open-on-the-account-keys.md) for opening a listed computer ([#2799](https://github.com/nekko-labs/nekko-agent/issues/2799)). Builds on the [account-synced computer fleet](../phone/account-synced-computer-fleet.md).

## Goal

A team in Nekko Cloud. Philip creates the organization "Nekko Labs", this Windows PC shares itself with it, and his laptop, signed in to the same account and unlocked once (recovery key or approval), lists the PC under Nekko Labs > Computers with its name, OS, online or offline state and the local models it can serve. No pairing code, QR or link. Then, from the laptop, he opens a chat on the PC and sends it prompts, still with no code: a computer of **your own account** in the list can be opened (decision 0102). Another member's computer is listed but can't be opened.

## Acceptance criteria

- Signed out: nothing new. Signed in but locked: the Organization section says to unlock the account on this computer first.
- A Pro or Team account can create an organization and becomes its owner. Any account can be invited by email, accept, and read the org and its roster.
- Owners and admins invite, revoke invites, rename and advance the key; only owners delete the org. Any member can leave; the last owner cannot.
- Sharing a computer with an org is a per-org switch, **off by default**, separate from chat sync consent. It lists the computer and its local models for that org's members, uploads no chats and lets no one run anything.
- A member sees only computers sealed under the org's current key, published by current members from live, unrevoked devices. Removing a member or revoking a device makes their computers disappear. A non-member cannot tell whether an org exists.
- The server never holds key material or readable descriptors.
- Opening a chat on a listed computer: only for a computer of your own account that is online, shares with that org, has remote access on and is verified against the account record. No code. Its relay details are sealed under the account keyring, so other members never see them. The computer lets the device in only while both hold the account's current keys, the device is in the account record and sharing stays on; when any of that changes, the live connection is cut within 15 seconds, not only the listing. Nothing is added to the computer's paired devices, and nothing about the link is saved on either side.

## Implemented: Cloud API slice (#2586)

`apps/nekko-agent-api/src/orgs.ts` and migration `0015_orgs.sql`. Routes exist only with `NEKKO_ORGS_ENABLED=1` (always on in `npm run dev:local`), independent of `NEKKO_FLEET_ENABLED`. `NEKKO_ORGS_ALLOWED_EMAILS` (comma-separated, compared lower-case; unset allows everyone) limits who may create orgs, accept invites or call org fleet routes (`403 {"error":"orgs-not-available"}`). Withdrawing one's own computer is never blocked by the allowlist. Routes, wire shapes and tables are in the [API README](../../apps/nekko-agent-api/README.md).

- Limits: 20 orgs per user, 100 members (open invites count) and 100 computers per org, descriptors 305 to 16,384 bytes, presence lease 90 seconds.
- The org key epoch is a number on the org. It advances by exactly one, by an unlocked owner or admin. Descriptors of an older epoch are hidden until republished.
- Org fleet routes need membership and an unlocked device (the same check as the account fleet). Publishing and heartbeat need Pro or Team; reading, membership and withdrawal work on any plan.
- Deleting an account deletes the orgs it alone owns; its other memberships and computers go with it. Sync deletion and device revocation remove that device's org computers.
- Tested with Fastify and PGlite request tests using synthetic envelopes. They check server policy, not encryption, key handling, UI or real-device behavior.

## Implemented: opening your own listed computer, engine (#2799)

Decision 0102. `crates/nekko-sync/src/fleet_link.rs` (the two sealed envelopes), `crates/nekko-cloud/src/fleet_link.rs` (the connect block in the descriptor, the HELLO proof, the computer's check and catch-up), `crates/nekko-remote/src/fleet.rs` and `service.rs` (fleet admission beside the paired registry, recheck and kick), `crates/nekkod/src/fleet.rs` (the wiring, the 15-second recheck) and `computers:connectFleet [orgId, deviceId]` in `crates/nekkod/src/computers.rs`, which opens an in-memory link that the Computers list, chats and the Model Server provider treat like a paired computer.

- `fleet:list` rows carry `reach`: `ready`, `you`, `other-account`, `unverified`, `no-remote` (remote access off there, or an older build) or `locked`.
- Refusals the desktop shows: `fleet-off` (sharing off there), `fleet-locked` (signed out or locked there), `fleet-epoch` / `fleet-device` (that computer hasn't caught up with this device yet: it reads the account again and the desktop retries once after 3 seconds), `fleet-account`.
- The connect block carries the computer's relay address as remote access has it. LAN alternatives that a pairing link adds are not in it yet.
- Verified: unit tests for both envelopes, the descriptor field and the never-saved link; loopback tests of a real client and relay agent core with a stand-in gate; and `crates/nekko-cloud/tests/live_fleet_connect.rs` against `npm run dev:local`: two devices of one account, a chat turn through the link with a canned reply in place of a model, a replayed or misbound proof refused, and the live link cut when sharing goes off and when the connecting device is revoked. **Not verified:** the desktop UI (next PR), two real computers, a real model, production.

## Implemented: opening your own listed computer, desktop (#2799)

Settings > Nekko Cloud > Fleet management > Computers: an online computer of your own account whose row says `reach: ready` has an **Open chat** row action (faint until hover or focus, as every row action). It calls `computers:connectFleet`, then `computers:createSession` on that computer, and opens the new chat. While it dials it reads *Connecting…*; a refusal shows its sentence on that row in the danger tone and no chat is made. An online row that can't be opened says why in one faint line: another member's (*Shared by …*), remote access off there, not verified, or this computer lacks the newest key. Offline rows and this computer say nothing more. The share switch explains that with Remote access on your own other computers can open chats on it. In Settings > Phone and computers a fleet link reads *Opened from your organization* and its action is **Disconnect**. Design: `nekko-designs/fleet-connect-design.html`. User guide: `docs/REMOTE.md` ("Your own computers, with no link"). Phones: not yet (iOS #2804, Android #2805).

## Planned

- **Engine (#2587):** the org keyring as an `org-key` sync record in the creator's account (synced even with chat sync off), descriptor sealing under the org keyring, the sharing switch, heartbeat and republish, rotation after a removal, and the `org:*` and `fleet:*` channels.
- **Desktop (#2588):** the Organization section, the Computers list and the sharing switch, following the design system.
- **Another member's account receives the org key:** designed in decision 0086 (a one-time code and a join wrap), not built. Until then a member without the key sees the roster but not the computers.
- **Invite email** (Resend), role changes and ownership transfer.
- **Phones** open a listed computer with the same proof (separate issues per OS).
- **Android, protocol layer built (#2805, `[unit-tested; no UI]`).** `FleetLink` (`apps/android/protocol`) seals and opens the connect block and the HELLO proof in the record envelope under the account keyring, byte for byte as `nekko-sync` does (shared vectors, with the associated-data and tamper cases), reads a connect block only for its org, and `RelayConfig.fleetHello` adds the `fleet` object to the HELLO of one handshake (the link's device id is `fleet:<account device id>`, never saved; no proof is sent when locked). **Not built:** the Android app has no Nekko Cloud sign-in, account keyring unlock or org list yet, so nothing in the app opens a listed computer, and the five refusals have no screen. That groundwork is [#2835](https://github.com/nekko-labs/nekko-agent/issues/2835).
- Production: set `NEKKO_ORGS_ENABLED=1` and `NEKKO_ORGS_ALLOWED_EMAILS=philip@nekkolabs.com`. The external crypto review in `docs/SYNC-ENCRYPTION.md` still applies before any broader release.
