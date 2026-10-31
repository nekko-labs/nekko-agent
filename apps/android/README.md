# Nekko Agent for Android

A native Kotlin / Jetpack Compose app that drives your own computer from the
phone: pair with the QR code from **Settings → Remote access** on the computer,
then run chats there, on the computer's models, files and tools. Everything goes
through the end-to-end encrypted relay; the relay only ever sees ciphertext.

This is the supported Android implementation. The former Expo app and its dedicated
CI have been removed. Remaining native feature gaps below stay tracked separately.

## What works

- **Pairing:** Google code scanner (no camera permission needed), pasted link,
  or a `nekko-agent-pair:` link from the system camera (with confirmation).
  Several computers; one connected at a time; rename / switch / forget.
- **Chats on the computer:** list with *Running* / *Needs you* badges and
  pull-to-refresh; new chat on any of the computer's models (every enabled
  provider's list in one picker, opening on its default or latest-used model)
  and folder; live streamed
  replies; Stop; prompts sent during a run are queued; **Allow / Deny** cards
  that show the exact command; the agent's questions as choices with a free-text
  answer. Transcripts are re-read after each turn and after reconnecting.

- **App lock:** fingerprint, face or the phone's screen lock every time the app
  opens or comes back (on by default, *Settings → Security*). Locked means nothing
  is shown or approvable, recents stay blank (`FLAG_SECURE`), and after a restart
  the relay doesn't connect until the first unlock.

- **Step-up (unverified on hardware):** when the computer answers a mode raise
  with `step-up-required`, a sheet asks for a security key or passkey
  (Credential Manager) or a one-time code and sends the call again with
  `stepUp`. Android is expected to refuse the computer's `nekko-computer:`
  relying-party id (no Digital Asset Links), so in practice the code is the
  way in today; the sheet says so. Raises also need the Change proof, which
  this app can't sign yet (AN-30). *Settings → Security* lists the computer's
  methods by kind.
- **Safety exits:** *Settings → This computer* and the connection banner's ⋮:
  *Sign out this phone* (forgets the computer now, tells it now or at the next
  start), *Stop remote access on the computer*, and *Quit Nekko Agent on the
  computer* (confirmed, only when the computer allows it).

- **New chat defaults:** *Settings → New chats* sets the computer to connect
  to at start and a model per computer, on the phone only; a model the
  computer no longer offers falls back to its default with a notice.
- **Share to Nekko:** text or a link from another app's share menu opens New
  chat with it, editable; it lands in the new chat's message box and is never
  sent automatically. Memory only, text only (≤ 20,000 characters).
- **Vibration:** a distinct buzz while the app is open when the agent needs an
  approval or asks a question (on by default), and optionally when a reply
  finishes or fails; never in silent mode or Do Not Disturb.

- **The computer's settings:** *Settings → On <computer>* sets its default chat
  mode (YOLO allowed after a confirmation), the long-press action (Complete or
  Delete) and delete confirmation; a long-press on a chat runs that action.

- **The + menu:** left of the message box, Send on the right. **Dictate**,
  **Image from files** (system photo picker, no storage permission) and **Take
  photo** (the camera app, no camera permission). Up to 4 photos, scaled to
  1600 px JPEG in memory, go with the next message as `images`.
- **Dictation:** **+ → Dictate**; the text goes in the box and
  you press Send. Whisper on the computer (encrypted, up to 30 s) when its Nekko
  Voice is on, else the phone's recognizer; *Settings → Dictation*.

- **The computer's skills:** type `/` in the message box for the skills on the
  computer (built-in, Marketplace, imported from Claude Code / Codex / Gemini),
  re-read every time a chat opens. The computer adds each skill's instructions
  itself; the phone only ever sees names and descriptions. No `/goal`.

- **Folding phones and tablets** (written, not yet run on a foldable): open
  (600 dp or wider) shows two panes from `FoldingFeature` and the window size
  class (`ui/panes/`): *Chats + Chat* first, also *Chat + Chat*, *Chat +
  Monitors* and *Monitors + Chats*, with Swap, Focus and Replace with… in each
  pane's header. Side by side when wide, stacked when tall (the list never
  below a chat), the divider on the hinge or dragged 35–65; tabletop puts the
  transcript above the hinge and the message box below it. Remembered per
  computer on the phone. A message dragged to the other pane lands in its
  message box, unsent.
- **Monitors:** the computer's hardware load and temperatures, running chats,
  what needs you (Allow / Deny / answer) and the next automations, from
  `monitor:summary` every 10 s while on screen; a pane when open, the last row
  of the chat list on any phone.
- **Simple and Expert:** a switch right of Back in every chat (the dial icon alone in a
  folding phone's pane). Both modes: model and effort (an effort dial and the model's name,
  opening a sheet with the model list and a large dial) and the context ring (`12.3k / 128k`,
  tap for the breakdown) under the message box. Expert adds the computer's CPU, memory, GPU
  and VRAM dials and the loaded-model count under the header, re-read every 3 s while shown,
  and a Monitor sheet with Unload (`system:stats`, `gpu:stats`, `engine:status`,
  `context:preview`, `model:unload`).
