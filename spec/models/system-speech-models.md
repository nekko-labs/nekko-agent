---
title: "System models: dictation on Apple's recognizer or Whisper"
area: models
---

# System models: dictation on Apple's recognizer or Whisper

**Intent.** Dictation should work the moment someone clicks the microphone, with no download where the operating system already has a speech model. Speech recognizers are models too, but the OS or Nekko Voice runs them rather than the engine, so they get their own **System models** block on the Models page with install, remove and "use for dictation" instead of a Load button. Audio never leaves the computer.

**What a person sees** `[implemented 2026-10-23; live-checked on macOS 27]`

- **Models → System models** (a collapsible block under *In memory*) lists the speech engines as rows: **Apple speech** (on-device, built into macOS 26 and later; the current language pack's state) and **Whisper Tiny English** (Nekko Voice: a 32 MB model plus the whisper.cpp runtime, Windows and Linux). Each row offers one action: **Use** when installed, **Install language pack** / **Download** when not, **Remove** / **Uninstall** when installed, **Turn off** on the row in use. The same rows are the **Dictation** section in Settings and the microphone's setup popover.
- **The microphone in the composer** records locally and sends the recording to the active engine. The first click with no engine chosen opens the rows; choosing one enables dictation and closes the popover. Text is inserted into the draft, never sent by dictation alone. Since 2026-10-27 the microphone is an always-on toggle with "Nekko, ..." commands; see **Always-on dictation** below.
- **Switching desktops and screens by voice (2026-10-24).** User intent (Philip): "When someone is using dictation, we'll want them to be able to say things like switch desktops / screens." "Nekko, switch to desktop 2" (also "go to", "move to", spoken numbers, and "to"/"too" heard for two), "Nekko, next desktop" / "previous desktop" (or "space"), and "Nekko, show screen 2" (or monitor, display). These run straight away, without the confirm other commands get, because they change nothing and saying it again undoes them. Desktops are macOS Spaces and need Accessibility (see the multi-monitor spec); without it the command says so. A screen command brings up that screen's Nekko window, turning it on if it was off. `[implemented; parser unit-tested; policy unit-tested with a fake Mission Control; not yet spoken end to end on a Mac with Accessibility granted]`
- **The active engine** is `settings.voice.engine`; unset means Apple's recognizer wherever it is supported, else Whisper. Apple's is listed only where the helper could answer (macOS); an older macOS shows the row with the reason and no action. The settings' **Recognition language** picks the Apple locale too: a bare code like `en` resolves to the current locale when its language matches, else the language's home region (`fr` → `fr-FR`), else the first installed or supported locale.

## Always-on dictation and Nekko commands (desktop)

**Intent.** Philip: tap the mic once and talk to the app the whole time, with "Nekko, ..." for app commands, and the privacy promise has to be true. Design: [always-on voice](../../docs/superpowers/specs/2026-10-27-always-on-voice-design.md). iPhone and the Live Activity mic are separate, later work.

**Listening** `[implemented 2026-10-27; unit-tested; hidden-window verified with a stubbed transcriber; not verified with a real microphone]`

- One tap turns the mic on and it stays on. There is **one microphone for the whole app**: it keeps listening when you switch chats or the window loses focus. While on, the button is red and a strip above it shows the level meter and the last phrase heard.
- It stops when you tap it again (the words spoken just before still count), when the computer locks or sleeps (watched from before the microphone opens, so a lock during start counts), or when voice is turned off in settings. Leaving the chats for another page does not stop it. It never starts by itself.
- Speech is cut into segments at each pause (the setting **End utterance after silence**), and at 30 s at the latest. Each segment is turned into text on this computer by the engine in use (Whisper, or Apple's on-device SpeechAnalyzer through the helper, [decision 0012](../../docs/decisions/0012-apple-speech-through-a-helper-command.md)); segments are transcribed one at a time (the daemon runs one transcription at a time and refuses a second) and apply in the order spoken. A failed transcription shows one error toast until a segment succeeds again, instead of vanishing. A transcript that is only non-speech tags ("[BLANK_AUDIO]", "[Music]", "(keyboard clicking)", the Android app's rule) is dropped.
- **Where text goes:** into the draft of the chat that is focused when the segment finishes; if no chat is focused, into the chat that turned listening on. On a page with no chat mounted (Settings, Models), it is appended to that chat's saved draft (the same per-chat draft the composer restores) with the toast "Added to <chat title> draft". Nothing is sent until you send it. [decision 0029](../../docs/decisions/0029-one-always-on-microphone-text-follows-the-focused-chat.md)

**Commands** `[implemented 2026-10-27; grammar and actions unit-tested; hidden-window verified for "send it" with a stubbed transcriber; not verified with a real microphone]`

A command starts with "Nekko" at the start of a segment or of a sentence inside one, so "Fix the login bug. Nekko, send it" types the first sentence and sends it. A wake word punctuated on its own ("Nekko. Send it.", "Nekko? Erase that.") addresses the next sentence, and a wake word cut into its own segment by a pause carries to the next segment if it arrives within 5 seconds; later, it is dropped (it holds no words). "Nekko" in the middle of a sentence stays dictation, and a "Nekko, ..." phrase that matches no command is typed as text, never dropped. Turning off **Enable "Nekko..." commands** makes everything dictation.

| Say "Nekko, ..." | Does | Toast |
|---|---|---|
| erase that / scratch that / cancel that / undo that | removes the last dictated piece from the draft | Erased, only when something was removed |
| clear it / clear everything | empties the draft | Cleared |
| send it / send | sends the draft; an empty draft is not sent, and a send the chat refuses (no model, Sandbox not configured) puts the words back | Sent, only once it sent |
| new chat / new session / let's make a new change | starts a new chat | New chat |
| how's it going / status | the focused chat's status (lane, then the current step or "Watching PR") | the status line |
| open the one about X / switch to X | one clear match opens it; several give up to three to pick by tap or "Nekko, the first one"; none types the phrase as dictation | "Opened" and the chat title |
| ship it | open PR: merge after a confirm naming it (a stacked PR opens on GitHub); no PR and idle: sends "Go ahead and build it." as its own sentence after any draft; a waiting question (with or without a PR): answers it with the free-text answer "Go ahead and build it." rather than sending, which would queue behind the blocked turn; open PR and a waiting question: offers **Merge owner/repo#123** or **Go ahead** (that answer); still running: "It's still working" | "Merging owner/repo#123" / Sent |
| complete / finish / archive this session | completes the chat, after a confirm | "Completed" and the chat title |
| go to / open a page, switch to desktop or screen n | as before (see above) | "Opened" and the page / Switched to ... |
| yes / confirm, no / cancel, the first / second / third one | answers a waiting confirm or list | Cancelled (for no) |

- Commands about a chat (erase, clear, send, ship, status, complete) act only on the focused chat; with none focused they toast **Open a chat first**.
- Only merging a PR and completing a chat ask first: "... Say 'Nekko, yes' or tap Confirm." A confirm or list waits **60 seconds**, then goes away, so a stray "Nekko, yes" later does nothing. While one is waiting, "Nekko, cancel" answers it; otherwise "cancel that" erases.

**First-open video** `[implemented 2026-10-27; unit-tested; hidden-window verified, frames inspected in light and dark]`

- The first tap on the mic, while `voice.introSeen` is not true, opens a short video (about 36 s, captions, no sound) **before** anything listens. Closing it any way (Close, Not now, Escape, clicking outside, or Turn on) saves `voice.introSeen: true`. **Turn on** then starts listening; **Not now** does not. **Settings > Dictation > Watch how voice works** plays it again, with **Done**.
- Scenes: tap the mic once and it stays on; talk and words appear in the chat you are looking at; say "Nekko" to give a command (erase that, send it, new chat); on iPhone it stops when you lock; then the promise, word for word: "Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours."
- Built with Remotion (`VoiceIntroVideo` in `components/VoiceIntro.tsx`, 1280 by 720 at 30 fps), played live with `@remotion/player`, lazily loaded, drawn with the app's own colours so it reads in light and dark. Reduced motion opens it paused on the privacy card. The same composition is to be rendered to MP4 for the iPhone.
- Planned: the iPhone scene gains "the Live Activity mic works from the Lock Screen after Face ID" once that ships; until then the video does not say it.

**How it runs.** Apple's recognizer is reached through `nekko-speech`, a small Swift command (SpeechAnalyzer + SpeechTranscriber, `crates/nekkod/speech/`) staged beside the daemon by `stage-daemon.mjs`. The daemon runs it once per transcription on a WAV written beside the install and removed afterwards; there is no server to keep alive, and the language packs belong to macOS (Remove releases Nekko's reservation; macOS may keep the pack for other apps). Status answers are cached for five seconds because the UI polls every second. No speech-recognition authorization is needed for file input; the microphone permission stays where it was. See [decision 0012](../../docs/decisions/0012-apple-speech-through-a-helper-command.md).

**Boundaries.** Recording is 16 kHz mono PCM, at most 30 seconds per always-on segment (60 for the settings' microphone test), validated before anything runs. A Mac without the helper (a build staged without `swiftc`) reports Apple as unsupported and dictation falls back to Whisper's row. Phones that dictate through the computer (`voice:transcribe`) use whichever engine is active.

**Planned, not built.** A **Bark 3.0** row (Underdog's Parakeet-derived English model: the 163 MB file is a packed format for Underdog's own runtimes; the ONNX export runs on the in-tree `ort` crate at about 685 MB int8), Whisper on macOS, streaming partial results, spoken conversation with the agent, and voice-driven computer control beyond the "Nekko, ..." commands (the [offline PC-control plan](../automation/one-click-setup-for-safe-offline-pc-control.md), AN9d/AN9e).
