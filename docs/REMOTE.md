# Phone remote control

Drive the Nekko Agent running on your computer from your phone: start and manage chats, watch and steer
training runs and goals, approve risky commands, and get a push when a long run finishes. Inference
and tools always execute on **your** machine, under its guardrails; the phone is a thin client.

## How it works

```
[ Phone ]  --TLS-->  [ relay ]  <--outbound WSS--  [ your computer (agent) ]
```

- Your computer **dials out** to a relay and claims a room. No inbound ports, no port-forwarding.
- Your phone connects to the same relay with the pairing credentials.
- Every payload is **end-to-end encrypted** (AES-GCM, key derived from the pairing secret). The
  relay routes ciphertext; it cannot read prompts, replies, files, or model output.
- On top of the encrypted transport, every device must pass a **handshake against your computer's
  device registry**: new devices enroll only through a **single-use pairing code that expires in
  10 minutes**, and your computer answers each device individually (never broadcast).

## Pairing a phone

1. On your computer: **Settings → Remote access → Enable** (the managed relay is prefilled; or
   paste your self-hosted relay URL), then **Pair a device**.
2. On your phone: scan the QR in the Nekko Agent app (**Computers → Pair a computer**), or with the
   phone's camera app, which hands the `nekko-agent-pair:` link to the Nekko Agent app. Without the
   app, the pairing link also opens the web app in a browser over the relay, but it is limited to
   what a phone may do (below), so most desktop screens there are unavailable.
3. The phone shows up under **Paired devices**, with a live connection dot.

## The phone app

> **Native apps.** The phone apps are moving to platform-native code: Kotlin / Jetpack Compose in
> `apps/android` (pairing, chats, live replies, approvals and questions; no phone models yet) and
> SwiftUI in `apps/ios`. The Expo app described below stays as the reference until they reach parity.
>
> The Android app looks like your desktop by default: **Settings → Appearance → Same as computer**
> uses the computer's light or dark theme and its accent color, and follows a change on the
> computer right away. Pick **Phone setting**, **Light** or **Dark** to choose on the phone instead;
> that choice is kept on the phone. Only the theme, theme preset and the two accent colors are sent
> for this (the `appearance:updated` event), never the rest of the computer's settings.
>
> The Android app's **Settings** also has a **Computers** row, which opens the list of paired
> computers (rename, switch, forget, pair another), and an **About** section with the installed
> version and the open-source licenses of the app and the libraries it ships.
>
> **Share to Nekko** (Android): in any app's share menu, pick **Nekko Agent** to start a new chat
> with the shared text or link. You can edit it on the New chat screen; after you start the chat it
> waits in the message box and you send it yourself. Nekko never sends shared text on its own, and
> it is kept only in memory until then. Text and links only for now, up to 20,000 characters.
>
> The Android app is **locked by default**: every time you open it, or come back to it, it asks for
> your fingerprint, face or the phone's screen lock (PIN, pattern or password) before it shows
> anything. While it is locked nothing can be read or approved, and the recent-apps preview stays
> blank. After a restart it doesn't connect to your computer until you unlock. Turn it off in
> **Settings → Security → App lock**; turning it off asks for the same check first. With the lock on,
> the app can't be screenshotted or screen-recorded. A phone with no screen lock can't be locked;
> Settings says so and links to the phone's security settings.

The iOS and Android app (`apps/mobile`) is built for the phone rather than being the desktop on a
small screen: your computer's chats with **Working** / **Needs you** badges, new chats on any of the
computer's models and folders, live replies, **Allow this?** cards for risky commands, the agent's
questions as tap-to-answer choices, follow-ups that queue while a run is going, and Stop. It can
pair several computers and talks to one at a time.

