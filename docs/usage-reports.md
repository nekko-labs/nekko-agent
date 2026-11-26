# Usage and crash reports

Nekko Agent can send anonymous reports of which features get used and what goes wrong, to help fix bugs and decide what to build. **It is off unless you turn it on.**

## Turning it on or off

- During setup, the **Help improve Nekko Agent?** step asks once. Skipping it leaves reports off.
- Any time: **Settings > General > Help improve Nekko Agent** (the first card).

Each time you turn it on, Nekko Agent makes a new random id, so reports from before and after are not linked.

## What we promise

- Off unless you turn it on. Turn it off any time in Settings.
- Anonymous: a random id, your app version, OS and hardware, and which features, models and modes you use. No name, email, IP location or account.
- Never your chats, prompts, files, folder names or model replies.
- Error reports are scrubbed of secrets, personal details and file paths.
- Never sold or shared. Used only to fix bugs and decide what to build.

## What a report contains

Every report carries the app version, edition, OS and CPU type. Its UTC timestamp is recorded when the event happens, not when the batch is later sent; it also carries the local hour and weekday for that same instant (not your time zone).

- **App started:** your hardware: CPU model and cores, RAM, GPU name and video memory (in whole gigabytes), whether memory is shared, and which compute backends work.
- **App opened and closed:** and how long it ran, in seconds.
- **A chat turn started:** the concrete provider and model route admitted for that turn, whether it ran locally, offline, in a sandbox or a worktree, the permission mode (Ask, Guardrails, YOLO or Plan), whether a person, automation or a subagent started it, how many other chats were running, which connector kinds are connected (such as `github`) and how many MCP servers you have. For non-incognito turns it includes an opaque chat pseudonym so distinct chats can be counted within this opt-in install identity. The pseudonym changes when the install id changes and cannot link the same synced chat across installs. The raw chat id is never sent. A local file name or path is never used as model attribution: the report omits the model and records a reason if the route is path-based, if the provider chooses its default later, or if the model is unavailable. Not the prompt, reply, chat title, folders, files or connector accounts.
- **Voice dictation used:** which speech engine.
- **A CI runner job ended:** how it ended and how long it took. Not the repository or workflow.
- **A screen opened:** its name, such as `models` or `settings`.
- **A control clicked:** the screen and the control's fixed name, such as `Add provider`. A control whose name includes something of yours (a file, chat or person's name) is never reported.
- **Send feedback opened:** which way you opened it: the left rail, the command palette, About, the Help menu, the tray menu, or a `nekko-agent://feedback` link. Never what you write, or your name or email.
- **An error:** where it happened, the kind of error and the first line of its message (at most 200 characters), and the names of the functions and files it passed through. Never the rest of the message, which could repeat something you typed. Secrets, emails, phone and card numbers, IP addresses, your user name and folder paths are removed first.

## Seeing what is sent

Every send shows in **Settings > Connections > Usage and crash reports**, with its time and size. **All connections off** stops reports along with everything else.
