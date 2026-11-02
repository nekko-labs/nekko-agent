# Usage and crash reports

Nekko Agent can send anonymous reports of which features get used and what goes wrong, to help fix bugs and decide what to build. **It is off unless you turn it on.**

## Turning it on or off

- During setup, the **Help improve Nekko Agent?** step asks once. Skipping it leaves reports off.
- Any time: **Settings > General > Help improve Nekko Agent** (the first card).

Each time you turn it on, Nekko Agent makes a new random id, so reports from before and after are not linked.

## What we promise

- Off unless you turn it on. Turn it off any time in Settings.
- Anonymous: a random id, the app version and your OS. No name, email, IP location or account.
- Never your chats, prompts, files, folder names or model replies.
- Error reports are scrubbed of secrets, personal details and file paths.
- Never sold or shared. Used only to fix bugs and decide what to build.

## What a report contains

- **App started:** the app version, edition, OS and CPU type.
- **A chat turn started:** the kind of provider (for example `ollama` or `openai`), whether it ran locally, offline or in a sandbox, and the chat mode. Not the model, the prompt or the reply.
- **A screen opened:** its name, such as `models` or `settings`.
- **An error:** where it happened, the message and the stack trace. Secrets, emails, phone and card numbers, IP addresses, your user name and folder paths are removed first.

## Seeing what is sent

Every send shows in **Settings > Connections > Usage and crash reports**, with its time and size. **All connections off** stops reports along with everything else.
