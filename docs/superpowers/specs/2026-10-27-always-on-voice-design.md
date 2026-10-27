# Always-on voice, voice commands and Live Activity levels

Date: 2026-10-27. Apps: desktop (Electron renderer) and iOS. Android and the Local Web UI are out of scope.

## Intent

Philip wants to talk to Nekko Agent the way he'd talk to a colleague at the next desk: turn the microphone on once and leave it on, dictate into the message box, and steer the app by voice ("Nekko, erase that", "Nekko, ship it", "Nekko, how's it going") without touching the screen. Away from the phone's screen, the Live Activity should let him speak to a running chat and see what it is doing ("Got it. Working on it now", then "Watching PR…", "Fixing merge conflicts"). A first-open video explains how it works and makes the privacy promise: we don't use your voice, and your data stays yours.

## Goals

1. **Always-on dictation.** The microphone button is a toggle. On means listening until toggled off. Pauses never end it (today desktop stops after ~1.2 s of quiet or 60 s total; iOS stops at 30 s).
2. **Voice commands by wake word.** Speech is typed into the message box unless it starts with "Nekko" (any spelling the recognizer produces: Nekko, Neko, Neco, Necko; the existing desktop regex). Then it is a command.
3. **Same commands on desktop and iOS.**
4. **First-open video**, built with the Remotion skill, on both apps.
5. **The privacy promise is true everywhere**, including the iOS fallback.
6. **Live Activity:** a mic button that sends speech to that chat's agent, the agent's latest reply and a live status line, a display-level setting (None / Minimal / Standard / Detailed) with a live preview, and the chat status icons plus the Nekko mascot on the left.

## Non-goals

- Android, Local Web UI.
- Listening while the iPhone is locked or the app is in the background (in-app always-on stops; the Live Activity mic is the locked-phone path).
- Speaking replies aloud (TTS). "How's it going" is shown, not spoken.
- Free-form command understanding by an LLM. Commands are a fixed grammar.

## Anti-goals (failure even if it works)

- Any audio or transcript leaving the user's devices other than to their own paired computer. The video says so; it must be true.
- A command firing from ordinary dictation. Without the wake word, nothing is a command.
- Losing words: a "Nekko …" phrase that matches no command is typed as text, never dropped.
- Merging a PR or completing a chat without a confirm.

## Always-on listening

**Desktop** (`DictationButton.tsx`, `voiceCapture.ts`). One mode: the button toggles always-on (the single-shot mode goes away). Capture runs continuously. The existing silence detector becomes a *segment boundary*: on silence after speech, the current segment's WAV is cut, sent to `voiceTranscribe` (local Whisper), and capture continues. A segment is force-cut at 30 s. Segments are transcribed in order; results apply in order even if a later one finishes first. Each segment's text goes through the command parser. Listening continues when the window loses focus; it stops on toggle off, on system lock/sleep (`powerMonitor`), and if voice is switched off in settings. Text goes into the composer of the chat that is focused when the segment finishes.

**Where a command can start** (my call): at the start of a segment or at the start of a sentence inside one (after `.`, `!` or `?` from the recognizer), so "…fix the login bug. Nekko, send it" types the first sentence and runs the command. "Nekko" mid-sentence ("tell Nekko to create a new session") stays dictation, as the existing tests require. While on, the button is red and a small strip shows the level meter and the last heard phrase.

**iOS** (`Platform/Dictation.swift`, `ChatView.swift`, `MarkdownComposer.swift`). Same toggle. Two engines as today:
- *Computer (Whisper over the relay):* the 30 s cap becomes a per-segment cap; segments cut on silence and sent one by one (each stays under the relay frame limit, see the iOS spec).
- *This phone (SFSpeech):* continuous recognition; requests are restarted at segment boundaries (Apple limits one request to about a minute). `requiresOnDeviceRecognition = true` always. **If the recognizer does not support on-device recognition for the language, dictation refuses** with a message saying why, instead of today's silent fallback to Apple's servers (`Dictation.swift:191`).

Listening stops when the scene leaves `.active` (lock, app switch) and does not resume by itself.

The shipped Tap / Hold setting (IO-28) stays (my call): Tap becomes the always-on toggle, Hold keeps working as push-to-talk, one segment per hold.

