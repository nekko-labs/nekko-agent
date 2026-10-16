# Nekko Agent relay

A dumb, end-to-end-encrypted pipe that pairs remote devices (your phone) with a
local agent (your desktop) by room code, so a phone can drive your local model
with no inbound ports. The relay never sees conversation content, only the
routing envelope and content-free control frames.

v2 protocol: each device connection gets a `cid`; the relay tags device→agent
frames (`{type:'c', cid, data}`) and the agent unicasts back (`{type:'d', cid,
data}`), so no device ever receives another's traffic. The agent can `kick` a
cid (revocation). Device auth itself is end-to-end (the HELLO handshake rides
the ciphertext); the relay just enforces the room key, frame-size caps, a
per-connection rate limit, and client/room limits. Full user-facing guide,
including self-hosting (Docker / Compose / Coolify / Fly): [docs/REMOTE.md](../../docs/REMOTE.md).

```bash
npm run build -w @nekko-agent/relay
npm run start -w @nekko-agent/relay      # ws://0.0.0.0:4400/relay

# or the container (build from the repo root)
docker build -f apps/relay/Dockerfile -t nekko-agent-relay .
docker run -p 4400:4400 nekko-agent-relay
```

Env: `NEKKO_RELAY_PORT` (4400), `NEKKO_RELAY_HOST` (0.0.0.0),
`NEKKO_RELAY_AUTHZ_URL` (optional: gate agent enrollment on a Nekko Agent Cloud
account for managed hosting; agents then connect with `&access=<bearer>` and the
relay POSTs it to this URL, expecting `{ok:true}`).

The managed instance lives at `wss://nekko-agent-relay.fly.dev`
(`fly deploy -c apps/relay/fly.toml --dockerfile apps/relay/Dockerfile .` from
the repo root; keep it at one machine, rooms are in-memory).

## Remote push (optional)

When a desktop finishes a run, it sends a content-free `notify` control frame.
If the paired phone is **offline**, the relay sends it a push notification using
the token the phone registered (`register-push` frame). Configure APNs:

| Env var | What |
| --- | --- |
| `APNS_KEY_P8` | Contents of the APNs auth key `.p8` (PEM, with newlines) |
| `APNS_KEY_ID` | The key's 10-char Key ID |
| `APNS_TEAM_ID` | Apple Team ID |
| `APNS_BUNDLE_ID` | App bundle id (default `dev.nekkolabs.nekkoagent`) |
| `APNS_EXTRA_BUNDLE_IDS` | Other iPhone apps the same key may push to, comma-separated, chosen by the phone's `app` field (default `com.nekko.native.ios`, the native SwiftUI app) |
| `APNS_PRODUCTION` | `1` for the production APNs host (default: sandbox) |

**Android (FCM)**: set `FCM_SERVICE_ACCOUNT` to the full service-account JSON
(with `client_email`, `private_key`, `project_id`). The relay mints an OAuth
token (RS256 assertion) and sends via FCM HTTP v1.

Without these the relay runs normally and just logs that push is disabled.

The privacy model holds: the push body is generic ("Your task finished"); the
relay only learns *that* a run completed, never its contents.

### Live Activities (iPhone)

The native iPhone app shows a running chat on the Lock Screen and in the
Dynamic Island. iOS suspends the app soon after it leaves the screen, so the
relay keeps those current:

- The phone sends `{type:'register-activity', deviceId, tag, token, app}`, with
  the Live Activity's ActivityKit push token. `tag` is the first 32 hex digits
  of sha256(`nekko-activity:` + session id), so the relay never learns which chat
  it is.
- The computer sends `{type:'activity', tag, phase, callId?, severity?}` when a
  chat starts, waits on an approval or a question, runs again, or ends.
- The relay answers with an APNs `liveactivity` push to
  `<bundle>.push-type.liveactivity`: an update, or an end for `done` / `failed`,
  after which the tag is forgotten. This happens whether or not the phone looks
  connected, because a suspended app's socket can linger.

The content state carries the phase only, plus an approval's opaque call id and
risk level so the Allow / Deny buttons work. It never carries text. A room keeps
at most 64 activities, each for at most 12 hours.
