---
status: accepted
date: 2026-11-11
---

# 0086. Organizations own the computer fleet, with the org key held as an account record

Issues: umbrella [#2585](https://github.com/nekko-labs/nekko-agent/issues/2585), Cloud API [#2586](https://github.com/nekko-labs/nekko-agent/issues/2586), engine [#2587](https://github.com/nekko-labs/nekko-agent/issues/2587), desktop [#2588](https://github.com/nekko-labs/nekko-agent/issues/2588). Spec: [organizations](../../spec/platform/organizations.md). Builds on [0066](0066-account-fleet-reuses-encrypted-account-trust.md).

## Context

The account fleet (0066) lets one person's unlocked devices discover each other. The first real use is a team: Philip creates "Nekko Labs" in Nekko Cloud, shares this Windows PC with it, and his laptop lists the PC under Nekko Labs > Computers with no pairing code, QR or link. Descriptors must stay opaque to the server, as in 0066, and signing in must still not be enough to see a computer. People and their computers need a scope that is wider than one account and narrower than "everyone".

## Options considered

1. **Share by account.** Each owner lists other accounts that may see their computers. No new object, but every computer must be shared with every person separately, and there is nowhere to put a shared key or a roster.
2. **Organizations that own the fleet, with a shared org key.** An org has members with roles, and its computers are sealed under an org keyring. One place for membership, key rotation and removal.
3. **Server-side visibility rules only.** The server decides who sees what and stores plaintext descriptors. Simplest, but it makes the server a reader of device names and local models and breaks 0066's property that the server holds nothing it can open.

## Decision

Option 2.

- **Org model.** An org has members with the roles owner, admin and member. Invites are addressed to an email and accepted only by the account with that email. An org has an integer key epoch (`key_id`, 0 until the first key). The server stores the number, never key material. A user may be in 20 orgs; an org holds 100 members and 100 computers.
- **The org keyring is an ordinary account record.** A 64-byte keyring per org epoch is stored as a sealed sync record in the creator's own account (collection `org-key`), so every unlocked device of that account gets it through the existing sync and trust machinery. Nothing new is invented for distribution within one account. The record syncs even when chat sync is off: it is not a transcript, and sharing consent stays separate from transcript upload consent.
- **Descriptors are sealed under the org keyring**, bound to the org, epoch, publishing device and revision. The server checks only framing and size. Org-key holders can author descriptors: v1 trusts them, because each received the key from a trusted device. A descriptor from the reader's own account is additionally checked against that device's key.
- **Org fleet access keeps 0066's gate.** Every org fleet route needs org membership and an unlocked device (live device, wrap and current-epoch proof). Signed in but not unlocked answers `403 needs-synced-device`. A non-member gets `404`, never a hint that the org exists.
- **Removal and rotation.** Removing a member (or revoking a device) deletes their computers from that org, and removal answers `rotateKey: true`. A key-holding owner or admin device creates the next keyring and advances the epoch by exactly one (`PUT /v1/orgs/:id/key`); older-epoch descriptors are hidden until republished. The server cannot rotate, because it has no key.
- **Handing the key to another member's account is designed, not built.** The planned shape: the invitee accepts, the inviter shows a one-time 16-character code, the invitee's device publishes a join tag, the inviter's device sends a join wrap with the existing PSK-mode wrap (context `nekko-org/v1 join-wrap`, org, epoch and device), and the invitee stores it as its own `org-key` record. Until then a member without the org key sees the org and its roster but not the computers, and cannot publish.
- **Gate while it is proven.** The routes exist only with `NEKKO_ORGS_ENABLED=1`. `NEKKO_ORGS_ALLOWED_EMAILS` (comma-separated) limits who may create orgs, accept invites or use the org fleet; production will set it to Philip's address. Creating an org and publishing need Pro or Team; reading and withdrawing work on any plan.
- **Discovery is not execution.** A listed computer is a name, an OS and the local models it can serve. Connecting to it and running a model is a separate later slice with its own mutual authentication; no UI offers it yet.

## Consequences

- The first test needs no pairing: sign in, unlock once, and the org's computers appear.
- Within one account the org key costs nothing new. For a second person it does not work yet, by design; that slice needs the external crypto review that 0066 and `docs/SYNC-ENCRYPTION.md` already require.
- A removed key holder keeps whatever they already read. Rotation protects future descriptors only, and it needs a key-holding admin device to be online.
- An invite sends no email yet; it shows in the invitee's `GET /v1/orgs`. Email delivery (Resend) comes later.
- There is no route to change a member's role or hand over ownership; a sole owner can only delete the org. Add one when a second owner is needed.
- It was wrong if a server compromise could show a member a computer that no org-key holder published, or if removing a member left their computer listed.