## Commands

A shared grammar, implemented twice (TS in `voiceCommands.ts`, Swift on iOS) and held equal by one JSON fixture of phrase → intent cases in `packages/shared` that both test suites read (the repo's golden-test pattern).

| Say "Nekko, …" | Does | Confirm |
|---|---|---|
| erase that / scratch that / cancel that / undo that | removes the last dictated segment from the draft | no |
| clear it / clear everything | empties the draft | no |
| send it / send | sends the draft | no |
| new session / new agent session / new chat / let's make a new change | starts a new chat (existing `newChat`) | no |
| how's it going / status | shows the focused chat's status line (phase + current step, or "Watching PR" when idle with watches) as a toast | no |
| open the one about X / open the other one related to X / switch to X | fuzzy-matches chat titles and first message; one clear winner switches to it; otherwise shows the top 3 to pick by tap or "Nekko, the first/second/third one" | no |
| ship it | see below | merge only |
| complete / finish / archive this session | completes the chat | yes |
| go to / open <page>, desktop/screen commands | existing behavior on desktop. On iOS (my call): pages that exist on the phone (settings, chats) open there; desktop-only pages and desktop/screen switching answer "That one works on the computer" and type nothing | no (as today) |
| yes / confirm, no / cancel | answers a pending confirm | n/a |

While a confirm is pending, "Nekko, cancel" answers it; otherwise "cancel that" erases. Confirms read "… Say 'Nekko, yes' or tap Confirm." Every executed command shows a short toast ("Erased", "New chat", "Merging PR #123"); iOS adds a light haptic. Unknown "Nekko …" phrases are typed as text (today they open an "Unrecognized command" popup; that popup goes). The setting `voice.commandsEnabled = false` still turns all of this off.

**"Ship it"** depends on the focused chat:
- It has an open PR: merge it through the existing PR action (`PrCard` on desktop, `pr:action merge` on the phone), after a confirm naming the PR. Stacked PRs keep today's behavior (open on GitHub).
- No open PR, and the agent is idle or waiting on a question: send "Go ahead and build it." to the agent. No confirm (Stop is right there).
- Both (open PR and a pending question): ask which.
- Still running with no PR: toast "It's still working".

## First-open video

Shown the first time the user turns dictation on (not app launch), then remembered (desktop: settings, like the zones intro `ZonesIntro.tsx`; iOS: `Prefs`). Re-openable from voice settings. Made with the Remotion skill. Desktop plays it live with `@remotion/player` (already a dependency), lazily loaded like `ZonesIntro`. iOS bundles an MP4 rendered from the same composition and plays it with AVKit; it also needs light and dark renders or a neutral design that reads in both.

Content, about 30 to 45 s, captions on screen, no voiceover: tap the mic once and it stays on; talk and words appear; say "Nekko" to give a command (two or three examples); on iPhone it stops when you lock, and the Live Activity mic works from the Lock Screen after Face ID; privacy card: "Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours." Then the existing Turn on / Not now.

## Live Activity

### Look (all levels except None)

The left side shows the Nekko mascot and, on it or beside it, the same status icon the chat list uses (`ChatStatusIcon`: working, needs you, idle/watching, done, failed). The mascot art comes from the desktop's existing mascot assets, added to the widget extension's asset catalog.

### Lifecycle (decided 2026-10-27)

- A chat's card stays up while the chat is running or watching a PR ("Watching PR…").
- When the chat finishes, the card **stays for two more hours** (Philip's call), then ends. While it is up, it still answers the mic, and "Watching PR…" or a new run updates it in place.
- A finished card has a **close button with a checkmark** that ends it at once. The label is a random pick from a short friendly list ("Looks good", "Cool", "Excellent", "Nice", "Perfect"), chosen once per card so it doesn't change on each update. My call: a failed card uses "Got it" instead, since "Excellent" reads wrong on a failure.
- It also ends when the chat is completed or deleted, or at iOS's own limit.
- **Remote start, now** (Philip's call): the computer can start a card while the app is suspended, through ActivityKit push-to-start (iOS 17.2+). The phone registers its push-to-start token with the relay. The computer asks the relay to start one, in both editions (TS relay agent and Rust `nekko-remote`), with the same content rules as updates. My call on which runs start one remotely, so a busy desktop doesn't flood the Lock Screen: a run woken by a PR watch, and a run in a chat this phone sent a message to in the last two hours. iOS 17.0 and 17.1 keep app-started cards only.
- Builder's call: whether the two-hour tail is an active card ended later, or an ended card with a two-hour dismissal date, as long as the mic and close button keep working.

### Levels (iOS Settings → Live Activities)

| Level | Shows |
|---|---|
| None | no Live Activities are started |
| Minimal | mascot + status icon, generic phase line ("Working…", "Needs your approval"), elapsed time, Stop / Deny. No chat title, no text from the chat. Content-free pushes, exactly as today. |
| Standard (default) | Minimal + chat title + live status line (the current step: "Run npm test", "Fixing merge conflicts", "Watching PR…") + Allow/Deny details |
| Detailed | Standard + the agent's latest reply line ("Got it. Working on it now.") + the mic button |

The setting shows the real Live Activity view above the four options, rendered in-app with sample content, and it changes as each level is selected. To make it the real design, the Lock Screen view and the Dynamic Island expanded view move into code shared by the app and the widget extension (`App/Shared/`), and both the preview and the widget use it.

**Privacy.** Chat content (title, status line, reply) is marked `.privacySensitive()`, so it is visible only when the phone is unlocked and redacted to the Minimal look while locked. At Standard and Detailed, the relay's suspended-app pushes carry that text in the push payload, so it passes through the relay and Apple's push service unencrypted. The setting says so under those two options. Today's rule that app lock forces generic Live Activities is replaced by this setting plus the locked-phone redaction. **Existing installs** (my call): with app lock on (the default) they start at Minimal, so nobody's chat text starts passing through the relay and Apple without choosing it; with app lock off they start at Standard. New installs follow the same rule. If `.privacySensitive()` turns out not to redact Live Activities on the Lock Screen, the level decides directly and the Standard and Detailed copy says "shown on the Lock Screen, even when locked".

### Mic button (Detailed only)

**Requires Face ID or the passcode** (Philip's call), like Allow does today: the intent uses `.requiresAuthentication`, so on a locked phone you glance or unlock, then speak. Tap it, speak, and the words are sent straight to that chat as a message (no wake word, no review step: there is no message box here). Uses `AudioRecordingIntent` (iOS 18+), which runs in the app's process and keeps the Live Activity as the recording indicator. On iOS 17 the button opens the app into that chat with listening already on. Recording stops on silence or a second tap, transcribes with the user's chosen engine (same on-device rule), and sends via `chat:send` (or `chat:queue` mid-run). The card shows "Sent: …" until the agent's reply arrives.

## Constraints

- No em dashes in UI copy or docs.
- Spec updates in the same PRs: `spec/phone/native-ios-app.md`, the desktop voice spec (`spec/models/system-speech-models.md` and/or the chat composer spec), plus a docs page on nekkoagent.com/docs.
- Landing: worktree + PR per layer, `gh pr merge --auto`, stacked if a layer is several hundred lines.
- Visual evidence per `docs/runbooks/visual-evidence.md`.

## Left to the builder

- Exact segment silence threshold in always-on (start from the current 1.2 s setting).
- Fuzzy-match scoring and the "clear winner" margin.
- Video storyboard details, timing and style within the content above.
- How the reply line is extracted (first sentence of the latest assistant message, trimmed).
- Order of layers. Suggested: (1) desktop always-on + commands + shared fixture, (2) iOS always-on + commands + on-device-only, (3) Live Activity look + levels + preview, (4) Live Activity mic and reply line, (5) video on both.

## Risks to verify early

- Whether `.privacySensitive()` redacts Live Activity content on the Lock Screen. If it doesn't, Standard and Detailed show content on a locked phone, and the setting copy must say so (or the level decides it directly).
- Whether `AudioRecordingIntent` combines with `.requiresAuthentication` from the Lock Screen (Face ID, then recording starts without opening the app).
- Push-to-start delivery and token rotation on a real device (the relay has no APNs key in production yet, per the iOS spec).
- Relay push payload size and shape with text added (both editions: TS relay and Rust `nekko-remote`).
