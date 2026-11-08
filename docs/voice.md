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

### From the Lock Screen

With **Settings > While a chat runs > Live Activities** set to **Detailed**, the card on the Lock Screen and in the Dynamic Island has a microphone on the chip of the chat it shows. Tap it and the iPhone asks for Face ID (or your passcode) first. Then say one message: the card shows "Listening…" and stops at your first pause (or after 30 seconds without one). What you said goes to the chat the card shows, as if you had typed it there; while the chat is working it waits in that chat's queue. The card then shows "Sent: " and your words until the chat's reply line takes their place. If your computer doesn't answer within 10 seconds (it's offline, say), the card still says "Sent": the message waits on the iPhone and goes when the computer is back. If your computer turns it down, the card says "Not sent" and why, and your words wait in that chat's message box. **Send to** on the card sends what you have said so far without waiting for the pause, and **Cancel** sends nothing. Speech is turned into text the same way as in a chat: Whisper on your computer, or on the iPhone only, never on a server. If it couldn't be turned into text, the card says "Not sent" and why, for about a minute. On iOS 17 the microphone opens the chat with listening already on instead, once you have unlocked the app (with **Hold to talk**, it just opens the chat).

### Hands-free conversation on iPhone

The microphone in the message box is **Voice conversation**. It is available in New chat, a connected computer chat, and a chat running on this iPhone.

1. Open **Voice conversation**, then tap **Start voice conversation**. Opening the controls alone does not start the microphone.
2. Speak a turn. After a pause, the recognized words are sent automatically to that chat's selected model.
3. Nekko speaks the reply on the iPhone, then listens again. The microphone is off while it thinks or speaks, so it cannot transcribe its own reply.
4. Tap **End voice conversation** or **Done** to stop listening and playback. Leaving the screen, locking/backgrounding the phone, an audio interruption, or switching computers also stops voice. It never restarts without Start.

An agent task already sent may continue after voice ends. If the agent needs approval or an answer, voice stops and asks you to answer in the chat—voice never approves a tool for you. For a computer chat, the original computer must remain connected. Phone-only chat recognition stays on the iPhone; connected chats use the existing configured on-device/computer speech path. Playback is iOS speech on this phone, without a new cloud speech service. The recognized text still goes to your selected model.

To add speech to a draft without sending it, use the iPhone keyboard's own dictation.

**Verification note:** simulator state/lifecycle checks do not prove physical microphone, speech quality or Bluetooth routing. These require an on-device check before claiming hardware support for the new hands-free flow.

## Cancellation and startup safety

Desktop/Local Web UI capture and command handling invalidate pending work when aborted; normal toggle-off still applies the final utterance. A microphone test that finishes opening after its Settings view closes is aborted, and partial audio setup failures release the microphone. The desktop lock bridge also invalidates queued transcripts, so a delayed “Nekko, send it” cannot execute after lock. Browsers do not have that native OS-lock callback.

Android dictation reserves one startup job, ignores stale callbacks/results, and cancels on app lock or background independently of screen disposal. Both phone clients allow 300 seconds for host cold startup, inference and relay overhead. iOS no longer blindly retries a failed or timed-out host transcription and propagates cancellation without fallback. Native build and hardware verification remain pending; these fixes do **not** add Android hands-free conversations. See [the readiness audit](../reports/voice-image-readiness.md).

## Privacy

Speech is turned into text on this computer, by Apple's on-device recognizer or by Whisper running locally. Audio is never sent anywhere and is not kept once it has been turned into text.
