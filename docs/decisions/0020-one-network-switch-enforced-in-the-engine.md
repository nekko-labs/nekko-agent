# 0020: One network switch, enforced in the engine

Date: 2026-10-24. Status: accepted. Issue: [#1034](https://github.com/nekko-labs/nekko-agent/issues/1034).

## Context

Settings > Connections lets someone switch off every connection the app makes. The requests start in about 30 places across a dozen crates. The existing switches lived in four files (`settings.json`, `remote.json`, `local-relay.json`, `network-visibility.json`), and nothing logged the traffic.

## Decision

- **One small crate, `nekko-net`, holds the switch and the activity log.** Every outbound request goes through `nekko_net::send(id, request)`. A websocket, `git` or a listener calls `nekko_net::check` or `nekko_net::allowed` itself. The daemon applies `settings.connections` to it before anything that reaches the network starts.
- **All connections off means truly offline, except loopback.** Every chat is treated as Offline at the places that read the chat's Offline flag, and listeners close. Loopback stays allowed so local models work.
- **A row switch is a block, not the feature's setting.** It adds the id to `settings.connections.blocked`. The features' own switches are left where they are.
- **The Electron main process filters Chromium's own requests** (the browser pane, the agent's browser windows) by reading the same setting, because nekkod never sees them.

## Alternatives considered

- **Reuse each feature's own switch as the row switch.** Rejected: four storage places and two meanings ("set up" and "allowed") in one list, and several connections have no switch at all.
- **An HTTP proxy that every request goes through.** Rejected: it would not cover listeners, websockets or git, and it adds a process.
- **Log in each call site.** Rejected: thirty copies of the same logging, and an easy one to forget.

## Consequences

A new network call must go through `nekko_net::send` with an id from `nekko_net::IDS`, which is checked against `packages/shared/src/connections.ts`. A shell command run by an agent is not covered.
