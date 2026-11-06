---
status: accepted
date: 2026-10-31
---

# 0034. Permit cleartext app-wide on Android and refuse public ws:// in the app

## Context

A computer's own relay is reached at plain `ws://` on a private network: the LAN
(`ws://192.168.1.20:4400`) or the tailnet (`ws://100.101.102.103:4400` or a
`*.ts.net` name). Frames are end-to-end encrypted on every path; the transport
rule (TASKS.md PH1, `packages/shared/src/relay-route.ts`) only keeps plain
`ws://` off the open internet so metadata doesn't leak there.

The iPhone enforces that rule twice: in the app (`RelayRoute.problem`, before
dialing) and in the system (ATS `NSAllowsLocalNetworking` plus a `ts.net`
exception). Android's network security config can only name domains, not IP
ranges, so until now it allowed cleartext to `*.ts.net` only. A computer's LAN
route was kept but never dialed ("not used on Android"), and a bare tailnet IP
was refused, which left Android without the home route the iPhone uses for
failover (AN-28).

## Options considered

1. **Permit cleartext app-wide, enforce the rule in the app.** The same
   behavior as the iPhone. The system no longer acts as a second barrier: code
   that opens a connection without going through the rule could speak plain
   HTTP to the internet.
2. **Add only `.local` names to the config.** The system barrier stays, but the
   LAN route works only when the pairing link carries a `.local` name, which it
   usually doesn't (computers advertise IPs), and tailnet IPs stay refused.

## Decision

Option 1, approved by the owner on 2026-10-31. The rule lives in one function,
`RelayRoute.publicCleartext`, and runs at every place the app opens a socket to
a relay address: the WebSocket transport (`OkHttpTransport.open` refuses before
anything is sent) and the `/healthz` probe (`HealthProber.healthUrl`). Route
choice (`RoutePolicy`) and the user-facing reasons (`RelayHint`) follow the
iPhone's `RelayRoute`.

## Consequences

- Android dials LAN and tailnet IP routes, so failover can use the home route.
- New code that opens a network connection must go through the rule, since the
  system will not stop it. The other clients today don't need it: feedback goes
  to a fixed `https://` endpoint, and the preview and Mermaid WebViews answer
  every request themselves (`shouldInterceptRequest`) and never load from the
  network.
- Lint's `InsecureBaseConfiguration` is suppressed for this file only, with the
  reason in `app/lint.xml`.
- `OkHttpTransportTest` and `RelayHintTest` fail if public `ws://` is ever
  dialed or reported as allowed.
