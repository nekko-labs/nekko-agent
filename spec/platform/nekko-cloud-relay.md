---
title: "Nekko Cloud Relay: a Pro perk, chosen per device beside Tailscale, and the account channel (2026-11-23)"
area: platform
status: in-progress
---

# Nekko Cloud Relay

Issue: [#3242](https://github.com/nekko-labs/nekko-agent/issues/3242). Decision: [0116](../../docs/decisions/0116-nekko-cloud-relay-is-a-pro-perk-with-signed-tickets.md). Phones: [#3243](https://github.com/nekko-labs/nekko-agent/issues/3243).

## User intent

Philip (2026-11-23): "let's make an upgrade for nekko cloud (we can add to perks): faster device connectivity through nekko cloud relay instead of having to rely on tailscale. The user can select how to connect per device, relay or tailscale. We should also use this for device connectivity updates, syncing, etc."

## What the owner sees

- **Settings > Remote access**, before it is on: *Tailscale* (free) and *Nekko Cloud*. On Pro, Team or a Nekko team account, *Use Nekko Cloud* connects through Nekko Cloud Relay. On Free it reads *Pro* and *Upgrade to Pro* (Stripe Checkout). Until the `cloud-relay` switch shows it to the account it stays *Coming soon*, as before.
- On Tailscale, **Also through Nekko Cloud Relay** (Pro) keeps the computer reachable both ways at once, so a phone without Tailscale, or away from it, still connects. If the cloud route is down the row says why (sign in again, upgrade).
- With both routes, **Pair a device** asks *The next device connects through: Either way / Nekko Cloud Relay / Tailscale*, and every paired device has *Either way*, *Only Nekko Cloud Relay* or *Only Tailscale*. Changing it closes a live connection on the route the device lost. *Re-pair* makes a code for the device's current choice.
- The owner never sees the relay's address.

## Rules

- **A perk.** Tickets are issued only to Pro and Team (and team accounts while the switch is `team`). Free gets `402 plan-required` with the plans that include it. A downgrade takes effect within a ticket's life (6 hours).
- **The relay knows no account.** It checks the API's Ed25519 signature itself, so it never calls the API per connection and keeps working while the API and Postgres sleep. A ticket carries an opaque account hash, a device id, the room (agent tickets), the plan and its expiry; never an email or user id.
- **Per-device routes are enforced by the computer**, at HELLO, against the relay the HELLO actually came in on; a device can't claim its route. A pairing code may be made for one route; the device keeps that choice.
- **End-to-end encryption is unchanged** on every route. The relay still sees only ciphertext.
- **The account channel is content-free**: presence (which of the account's devices are online), nudges with a topic (`sync`, `fleet`, `library`, `settings`, `orgs`, `routes`) and sealed device-to-device signals of at most 16 KB. A nudge says where to look, never what changed; synced data still travels sealed through `/v1/sync`.

## Status

- Implemented and tested: Cloud API tickets and the switch (`apps/nekko-agent-api/src/relay.ts`, PGlite tests); relay ticket checks, renewal, expiry, room ownership and `/account` (`apps/relay-server/src/ticket.ts`, `server.ts`, live-socket tests); one vector shared by both.
- Implemented and tested in the engine crates: the same room on several relays (`remote:setRelays`), per-device routes (`remote:setRoute`, `remote:pair` with a route), tickets before every dial and renewed on the open socket (`crates/nekko-remote`); the account channel client and sync nudges (`crates/nekko-cloud/src/relay_channel.rs`). The daemon wiring type-checks; the daemon's own tests were not run here (ONNX Runtime could not be downloaded in the build environment).
- Implemented (desktop renderer, unit-rendered only): the offer, the switch, the pairing route choice and the per-device route. No screenshots yet; not tried in the installed app.
- Phones, wording (2026-11-25): the connection row no longer says *Tailscale off* about a computer the phone also has a Nekko Cloud Relay route to ([iphone-connection-strip](../phone/iphone-connection-strip.md)). A phone learns a computer's routes only from a pairing link, so a phone paired before *Also through Nekko Cloud Relay* was turned on has no cloud route until it pairs again.
- Not done: deploying the relay with `NEKKO_RELAY_TICKET_KEY` and the API with `NEKKO_RELAY_SIGNING_KEY` (needs Philip); the phones ([#3243](https://github.com/nekko-labs/nekko-agent/issues/3243)); fleet presence moving off the 90-second API heartbeat onto the channel; a free push-only tier.
