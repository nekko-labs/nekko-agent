---
title: Nekko Agent in CarPlay
area: phone
---

# Nekko Agent in CarPlay (#2781)

Status: **built in source and unit-tested on Linux (46 tests); not yet compiled by Xcode CI when written, never run in CarPlay Simulator or a car; cannot ship until Apple grants the entitlement.** Android counterpart: #2782.

Design: [nekko-designs/carplay-design.html](../../nekko-designs/carplay-design.html). Why this category, and why speech stays on the phone: [decision 0099](../../docs/decisions/0099-carplay-is-a-voice-based-conversational-app.md).

## Intent

Philip asked (2026-11-14) for a CarPlay app with voice that shows active work, takes voice commands, and has its own screen for seeing what the commands did. Speech should run on the phone, or on Nekko Cloud only if it has to. Agents keep running while the driver is on the road. The Lock Screen card and notifications don't reach the car's screen, and reading the phone while driving is not an option.

## What the driver sees

CarPlay draws Apple's templates, not our views. Nekko uses the ones Apple allows for a **voice-based conversational app** (iOS 26.4+), never more than three deep:

| Screen | Template | What it shows |
| --- | --- | --- |
| Voice sheet | `CPVoiceControlTemplate`, presented | Opens on launch and from **Talk**. States: Listening…, Working on it…, Say yes to send / start / allow / deny / stop, Nekko (speaking). Cancel and Done buttons (iOS 26.4). Never shows what was said or answered. |
| **Work** tab | `CPListTemplate` in a `CPTabBarTemplate` | Every chat the Lock Screen card would list (every paired computer and this iPhone), grouped Needs you, Working, Watching, Stopped, Done, with our status glyphs. Each row shows the title and the current step or state, plus elapsed time while working; another computer's chats also name that computer. Offline, the first header says the list is the last one heard. **Talk** sits top right. |
| A chat | `CPInformationTemplate`, pushed | Status, the step it waits on (and its risk for an approval), computer, running time. Up to three buttons that apply now: **Allow** and **Deny** for an approval; **Talk**, **Hear latest**, **Stop** otherwise. |
| **Results** tab | `CPListTemplate` | One row per command this drive, newest first: what was done ("Sent to Billing retries", "Allowed run npm test", "Stopped Fix flaky login test") and how it ended (Delivered, Waiting to send · the computer is offline, Reply ready · tap to hear, or why it failed). Rows update as outcomes change. A tap speaks the row again. |
| Confirm Stop | `CPActionSheetTemplate` | Touch only; voice confirms by voice. |
| Notices | `CPAlertTemplate` | No computer paired; the microphone is off; an action that could not be done by touch. |

## What the driver can say

There is no wake word: the driver tapped Talk. A leading "Nekko," is allowed and ignored. Grammar and matching: `CarCommands.swift` (NekkoProtocol); behavior: `CarSession.swift` (NekkoKit).

| Say | Does | Confirm |
| --- | --- | --- |
| what's happening · status · what needs me · catch me up | Counts, then the chats that need you (and for what), then the ones working | none |
| read Billing · what did Billing say · read it | Speaks the chat's latest reply (the first 200 characters the chat list carries) | none |
| tell Billing to … · send to Billing saying … · ask Billing … | Sends the message to that chat through the outbox | read back, "yes" |
| allow · allow Billing · deny Billing | Answers the waiting approval. With exactly one approval waiting, no name is needed | read back, "yes" |
| stop the login chat · stop | Stops a running chat | read back, "yes" |
| start a chat to … | A new chat on the active computer with its default model | read back, "yes" |
| yes · no · cancel · the second one · say that again | Answers a read-back or a "Which one?" | |

- **Loose names.** "the login chat" finds "Fix flaky login test": the share of the spoken words found in the title, with prefixes and plurals folded ("auth" → "Authentication refactor", "retry" → "retries"). When two chats match about equally, Nekko reads them out ("Which one? first, Billing retries; second, Billing dashboard") and takes a number or a name.
- **Read-backs** expire after 30 seconds. Anything other than yes, no or repeat drops the read-back, and Nekko says so ("Nothing changed. …"). Cancel on the sheet drops it too: nothing is sent after Cancel.
- **Talk inside a chat** is a conversation bound to that chat. Anything that isn't a command is sent straight to it (the driver picked the chat on screen). Nekko waits up to 2 minutes for the answer, speaks it, and listens again. It stops after silence, a "no", or 8 turns. A slow answer is "still working", and the reply lands in Results.
- **Touch** on Allow, Deny or Stop is its own confirmation: no read-back, but the same rules.

