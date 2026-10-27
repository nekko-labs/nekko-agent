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

Tap the microphone in a chat's message box and it keeps listening through pauses until you tap stop, lock the phone, or leave the chat. The screen stays on while it listens. If listening stops on its own (a call, unplugging headphones, locking), you'll see "Stopped listening". With two chats side by side, only one listens at a time. AirPods work as the microphone, at call quality while listening. A command with nothing to do says so ("Nothing to send", "Nothing to erase", "Nothing to confirm"). With **Hold to talk**, answer a "Nekko, yes" question in your next hold. The first time you tap it (or the first time you hold it, with **Hold to talk**), a short video shows how voice works instead of listening. **Turn on** starts listening; **Not now** closes it without listening. Either way, or if you swipe it away, it won't show again. Watch it any time from **Settings > Dictation > Watch how voice works**. The video has captions, and VoiceOver reads a summary of it; with Reduce Motion on, it waits for the play button.

Without Whisper on your computer, speech is turned into text on the iPhone only, never on a server.

## Privacy

Speech is turned into text on this computer, by Apple's on-device recognizer or by Whisper running locally. Audio is never sent anywhere and is not kept once it has been turned into text.