It also runs **models on the phone itself** (llama.cpp, curated small GGUF models from Hugging Face
sized to the phone's memory), so you can keep chatting when the computer is off. Those chats never
leave the phone and don't use the relay.

On the phone, the pairing key and the derived encryption key live in the iOS Keychain / Android
Keystore. The app drops any provider API keys your computer sends with its settings and never
stores them.

Manage devices from the same card: **rename** them, **revoke** one instantly (it's kicked live and
denied from then on), or **Rotate secret** to cryptographically reset the room, which unpairs
everything at once.

Remote access survives restarts: if it was enabled, the agent reconnects when Nekko Agent starts.

## What a paired phone can do

Your computer decides what a paired phone may ask for, whatever the phone app does: locking the
phone app is not the boundary, your computer is. A phone can use your chats and nothing that
changes how the computer itself is set up:

- **Allowed:** list, open, start, complete and delete chats; send, queue and stop messages; answer
  approvals and the agent's questions; pick a model from the computer's providers and a folder from
  its list; voice status and transcription; and a few settings (below).
- **Never allowed from a phone:** wiping data or resetting settings, remote access itself (pairing,
  revoking, rotating the secret), terminals, writing files, adding or removing folders, installing
  or removing voice models, connecting or disconnecting connectors, provider keys and sign-ins, MCP
  servers and hooks. Everything not on the allowed list is refused too, with an error that starts
  *Not allowed from a paired phone*.
- **Settings a phone may change:** the chat mode for new chats (Ask, Guardrails or YOLO), what the chat pane's top-right button does (Complete or Delete),
  whether deleting asks first, and voice on/off and its language. An update that touches any other
  setting is refused as a whole: nothing in it is applied.
- **Settings a phone can read:** only the theme and accents, the default and starred models, and
  the settings above. API keys, tokens, provider details, folders, hooks, guardrails and your
  instructions never leave the computer this way; provider lists arrive as name and type only.
- **One chat's options:** a phone can change a chat's model, title, pin and tags, complete it, and
  switch it between Ask, Guardrails and YOLO, but not its tools, isolation or
  offline/incognito switches. Messages cannot attach files from the computer.

## Security model, honestly stated

| Threat | Defense |
|---|---|
| Relay operator reads your traffic | Impossible by construction: E2E encryption, relay sees ciphertext only |
| Stranger connects to your room | Needs the pairing secret (128-bit) for transport auth, then a registered device or a live pairing code |
| Leaked/stale pairing link | The one-time code is single-use and expires in 10 min; the link is scrubbed from the phone's URL/history after pairing |
| Lost/stolen phone | The Android app asks for the phone's fingerprint, face or screen lock every time it opens. Revoke the phone in Settings: kicked immediately, denied afterward, push token dropped |
| Revoked device replays old creds | The agent refuses its handshake and unicasts nothing to it; rotate the secret for a full cryptographic reset |
| Malicious relay withholding/reordering | Availability only; it still can't read or forge frames (AES-GCM auth) |
| Phone asks for something dangerous | Your computer only serves the phone allowlist above (no wipe, settings reset, remote-access changes, terminals, file writes); tool calls run on your machine under your guardrails/sandbox and chat mode |

What the relay does see: connection metadata (IPs, timing, frame sizes), the room code, and, if you
enable push, device push tokens plus the content-free fact "a run finished". That's the whole list,
and it's why relayed local-model use is inherently zero-data-retention for content.

## Choosing a relay

### Managed relay (default): `wss://nekko-agent-relay.fly.dev`

Zero setup; free during beta with per-connection rate limits. When Nekko Agent Cloud launches, the
managed relay becomes part of the paid plans (it already supports gating via
`NEKKO_RELAY_AUTHZ_URL`), while self-hosting stays free forever.

### Private relay over Tailscale (free, no account, nothing hosted)

If your phone and computer are both on a [Tailscale](https://tailscale.com) network, you do not
need a hosted relay at all: run the relay **on the computer** and bind it to the computer's
Tailscale address. Only devices on your tailnet can reach it, Tailscale encrypts the hop
(WireGuard), and the app's end-to-end layer still sits on top. This is how free remote-desktop
tools such as Moonlight stay free: nothing runs in the cloud, the two ends find each other over a
network you already own.

```bash
npm run relay:tailscale        # Windows (PowerShell); or scripts/private-relay.sh on macOS/Linux
```

The script prints the URL to paste into **Settings → Remote access** (for example
`ws://gomi.tailfd6474.ts.net:4400`; the MagicDNS name resolves on any device in the tailnet, the
`100.x.y.z` address works too). Enable, **Pair a device**, scan the QR from the phone with
Tailscale switched on. The relay only listens on the Tailscale interface, so
`NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1` is safe here; never use that flag on a public bind.

Plain `ws://` is fine on a tailnet: the transport is already encrypted end to end by WireGuard and
the iOS app ships with Expo's default App Transport Security (arbitrary loads allowed). If you
prefer `wss://`, enable **HTTPS certificates** in the tailnet's DNS settings and either put
`tailscale serve --bg 4400` in front (needs Serve enabled once per tailnet) or terminate TLS with
`tailscale cert` on your own proxy.

Trade-offs: the computer must be awake and Tailscale running; push notifications need APNs/FCM
keys on this relay like any other; Tailscale's free plan covers up to 100 devices and 3 users.

### Self-host (free forever, one command)

The relay is a tiny stateless Node service; anything that runs a container can host it.

**Docker**

```bash
docker run -d --name nekko-agent-relay -p 4400:4400 --restart unless-stopped \
  -e NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 \
  ghcr.io/nekko-labs/nekko-agent-relay:latest
```

**Docker Compose**

```yaml
services:
  nekko-agent-relay:
    image: ghcr.io/nekko-labs/nekko-agent-relay:latest
    ports: ["4400:4400"]
    environment:
      NEKKO_RELAY_ALLOW_UNAUTHENTICATED: "1"
    restart: unless-stopped
```

**Coolify** (recommended if you already run one): add a new service → Docker image
`ghcr.io/nekko-labs/nekko-agent-relay:latest`, expose port 4400, attach a domain, and let Coolify's
proxy terminate TLS. Point Nekko Agent at `wss://relay.your-domain.com`.

**Fly.io**: `fly deploy -c apps/relay/fly.toml` from a repo checkout. Keep it at **one machine**
(`fly scale count 1`): rooms live in a machine's memory, so agent and phone must land on the same
instance.

Put any self-hosted relay behind TLS (`wss://`) for internet use; the E2E layer protects content
regardless, but TLS also protects the transport-auth query string. Then paste the URL into
**Settings → Remote access** before enabling.

Environment knobs:

| Env | Meaning |
|---|---|
| `NEKKO_RELAY_PORT` / `NEKKO_RELAY_HOST` | Bind (default `0.0.0.0:4400`) |
| `APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID` | Enable iOS push |
| `FCM_SERVICE_ACCOUNT` | Enable Android push (service-account JSON) |
| `NEKKO_RELAY_AUTHZ_URL` | Gate agent enrollment on a Nekko Agent Cloud account (managed hosting) |
| `NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1` | Explicitly allow unauthenticated agent enrollment for trusted/private deployments; otherwise agent enrollment is disabled when no authz URL is configured |

The relay validates device IDs as UUIDs and push tokens as non-empty platform
tokens. A connected device cannot replace another connection's push token for
the same device ID. Keep the relay behind TLS (`wss://`) and do not enable the
unauthenticated mode on a public endpoint.

## Headless agents

A machine without a screen (server, homelab box) can expose itself with the relay-agent mode:

```bash
NEKKO_RELAY_URL=wss://your-relay NEKKO_ROOM=myroom NEKKO_PAIR_KEY=<secret> npx nekko-agent
```

It prints a one-time pairing code (10 minutes) at boot and keeps the same persistent device
registry as the desktop app.
