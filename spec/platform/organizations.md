---
title: Organizations and the shared computer fleet
area: platform
status: in-progress
---

# Organizations and the shared computer fleet

Tracking: umbrella [#2585](https://github.com/nekko-labs/nekko-agent/issues/2585); Cloud API [#2586](https://github.com/nekko-labs/nekko-agent/issues/2586), engine [#2587](https://github.com/nekko-labs/nekko-agent/issues/2587), desktop [#2588](https://github.com/nekko-labs/nekko-agent/issues/2588). Decision: [0086](../../docs/decisions/0086-organizations-own-the-computer-fleet.md). Builds on the [account-synced computer fleet](../phone/account-synced-computer-fleet.md).

## Goal

A team in Nekko Cloud. Philip creates the organization "Nekko Labs", this Windows PC shares itself with it, and his laptop, signed in to the same account and unlocked once (recovery key or approval), lists the PC under Nekko Labs > Computers with its name, OS, online or offline state and the local models it can serve. No pairing code, QR or link. **Discovery only:** connecting to a listed computer and running a model on it is a later slice, and the app must not offer it yet.

## Acceptance criteria

- Signed out: nothing new. Signed in but locked: the Organization section says to unlock the account on this computer first.
- A Pro or Team account can create an organization and becomes its owner. Any account can be invited by email, accept, and read the org and its roster.
- Owners and admins invite, revoke invites, rename and advance the key; only owners delete the org. Any member can leave; the last owner cannot.
- Sharing a computer with an org is a per-org switch, **off by default**, separate from chat sync consent. It lists the computer and its local models for that org's members, uploads no chats and lets no one run anything.
- A member sees only computers sealed under the org's current key, published by current members from live, unrevoked devices. Removing a member or revoking a device makes their computers disappear. A non-member cannot tell whether an org exists.
- The server never holds key material or readable descriptors.

## Implemented: Cloud API slice (#2586)

`apps/nekko-agent-api/src/orgs.ts` and migration `0015_orgs.sql`. Routes exist only with `NEKKO_ORGS_ENABLED=1` (always on in `npm run dev:local`), independent of `NEKKO_FLEET_ENABLED`. `NEKKO_ORGS_ALLOWED_EMAILS` (comma-separated, compared lower-case; unset allows everyone) limits who may create orgs, accept invites or call org fleet routes (`403 {"error":"orgs-not-available"}`). Withdrawing one's own computer is never blocked by the allowlist. Routes, wire shapes and tables are in the [API README](../../apps/nekko-agent-api/README.md).

- Limits: 20 orgs per user, 100 members (open invites count) and 100 computers per org, descriptors 305 to 16,384 bytes, presence lease 90 seconds.
- The org key epoch is a number on the org. It advances by exactly one, by an unlocked owner or admin. Descriptors of an older epoch are hidden until republished.
- Org fleet routes need membership and an unlocked device (the same check as the account fleet). Publishing and heartbeat need Pro or Team; reading, membership and withdrawal work on any plan.
- Deleting an account deletes the orgs it alone owns; its other memberships and computers go with it. Sync deletion and device revocation remove that device's org computers.
- Tested with Fastify and PGlite request tests using synthetic envelopes. They check server policy, not encryption, key handling, UI or real-device behavior.

## Planned

- **Engine (#2587):** the org keyring as an `org-key` sync record in the creator's account (synced even with chat sync off), descriptor sealing under the org keyring, the sharing switch, heartbeat and republish, rotation after a removal, and the `org:*` and `fleet:*` channels.
- **Desktop (#2588):** the Organization section, the Computers list and the sharing switch, following the design system.
- **Another member's account receives the org key:** designed in decision 0086 (a one-time code and a join wrap), not built. Until then a member without the key sees the roster but not the computers.
- **Invite email** (Resend), role changes and ownership transfer.
- **Connecting to a listed computer** and running a model on it, with mutual authentication and live-session revocation (item 3 of the account fleet spec).
- Production: set `NEKKO_ORGS_ENABLED=1` and `NEKKO_ORGS_ALLOWED_EMAILS=philip@nekkolabs.com`. The external crypto review in `docs/SYNC-ENCRYPTION.md` still applies before any broader release.
