---
title: "System models: dictation on Apple's recognizer or Whisper"
area: models
---

# System models: dictation on Apple's recognizer or Whisper

**Intent.** Dictation should work the moment someone clicks the microphone, with no download where the operating system already has a speech model. Speech recognizers are models too, but the OS or Nekko Voice runs them rather than the engine, so they get their own **System models** block on the Models page with install, remove and "use for dictation" instead of a Load button. Audio never leaves the computer.

**What a person sees** `[implemented 2026-10-23; live-checked on macOS 27]`

- **Models → System models** (a collapsible block under *In memory*) lists the speech engines as rows: **Apple speech** (on-device, built into macOS 26 and later; the current language pack's state) and **Whisper Tiny English** (Nekko Voice: a 32 MB model plus the whisper.cpp runtime, Windows and Linux). Each row offers one action: **Use** when installed, **Install language pack** / **Download** when not, **Remove** / **Uninstall** when installed, **Turn off** on the row in use. The same rows are the **Dictation** section in Settings and the microphone's setup popover.
- **The microphone in the composer** records locally and sends the recording to the active engine. The first click with no engine chosen opens the rows; choosing one enables dictation and closes the popover. Text is inserted into the draft, never sent; "Nekko, ..." commands are still confirmed before they run (see [chat composer](../chat/workspace-context-commands-and-connected-composer.md)).
- **The active engine** is `settings.voice.engine`; unset means Apple's recognizer wherever it is supported, else Whisper. Apple's is listed only where the helper could answer (macOS); an older macOS shows the row with the reason and no action. The settings' **Recognition language** picks the Apple locale too: a bare code like `en` resolves to the current locale when its language matches, else the language's home region (`fr` → `fr-FR`), else the first installed or supported locale.

**How it runs.** Apple's recognizer is reached through `nekko-speech`, a small Swift command (SpeechAnalyzer + SpeechTranscriber, `crates/nekkod/speech/`) staged beside the daemon by `stage-daemon.mjs`. The daemon runs it once per transcription on a WAV written beside the install and removed afterwards; there is no server to keep alive, and the language packs belong to macOS (Remove releases Nekko's reservation; macOS may keep the pack for other apps). Status answers are cached for five seconds because the UI polls every second. No speech-recognition authorization is needed for file input; the microphone permission stays where it was. See [decision 0012](../../docs/decisions/0012-apple-speech-through-a-helper-command.md).

**Boundaries.** Recording is still 16 kHz mono PCM of at most 60 seconds, validated before anything runs. A Mac without the helper (a build staged without `swiftc`) reports Apple as unsupported and dictation falls back to Whisper's row. Phones that dictate through the computer (`voice:transcribe`) use whichever engine is active.

**Planned, not built.** A **Bark 3.0** row (Underdog's Parakeet-derived English model: the 163 MB file is a packed format for Underdog's own runtimes; the ONNX export runs on the in-tree `ort` crate at about 685 MB int8), Whisper on macOS, streaming partial results, spoken conversation with the agent, and voice-driven computer control beyond the confirmed "Nekko, ..." commands (the [offline PC-control plan](../automation/one-click-setup-for-safe-offline-pc-control.md), AN9d/AN9e).
