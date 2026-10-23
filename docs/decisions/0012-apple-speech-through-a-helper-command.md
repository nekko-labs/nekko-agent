---
status: accepted
date: 2026-10-23
---

# 0012. Apple's on-device speech through a helper command

## Context

Nekko Voice (whisper.cpp + Whisper Tiny.en, served by the daemon) had no verified macOS build, so dictation on a Mac could only open setup. Philip asked on 2026-10-22 for dictation that works now, with Apple's own on-device model where it exists, and a System models section where speech models are installed and removed like any other.

macOS 26 ships `SpeechAnalyzer` / `SpeechTranscriber`: on-device, language packs managed by the OS, no download for an installed locale, and no speech authorization for file input. It is a Swift-only API.

## Options considered

1. **Bind the API from Rust** (`objc2` in `nekko-native`, as the microphone permission does). No child process, but SpeechAnalyzer is Swift async with no Objective-C surface, so the binding would be a Swift shim anyway.
2. **A small Swift command** beside the daemon, one JSON line per run, built by the staging script with `swiftc`. One process start per transcription (about half a second end to end on an M-series Mac, measured on the 10 s sample), no server lifetime to manage, and a fake script stands in for it in tests.
3. **Chromium's on-device recognition from the renderer.** `localDictation.ts` already tries it, but Electron does not ship the engine, so it always fails.

## Decision

**Option 2.** `crates/nekkod/speech/nekko-speech.swift`, staged by `apps/desktop/scripts/stage-daemon.mjs` next to `nekkod` (dev and release). The daemon's `voice.rs` keeps Whisper as it was and adds `settings.voice.engine` (`apple` | `whisper`), defaulting to Apple wherever the helper reports support. `voice:status` keeps its shape (`installed`, `installing`, `error` speak for the active engine) and appends `engine`, `apple` and `whisper` blocks, so the phone apps and the existing composer keep working unchanged.

The helper is built for the host architecture only (`-target <arch>-apple-macos13`); the status answer is cached for 5 s. Streaming partial results and Bark 3.0 are later slices.
