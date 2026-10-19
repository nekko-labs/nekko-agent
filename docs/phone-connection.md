# How the phone apps connect (Android and iOS)

Both native apps reach the computer the same way: relay v2 over a WebSocket, end-to-end encrypted, with the computer's device registry deciding what a phone may do (see [REMOTE.md](REMOTE.md)). The route is **Tailscale first**: the desktop's *Relay on this computer* (`ws://<MagicDNS name>:4400`, inside the tailnet). The Nekko relay or a self-hosted `wss://` relay is the fallback. This page compares the two clients, with the code that does each part. Checked against the code on 2026-10-16.

## The same on both

| | Android | iOS |
| --- | --- | --- |
| **Relay client states** | Idle, connecting, online, offline, denied (`protocol/…/RelayClient.kt`) | The same five (`Protocol/Sources/NekkoProtocol/RelayClient.swift`) |
| **Timings** | Handshake 15 s, requests 120 s, backoff from 1 s doubling to 30 s, offline poll every 15 s | Identical constants |
| **Closes** | 4001: this phone was removed, stop. 1008 "bad pairing key": stop. 1008 "agent offline": poll until the computer is back | Same rules |
| **Re-HELLO** when the computer comes back online | Yes | Yes |
| **Crypto** | PBKDF2-HMAC-SHA256, 100,000 rounds, salt `nekko-relay:<room>`, AES-256-GCM (12-byte IV, 128-bit tag) | Same (CommonCrypto + CryptoKit) |
| **Crypto check** | `protocol/src/test/resources/e2e-vector.json` | `Protocol/Tests/NekkoProtocolTests/Fixtures/e2e-vector.json`, the same vector as the agent's WebCrypto |
| **Pairing link** | `nekko-agent-pair:`; room 8–128 hex, key 16–256 hex, code upper-cased (`Pairing.kt`) | Same rules (`Pairing.swift`) |
| **One-time code** | Sent in HELLO, never again; dropped from storage once welcomed | Same |
| **Reconnect on a network change** | Default-network callback (`ConnectionKeeper.kt`, `NetworkChanges.kt`) | `NWPathMonitor` when the interfaces change (`NetworkWatcher.swift`) |

## Where they differ

| | Android | iOS |
| --- | --- | --- |
| **Plain `ws://`** | Only to `*.ts.net` in release builds (`network_security_config.xml`, which can't express an IP range). Debug builds also allow the emulator's loopback for `adb reverse`. | To Tailscale (`*.ts.net`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`), the LAN (RFC 1918, link-local, `.local`, ULA), and loopback in the simulator (`RelayRoute.swift`; ATS `NSAllowsLocalNetworking` plus a `ts.net` exception). The same rule as the desktop's `relay-route.ts`. |
| **A link that breaks the rule** | Warned about on the confirm card and in the connection banner (`RelayHint.kt`) | Refused before it's dialed, with the reason (`AppModel.pair`) |
| **Is Tailscale on this phone?** | Read from the interface addresses, 100.64/10 (`TailnetStatus.kt`, `Tailnet.kt`). Drives the confirm card's "turn Tailscale on" hint for a tailnet relay. | Read from the interface addresses, 100.64/10 (`Tailnet.swift`). Drives the pairing guide's status line and the "turn Tailscale on" hint when a tailnet relay can't be reached. |
| **Relay on this computer by tailnet IP only** (no MagicDNS name) | Refused by the network config (`RelayHint` TAILSCALE_IP) | Accepted |
| **QR scanning** | Google code scanner in Play services: no camera permission | AVFoundation: asks for the camera, with an Open Settings link if it's off |
| **Paste a link** | Paste button and text field | Text field, plus the system Paste button (no paste prompt) |
| **Push** | Not built yet (FCM needs the service account on the relay) | APNs token registered on every connect (`register-push`), plus ActivityKit tokens per running chat (`register-activity`) for Live Activities while suspended |
| **More than one route** (a pairing link with `alt=` addresses, IO-20) | Parsed (`Pairing.kt`, same fixture as the computer) but not dialed: one route (AN-28) | Every route kept; LAN on Wi-Fi first, else the tailnet; immediate fallback, back after 3 `/healthz` probes and a 30 s dwell, never mid-request (`RouteSupervisor.swift`) |
| **Route checks** (IO-21) | No | *Check routes*: DNS, TCP and relay hello per route, timed; *Share diagnostics* as redacted text (`Diagnostics.swift`) |
| **Finding a computer on this Wi-Fi** | *On this network* on the Pair screen: the system NSD service (`NsdManager`), no permission or multicast lock, one resolve at a time (`NearbyBrowser.kt`) | *On this network* on the Pair screen: `NWBrowser`, which shows iOS's local network prompt on the first tap (`NearbyBrowser.swift`, `NSBonjourServices`) |
| **While in the background** | A foreground service (type remoteMessaging) keeps the connection while a chat is running, with the setting on, for up to 30 minutes after the last event (`KeepAlive.kt`) | A healthy socket is kept 30 s after an app switch, inside the short background task, then closed and reopened on return. After that, Live Activity pushes and notifications. iOS doesn't allow a long-lived socket. |

## Next steps

- **Android: route failover** (AN-28): keep the `alt` routes, port `RouteSupervisor`, and allow plain `ws://` to private LAN ranges in the network config.
- **Android: FCM push** (PH6), once the FCM service account is on the relay. The relay already sends FCM.
- **Android: tailnet IPs.** Either keep requiring the MagicDNS name (the desktop shows it when the Tailscale CLI is present), or route `ws://100.x` through a small cleartext-permitted proxy. Today the network config can't allow an IP range, so the name stays the recommended route.
- **Both: pair from a listing.** Both apps already list computers whose desktop has *Visible on this network* on (`_nekko-agent._tcp`, parsed by `NearbyComputer` with the same rules), for 30 seconds per tap. A listing carries no secrets, so pairing still takes the QR code or link. Tap-to-pair waits on the owner's choice in [reports/phone-discovery-pairing-proposal.md](../reports/phone-discovery-pairing-proposal.md).