## Rules that keep it safe

- **Allowing a tool needs an unlocked iPhone**, the app's existing rule for anything outside the app, checked both at the read-back and again at the yes. Deny and Stop work while it is locked. The car says this as a condition ("It will keep waiting for you"). Apple's guideline 2 forbids telling the driver to pick up the phone, so it never does.
- **High-risk approvals are never allowed from the car.**
- **A stale approval is not answered**: if the chat moved to another call between the read-back and the yes, nothing is sent.
- **Only the active computer** is acted on, because the outbox and approvals reach it alone. Other computers' chats are listed, read and spoken, and an action on one says which computer it is on.
- **No signed changes** (merging a PR, the step-up actions) are offered in the car: the change-signing key needs the phone unlocked, and none of these commands asks for one.
- **No text in answers.** Replies are spoken, never drawn. Results rows name the action and its outcome, never the message or the reply. Error lines are short, fixed sentences; a raw error that could carry words or a path is replaced with "Couldn't reach the computer".

## Speech and audio

- **Speech to text on the iPhone first**: Apple's on-device recognizer, when speech recognition is allowed and the language is installed on the device (`Dictation.carMode`). Otherwise it uses the computer's Whisper, as the composer does. Never a cloud speech service, and **Nekko Cloud is not involved**: a Nekko Cloud machine is just another computer in the list.
- **Text to speech** is the system voice (`ConversationSpeaker`).
- The audio session opens only while the voice sheet is up. Listening ducks the car's other audio, and it comes back between turns (Apple's Audio handling guidance).
- Off screen, iOS can't show permission prompts. If the microphone was never allowed, the car says it is off and does not wait for a prompt.

## Privacy on the car's screen

Chat titles and steps show on the car's display, which passengers can see. That is about what the Lock Screen card shows at Standard. The app lock doesn't hide CarPlay, because the driver can't unlock the app there. See open question 3.

## Release

1. **Release blocker:** request `com.apple.developer.carplay-voice-based-conversation` for `dev.nekkolabs.nekkoagent` (Apple Developer account, CarPlay entitlement request). Once granted, point `CODE_SIGN_ENTITLEMENTS` in `apps/ios/project.yml` at `App/NekkoNative-CarPlay.entitlements` and regenerate profiles. Until then the scene never connects, and the app ships unchanged on the phone.
2. **Release blocker:** run it in CarPlay Simulator (Xcode 27 Device Hub, iPhone over USB) and in a car:
   - launch on the car's screen only, with the iPhone locked
   - the radio playing during listen and speak
   - the car's microphone, on wired and wireless CarPlay
   - a phone call arriving mid-listen
   - Cancel in each state
   - the 26.4 action buttons
   - `UIApplicationSupportsMultipleScenes` left `false` beside the CarPlay scene

## Verification so far

- `apps/ios/scripts/linux-test.sh --filter Car`: `CarCommandsTests` (13) and `CarSessionTests` (33) pass. They cover the grammar, loose matching, read-backs (yes, no, expiry, replaced), ambiguity by number and by name, the unlocked and high-risk rules, stale approvals, other computers, queued sends turning into delivered and then reply ready, raw errors kept off screen, the voice loop's phases, a chat conversation, silence, Cancel during a read-back, the turn bound, and touch actions answering at once under the same rules.
- The CarPlay scene (`App/CarPlay/CarPlayScene.swift`), the AppModel wiring and `Dictation.carMode` had not been compiled by Xcode when this was written: Native iOS CI is the first build.

## Open questions

1. Should low-risk approvals be allowed from the car while the iPhone is locked? Today: no.
2. Should a reply to something sent from the car be spoken on its own when it arrives? Today: the Results row says "Reply ready", and nothing is spoken unasked.
3. Should CarPlay follow the Live Activity level (Minimal hides titles) for passengers' sake? Today: it shows titles.
4. Translations: the car's strings use the app's catalog with English fallbacks, and the command grammar is English only (as the card's is).
