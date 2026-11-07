# Voice

Talk to Nekko Agent instead of typing. Tap the microphone in a chat's message box once and it stays on: what you say is typed into the chat, and anything that starts with "Nekko" is a command.

Speech is turned into text on your own computer. Nekko Agent never stores, hears, or trains on your voice, and your chats stay yours.

## Turn it on

1. Tap the microphone in any chat's message box.
2. The first time, a short video shows how it works. **Turn on** starts listening; **Not now** closes it without listening. Either way it won't show again; watch it any time from **Settings > Dictation > Watch how voice works**.
3. If no speech engine is set up yet, the microphone asks you to pick one (see [Dictation models](local-models.md#dictation-models)): **Apple speech** on macOS 26 and later, or **Whisper** (Nekko Voice) on Windows and Linux.

While it listens, the microphone is red and a strip above it shows the sound level and the last thing it heard.

## How listening works

- **One microphone for the whole app.** It keeps listening when you switch chats or click into another window.
- **Your words go to the chat you're looking at.** If no chat is focused, they go to the chat where you turned listening on. On a page with no chat (Settings, Models), it keeps listening: what you say is added to that chat's draft ("Added to Billing draft"), and commands like "Nekko, open settings" still work. Nothing is sent until you send it.
- **It works in pieces.** Each pause ends a piece (how long a pause counts is **End utterance after silence** in Settings > Dictation), and a piece never runs past 30 seconds. Pieces are turned into text one at a time and typed in the order you said them. Noise the engine marks as non-speech ("[BLANK_AUDIO]", "(keyboard clicking)") is never typed. If speech can't be turned into text, you'll see it once.
- **It stops** when you tap the microphone again (what you just said is still typed), when the computer locks or goes to sleep, or when you turn voice off in settings. It never turns itself back on.

## Commands

Start with "Nekko" at the beginning of a sentence: "Fix the login bug. Nekko, send it" types the first sentence and then sends it. A pause after "Nekko" is fine ("Nekko. Send it."), as long as the command follows within 5 seconds. "Nekko" in the middle of a sentence ("tell Nekko to check it") is just text, and a "Nekko, ..." that isn't a command is typed as you said it.

| Say | What happens |
|---|---|
| "Nekko, erase that" (or scratch / cancel / undo that) | Removes the last thing you dictated. |
| "Nekko, clear it" | Empties the message box. |
| "Nekko, send it" | Sends the message. |
| "Nekko, new chat" | Starts a new chat. |
| "Nekko, how's it going" | Shows what the chat is doing: working, waiting for you, or watching a PR. |
| "Nekko, open the one about billing" | Opens the chat that matches. If several match, pick one by tapping it or saying "Nekko, the first one". If none match, the words are typed. |
| "Nekko, ship it" | See below. |
| "Nekko, complete this session" | Completes the chat, after you confirm. |
| "Nekko, open settings", "Nekko, switch to desktop 2" | Opens a page, or switches desktops or screens. |

Each command shows a short message ("Erased", "Sent", "New chat") so you know it ran. If a message can't be sent (no model picked, for example), the reason shows and your words stay in the message box. Commands about a chat (erase, clear, send, ship, how's it going, complete) work on the chat you're looking at; with none open you'll see "Open a chat first".

**"Ship it"** depends on the chat:

- It has an open pull request: Nekko asks to merge it, naming the PR ("Merge owner/repo#123?"), and merges when you confirm. On the computer a stacked PR opens on GitHub instead; on iPhone draft PRs are left alone and nothing opens on GitHub.
- No PR, and the agent is done: sends "Go ahead and build it." If it's waiting on a question, that's the answer.
- An open PR **and** a question waiting: you choose **Merge owner/repo#123** (the PR's name) or **Go ahead**.
- Still working: "It's still working".

**Confirming.** Only merging and completing a chat ask first. Say "Nekko, yes" or tap **Confirm**; "Nekko, no" or **Cancel** to back out. A question waits one minute, then goes away, so a "yes" much later does nothing.

To use the microphone for dictation only, turn off **Enable "Nekko..." commands** in Settings > Dictation. This switch is on the computer only: the iPhone always listens for "Nekko" commands.

## On iPhone

The message box on iPhone has one microphone, and it starts a [hands-free conversation](#hands-free-conversation-on-iphone). To dictate words into a message without sending them, use the microphone on the iPhone keyboard. Watch how voice works any time from **Settings > Dictation > Watch how voice works**.

Without Whisper on your computer, speech is turned into text on the iPhone only, never on a server.

### From the status dashboard

**Implemented in the current worktree; not yet native-verified or shipped.** The Lock Screen/expanded Dynamic Island card shows Building, Need input and Done counts for the named computer. Done covers the last two hours, not all time. Watching/Failed and stale/partial detail appear when relevant. The card no longer sends plain speech to a focused chat. All enabled Live Activity levels use this dashboard; choose Minimal to avoid chat-text push payloads. Standard/Detailed still allow chat details through the relay and Apple’s push service even though the dashboard draws counts.

On iOS 18+, **Talk to Nekko** uses an authenticated recording intent: Face ID/passcode comes before capture. **Finish speaking** ends capture; **Cancel** discards current input. The background recording path still needs physical-iPhone verification. On iOS 17, **Open app for voice** opens the chat list without automatic listening. Secondary **Open app** leads to review, questions and approvals.

Dashboard commands are separate from the composer commands above, with **English grammar initially**:

| Say | Result |
| --- | --- |
| `status` | Reports the same computer’s counts, labeling offline/stale or partial information. |
| `send to NAME saying MESSAGE` | Stages a message to a uniquely named chat; nothing sent yet. |
| `confirm send to NAME saying MESSAGE` | Confirms the same exact name and message on the same computer within 60 seconds. |
| `cancel` | Clears pending confirmation; does not recall queued or dispatched work. |

Use the full chat name. Missing/ambiguous names, changed messages and expired confirmations are refused; open the app to review. This is not a free-form assistant and cannot approve tools, stop work or perform other actions. Queued is not sent; sent is not completed. Full captured transcripts are not copied into the Lock Screen payload.

On Android, the notification’s **Talk to Nekko** opens a foreground voice sheet behind the app lock. Unlock, then tap **Listen** explicitly. Backgrounding cancels capture; there is no background microphone. It uses the same grammar and reports a confirmed command as queued, not confirmed delivered/completed. Android phone recognition may use its provider’s network service, unlike iOS’s on-device-only phone fallback. Native tests/evidence and physical microphone/authentication checks for this redesign remain pending on both platforms.

### Hands-free conversation on iPhone

The microphone in the message box is **Voice conversation**. It is available in New chat, a connected computer chat, and a chat running on this iPhone.

1. Open **Voice conversation**, then tap **Start voice conversation**. Opening the controls alone does not start the microphone.
2. Speak a turn. After a pause, the recognized words are sent automatically to that chat's selected model.
3. Nekko speaks the reply on the iPhone, then listens again. The microphone is off while it thinks or speaks, so it cannot transcribe its own reply.
4. Tap **End voice conversation** or **Done** to stop listening and playback. Leaving the screen, locking/backgrounding the phone, an audio interruption, or switching computers also stops voice. It never restarts without Start.

An agent task already sent may continue after voice ends. If the agent needs approval or an answer, voice stops and asks you to answer in the chat—voice never approves a tool for you. For a computer chat, the original computer must remain connected. Phone-only chat recognition stays on the iPhone; connected chats use the existing configured on-device/computer speech path. Playback is iOS speech on this phone, without a new cloud speech service. The recognized text still goes to your selected model.

To add speech to a draft without sending it, use the iPhone keyboard's own dictation.

**Verification note:** simulator state/lifecycle checks do not prove physical microphone, speech quality or Bluetooth routing. These require an on-device check before claiming hardware support for the new hands-free flow.

## Privacy

Speech is turned into text on this computer, by Apple's on-device recognizer or by Whisper running locally. Audio is never sent anywhere and is not kept once it has been turned into text.