- **Send feedback:** *Settings → Feedback* copies a prompt for your own coding
  agent to file a GitHub issue, sends a quick note to Nekko Labs through Nekko
  Cloud (app, version, OS and CPU type only when *Include app info* is on), or
  opens GitHub issues.

**Not yet:** models on the phone, push notifications, Markdown rendering,
files other than photos, thumbnails of sent photos, Play Store release. See `TASKS.md` → *Native Android app*.

## Layout

```
apps/android/
  protocol/   pure Kotlin/JVM: E2E crypto, pairing links, relay v2 client,
              wire decoders, transcript model. No Android dependency.
  app/        Compose UI, ComputersRepository, ChatController, Keystore storage
  scripts/    e2e-vector.mjs (cross-language crypto check), fake-model.mjs (itest)
```

| Piece | Kotlin | Mirrors |
|---|---|---|
| Crypto | `protocol/.../E2E.kt` | `packages/shared/src/e2e.ts` |
| Relay client | `protocol/.../RelayClient.kt` | The computer's side in `crates/nekko-remote` |
| Pairing links | `protocol/.../Pairing.kt` | Shared pairing fixtures and native protocol tests |
| Transcript | `protocol/.../Transcript.kt` | Native transcript tests |
| Chat logic | `app/.../chat/ChatController.kt` | Native chat controller tests |
| Computers | `app/.../data/ComputersRepository.kt` | Native computer repository tests |
| Posture and panes | `protocol/.../Posture.kt`, `protocol/.../Panes.kt` | `apps/ios/Protocol/Sources/NekkoKit/Posture.swift` |
| Monitors | `protocol/.../MonitorSummary.kt` | `phoneMonitorView` in `packages/shared/src/phone-views.ts` |
| Expert monitor, context, effort | `protocol/.../HardwareMonitor.kt` | `apps/ios/Protocol/Sources/NekkoProtocol/HardwareMonitor.swift` |

## Security notes

- The app lock (`app/.../lock/`) is UI-only: it gates what the phone shows and
  sends, it does not encrypt anything with the user's credential. A rooted or
  compromised phone is out of scope; revoke the phone on the computer instead.

- Pairing material (room, secret, PBKDF2-derived key, device id) is sealed with
  AES-256-GCM under a non-exportable **Android Keystore** key before it touches
  disk, and the app opts out of backup and device transfer.
- `providers:list` and `settings:get` replies carry API keys; they are reduced
  to ids, labels and the default model on arrival and never stored or logged.
- `wss://` anywhere; plain `ws://` only to the tailnet or the LAN, never the
  open internet, as on the iPhone. The network security config permits
  cleartext app-wide (it can't name IP ranges), so the app refuses public
  `ws://` before dialing (`RelayRoute.publicCleartext`). Debug builds also
  dial a loopback relay, for `adb reverse`.
- The one-time pairing code is dropped from storage once the computer welcomes
  the phone, and is never sent again.

## Build and test

Requirements: JDK 17 and the Android SDK (platform `android-37.2`, build-tools
36). Android Studio is optional for building; it is the easiest way to run an
emulator.

```sh
cd apps/android
export JAVA_HOME=$(/usr/libexec/java_home -v 17)    # or the Homebrew openjdk@17 path
echo "sdk.dir=$ANDROID_HOME" > local.properties     # if ANDROID_HOME isn't set globally

./gradlew :protocol:test :app:testDebugUnitTest      # JVM tests
./gradlew :app:lintDebug :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
```

Cross-language crypto check (Kotlin seals, the agent's implementation opens):

```sh
NEKKO_E2E_OUT=/tmp/frames.json ./gradlew :protocol:test --tests '*E2ETest*' --rerun
node scripts/e2e-vector.mjs open /tmp/frames.json
```

Live integration test against the real relay and a headless agent with a fake
model (build the TS side first, from the repo root):

```sh
npm ci && npm run build:core \
  && npm run build --workspace=apps/cli && npm run build -w @nekko-agent/local-web-ui \
  && npm run build -w @nekko-agent/relay-server
cd apps/android && NEKKO_ITEST=1 ./gradlew :protocol:test --tests '*RelayIntegrationTest*'
```

## Trying it on an emulator or phone

1. Start a local relay and agent from the repo root (the agent prints a pairing
   link and a one-time code):
   ```sh
   NEKKO_RELAY_PORT=4400 NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 node apps/relay-server/dist/index.js
   NEKKO_RELAY_URL=ws://127.0.0.1:4400 NEKKO_ROOM=<16 hex> NEKKO_PAIR_KEY=<32 hex> node apps/local-web-ui/dist/index.js
   ```
   Or use the desktop app's **Settings → Remote access** with the managed relay.
2. Install the debug APK: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
3. For a local relay on a USB phone run `adb reverse tcp:4400 tcp:4400` and pair
   with `ws://localhost:4400`; on the emulator use `ws://10.0.2.2:4400`. Paste the
   pairing link (`nekko-agent-pair:?relay=…&room=…&key=…&pair=…`) on the Pair screen.
