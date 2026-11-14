---
status: accepted
date: 2026-11-14
---

# 0099. CarPlay is a voice-based conversational app, with speech on the phone

## Context

Issue #2781 asked for Nekko in CarPlay: voice, active work, and a screen for what voice commands did. CarPlay apps exist only in categories Apple grants by entitlement, and each category fixes which templates an app may use and how deep they go. Speech has to be turned into text somewhere: the phone, the paired computer, or a service in Nekko Cloud.

## Decision

- The app uses the **voice-based conversational** category (`com.apple.developer.carplay-voice-based-conversation`, iOS 26.4+). It opens listening and uses a tab bar (Work, Results), a chat information screen, and the voice control template, never more than three deep.
- **Speech is recognized and spoken on the iPhone** (Apple's on-device recognizer and system voices), with the computer's Whisper as the fallback when the phone can't recognize the language on the device. Nothing is added to Nekko Cloud.
- Replies are **spoken, never drawn**; the Results list shows only what was done and how it ended.
- Every change is **read back and needs a spoken yes**; allowing a tool keeps the app's rule that the iPhone must be unlocked, and high-risk approvals are never allowed from the car.
- The rules live in NekkoKit (`CarSession`, `CarCommands`) and are tested on Linux; the CarPlay scene only draws templates.

## Options considered

- **Communication category (SiriKit messaging).** It would make each chat a "conversation" Siri reads and sends to. It needs all three messaging intents, gives Siri the words instead of our read-back rules, and has no place for approvals, stopping work or a Results list. Not chosen.
- **Driving task category.** Its templates fit, but it is for tasks tied to driving, and an agent app is not one. It would not pass review.
- **Recognize speech in Nekko Cloud.** Better accuracy in some languages, but it sends the driver's voice to our servers, needs a connection the car may not have, and adds a cost per minute. The phone's recognizer is private and fast, and it works in a tunnel. Not chosen; we can revisit for languages the phone can't recognize on the device.
- **Show replies on screen.** It is what "see the results" first suggests, but Apple's guidelines forbid text in answers and message contents. Not possible in this category.

## Consequences

- Apple must grant the entitlement before release. Until then the CarPlay scene is inert, and the app is signed with the entitlements it has today.
- The command grammar is English only at first, like the Lock Screen card's.
- The car's screen shows chat titles and steps, which passengers can see (open question in the spec).
- Android needs its own answer in Android Auto (#2782). The grammar should become a shared fixture when that lands.
