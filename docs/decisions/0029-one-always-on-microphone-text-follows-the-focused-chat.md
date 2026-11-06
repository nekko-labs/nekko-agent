---
status: accepted
date: 2026-10-27
---

# 0029. One always-on microphone for the whole app; text follows the focused chat

## Context

Dictation on desktop was single-shot: tap the microphone in a chat's message box, speak, and the recording was transcribed into that chat when it stopped. Always-on dictation with "Nekko, ..." commands ([spec](../../spec/models/system-speech-models.md#always-on-dictation-and-nekko-commands-desktop), [design](../superpowers/specs/2026-10-27-always-on-voice-design.md)) has to keep listening while the person switches chats, opens another page or looks at another window, and commands such as "Nekko, open the one about billing" or "Nekko, open settings" change the screen the microphone was started from. Every chat pane renders its own composer and button, and the agent board unmounts and remounts panes as you move between chats; only the Chat view mounts any composer at all. The daemon transcribes one recording at a time.

## Options considered

1. **Keep single-shot and add an always-on mode beside it.** Two behaviours behind one button, two sets of docs, and the old mode's per-button recording would still have to coexist with an app-wide one. Rejected: it keeps the confusing part and adds a setting nobody asked for.
2. **One capture per button.** Each composer owns its microphone. Switching chats (or a voice "open the one about X") unmounts the button and kills listening, and two mounted composers on the wall would each want the microphone.
3. **One app-wide capture; composers only register as targets.** The microphone lives in `voiceActions.ts`, independent of any component. Each segment goes to the chat focused when it finishes, else the chat that turned listening on. With no composer mounted (Settings, Models) dictated words are appended to that chat's saved draft and commands keep running. Listening stops only on the toggle, a screen lock or sleep, or voice being turned off.

## Decision

Option 3, and single-shot dictation is removed. It is the only shape where "the mic stays on until I turn it off" is literally true: a chat switch, a page change or a voice command cannot silently end listening, and the stop causes the first-open video and the docs list are the whole list. Text following the focused chat matches what the person is looking at; falling back to the owning chat's saved draft means dictated words are never dropped, even with no composer on screen. Chat-scoped commands (erase, send, ship, status, complete) still need a focused chat and say "Open a chat first" otherwise, so they never act on a chat the person cannot see.

## Consequences

- The capture outlives every composer, so the voice-off and lock watches live in `voiceListener.start()`, subscribed before the microphone opens, not in a component.
- On a page with no chat there is no strip: confirmation lists are shown as a toast, and each dictated piece toasts "Added to <chat title> draft".
- Segments are transcribed one at a time because the daemon is single-flight; a slow first transcription (whisper-server cold start) delays later segments but no longer drops them.
- The phone apps keep their own dictation; the iPhone always-on mic is separate work and should follow the same text-follows-focus rule.
- If people lose track of whether the microphone is on while on another page, add an app-wide listening indicator (title bar or tray); that would be the sign this was wrong as built.
