# 0116. Nekko Cloud Relay is a Pro perk, authorized by signed tickets, chosen per device

Date: 2026-11-23. Status: accepted. Issue: #3242. Builds on the relay's enrollment gate (the hosted-relay tiers in the remote-control spec) and #548.

## Context

The hosted relay had an `NEKKO_RELAY_AUTHZ_URL` hook that called an authorizer on every agent connection, and the app used one relay per computer. Philip wants the hosted relay to be a paid Nekko Cloud perk, chosen per device beside Tailscale, and used for presence and sync too.

## Decision

- **Signed tickets, checked offline.** The Cloud API signs short-lived (6 h) Ed25519 tickets for Pro/Team accounts (`POST /v1/relay/ticket`); the relay verifies them with the public key it starts with. Agents renew on the open socket; an expired ticket closes the agent.
- **One room on several relays.** A computer can hold its room on Nekko Cloud Relay and on its own Tailscale relay at once. Each device may be limited to `cloud` or `direct`, enforced by the computer at HELLO from the relay the HELLO came in on.
- **An account channel on the relay** for presence, topic-only nudges and sealed signals between one account's devices.

## Alternatives not taken

- **The existing authz URL** (relay calls the API per connection). Every connection would wait on a scale-to-zero API and Postgres, and the relay would forward account bearer tokens. Kept for self-hosters.
- **Long-lived account tokens in the agent URL.** A full account token in a query string; tickets are scoped to one room and expire.
- **Choosing the route on the phone only.** The owner's choice would be advisory; enforcing it on the computer makes "only Tailscale" true.
- **Server-sent sync pushes from the API.** Needs API-to-relay credentials; a device that just pushed already knows to nudge.

## Consequences

- A downgrade or a turned-off switch takes up to six hours to bite.
- Phones need an update to treat `denied: route` as "try the next route" and to join the account channel (#3243).
- Fleet presence can move off the 90-second API heartbeat, letting Postgres sleep.
