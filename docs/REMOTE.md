# Phone remote control

Drive the Nekko Agent running on your computer from your phone: start and manage chats, watch and steer
training runs and goals, approve risky commands, and get a push when a long run finishes. Inference
and tools always execute on **your** machine, under its guardrails; the phone is a thin client.

## How it works

```
[ Phone ]  --TLS-->  [ relay ]  <--outbound WSS--  [ your computer (agent) ]
```

- Your computer **dials out** to a relay and claims a room. No inbound ports, no port-forwarding.
- Your phone connects to the same relay with the pairing credentials.
- Every payload is **end-to-end encrypted** (AES-GCM, key derived from the pairing secret). The
  relay routes ciphertext; it cannot read prompts, replies, files, or model output.
- On top of the encrypted transport, every device must pass a **handshake against your computer's
  device registry**: new devices enroll only through a **single-use pairing code that expires in
  10 minutes**, and your computer answers each device individually (never broadcast).

## Pairing a phone

1. On your computer: **Settings → Phone pairing** (second in the left-hand list), then in **Remote access**
   pick how your phone connects: **Use Tailscale** (free, needs the Tailscale app on both) or
   **Use Nekko Cloud** (works anywhere, nothing to install). A self-hosted relay goes under **Use your
   own relay**. Then **Pair a device**. The QR appears right under the button.
2. On your phone: scan the QR in the Nekko Agent app (**Computers → Pair a computer**), or with the
   phone's camera app, which hands the `nekko-agent-pair:` link to the Nekko Agent app. Without the
   app, the pairing link also opens the web app in a browser over the relay, but it is limited to
   what a phone may do (below), so most desktop screens there are unavailable.
3. The phone shows up under **Paired devices**, with a live connection dot.

## The phone app

> **Native apps.** The phone apps are moving to platform-native code: Kotlin / Jetpack Compose in
> `apps/android` (pairing, chats, live replies, approvals and questions; no phone models yet) and
> SwiftUI in `apps/ios`. The Expo app described below stays as the reference until they reach parity.
>
> The Android app looks like your desktop by default: **Settings → Appearance → Same as computer**
> uses the computer's light or dark theme and its accent color, and follows a change on the
> computer right away. Pick **Phone setting**, **Light** or **Dark** to choose on the phone instead;
> that choice is kept on the phone. Only the theme, theme preset and the two accent colors are sent
> for this (the `appearance:updated` event), never the rest of the computer's settings.
>
> The Android app's **Settings** also has a **Computers** row, which opens the list of paired
> computers (rename, switch, forget, pair another), and an **About** section with the installed
> version and the open-source licenses of the app and the libraries it ships.
>
> **New chat defaults** (Android): **Settings → New chats** picks the computer the app connects to
> when it starts (default: the one used last) and, for each computer, the model New chat opens with
> (default: the computer's own default model). They are saved on the phone; the computer's settings
> don't change. If that model is no longer offered, New chat says so and uses the computer's default.
> **Share to Nekko** (Android): in any app's share menu, pick **Nekko Agent** to start a new chat
> with the shared text or link. You can edit it on the New chat screen; after you start the chat it
> waits in the message box and you send it yourself. Nekko never sends shared text on its own, and
> it is kept only in memory until then. Text and links only for now, up to 20,000 characters.
> **Vibration** (Android): while the app is open, the phone vibrates when the agent needs your
> approval (two pulses) or asks you a question (one long pulse). In **Settings → Vibration** you can
> also turn on a short tap when a reply finishes and three taps when it fails, or switch any of them
> off. It never vibrates in silent mode or Do Not Disturb, or while the app is in the background.
>
> **Your computer's settings from the phone** (Android): **Settings → On <computer>** changes three
> of the computer's own settings: the chat mode for new chats (Ask, Guardrails or YOLO; YOLO asks once
> before switching), what a long-press on a chat does (Complete, which moves it to Completed, or
> Delete), and whether deleting asks first. They are saved on the computer, the same settings as in
> its Settings. A long-press on a chat in the list then completes or deletes it on the computer.
>
> **Write offline** (iPhone): with no connection to your computer you can still write. What you
> type in a chat's message box, and in New chat, is kept on the phone, so leaving the screen or
> the phone closing the app loses nothing. **Send when online** puts a prompt in a queue on the
> phone, shown in the chat as **Waiting to send** (Edit, Delete, Send now); a new chat started
> offline waits under **Waiting to send** in the list. When the computer is back they go in order,
> and each prompt runs once even if the connection dropped mid-send: the computer recognises a
> prompt it already has by its id. If the computer refuses one (the chat was deleted, say), it comes
> back to the message box with the reason. Approvals and answers to questions are never queued;
> they need the computer to be reachable. The widget and the Watch show how many prompts are waiting.
> The drafts and the queue are encrypted on the phone until it is first unlocked, aren't backed up,
> and are deleted when you forget the computer. Sending prompts written offline needs this version
> of Nekko Agent on the computer.
>
> **Read offline** (iPhone; the chat list on Android too): the phone keeps each computer's chat list
> and, on iPhone, the last 20 chats you opened (up to 5 MB per computer; a very long chat keeps its
> newest messages). Opening the app or a chat shows them at once, and while the computer can't be
> reached they stay readable under **Saved list from 10:42** and **Saved copy from 10:42**. When the
> computer answers, the live list and chat replace them in place. A saved chat can't be changed
> (model, tool policy, rename, complete) until the computer is back, but what you send waits as
> above. Photos are never kept, only how many a message had. Both are on unless you turn them off
> in **Settings → Offline** (Android: **Settings → Connection**); turning a switch off deletes what
> it kept. Like the drafts, the copies are encrypted until the phone is first unlocked, aren't
> backed up, and are deleted when you forget the computer or a chat is deleted on it.
>
> **Beyond the chat** (iPhone): the phone is a remote for the agent, not a second desktop.
> - **Edit the queue:** a follow-up sent while a reply runs waits under **Queued** with Edit and
>   Remove. An edit only lands if that prompt hasn't started yet; otherwise nothing changes.
> - **Fork:** touch and hold a message. On your prompt, **Edit in a new chat** starts a new chat with
>   the conversation before it and the prompt in the message box; on a reply, **Fork from here**.
> - **Photos:** tap a photo in a message to see it full screen; **+ → Paste image** adds one from the clipboard.
> - **Saved prompts:** the prompts you saved on the computer show in `/` and under **+**, run like skills.
> - **`/` after what you've typed:** typing `/` after some words (after a space or on a new line)
>   opens the same menu. Picking a skill keeps your words and adds the skill; picking a saved prompt
>   puts its text in place of the `/`.
> - **Continue and search:** the list opens with your most recent chat; search finds completed chats too.
> - **Automations:** **Computers and settings → Automations** lists the computer's tasks and
>   workflows with how each last went, and **Run now**. You set them up on the computer.
> - **Pull requests:** a chip shows the chat's pull request and its checks. **Commit these changes**,
>   **Open a PR** and **Fix the failing checks** send a prompt to the chat, so the agent does the git
>   work on your computer and asks you before anything that needs approval. Or do it yourself from
>   the phone (below).
> - **Git:** **More → Git** in a chat (or the pull request chip → **Git: status, commit, push**)
>   shows the chat folder's branch, how far it is ahead or behind, and its changed files, staged and
>   not, each with its diff. Swipe a file to stage or unstage it, or use **Stage all**. Type a commit
>   message or tap **Write message** to have your computer's model write one for what is staged (it
>   uses that model's tokens), then **Commit** and **Push** (a new branch is published to its remote
>   the first time). **History** lists commits with each one's message and files; **Branches**
>   switches branch or makes a new one; **Compare** shows what one branch has that another doesn't;
>   **Open a pull request** takes a title, a description, a base branch and Draft. A pull request's
>   **Checks, files and actions** lists its checks with links, its changed files, and **Approve**,
>   **Merge**, **Close** or **Reopen**. **Abort merge** shows while a merge stopped on a conflict.
>   Every one of these changes asks for Face ID or your passcode (once per 5 minutes) and shows in
>   the phone's *Activity* on the computer.
> - **Files:** **More → Files** in a chat opens that chat's folder (its worktree when the chat is
>   isolated); **Computers and settings → Files** lists the computer's saved folders. Tap through
>   folders, or search by file name. A file opens in monospace with line numbers (Markdown can be
>   shown formatted, images as pictures); a long file shows its first 256 KB with a note. **Edit**
>   a text file up to 256 KB and **Save**: Face ID or your passcode is asked (once per 5 minutes)
>   and the save shows in the phone's *Activity*. If the file changed on the computer after you
>   opened it, the phone says *Changed on the computer* and you choose **Reload** (your edits are
>   dropped) or **Save over it**; nothing is overwritten without that choice. Files that may hold
>   secrets are counted under the list, never shown.
> - **Logs:** **Computers and settings → Logs** lists the desktop app's log, the engine's log and
>   each chat's agent run log. A log opens at its newest lines; **Refresh** reads it again, and the
>   search field shows the matching lines with their line numbers. Read only, with secrets already
>   replaced by `[redacted]` on the computer.
> - **Usage and limits:** what each provider plan has used and when it resets, and recent usage. Read only.
>
> **All your chats, grouped like the desktop** (Android): the chat list shows every chat on the
> computer, completed ones included, in the same groups as the desktop's agent sidebar: **General**
> first, then one group per project folder. Tap a group's name to fold it. Each group lists its
> active chats, then **Show completed (N)**, which opens the chats completed there (struck through,
> newest first). Tap a completed chat to read it; its message box is replaced by **Restore**, and a
> long-press on it offers Restore or Delete. Completing or restoring a chat on the computer shows up
> on the phone the next time the list refreshes: when a reply finishes, when you pull down, or when
> you come back to the app.
>
> **Photos and dictation** (Android): the **+** on the left of a chat's message box opens **Dictate**,
> **Image from files** (the phone's photo picker; Nekko only sees the photos you pick) and **Take
> photo** (the phone's camera app). Up to 4 photos go with the next message, shown as thumbnails you
> can remove; they are scaled to 1600 px and sent end-to-end encrypted to the computer, which hands
> them to the chat's model like a photo pasted on the desktop. A text-only model doesn't see them.
> The photos stay in the message's bubble on the phone too, as small previews the computer makes
> (the newest 40 photos in a chat, including ones attached on the computer); an older photo shows as
> a plain tile, and the full-size original stays on the computer.
>
> **Dictation** (Android): tap **+ → Dictate**, speak, and tap ■ (or stop
> at 30 seconds). The words go into the message box for you to check and send; nothing is sent by
> itself. By default the speech is turned into text by **Nekko Voice on your computer** (Whisper,
> end-to-end encrypted, the audio never reaches anyone else); install and switch it on there under
> **Settings → Nekko Voice**. When the computer can't, the phone's own speech recognizer is used,
> which on many phones sends the audio to Google. **Settings → Dictation** on the phone lets you use
> only the computer, only the phone, or turn the microphone off.
>
> **Skills** (Android): type `/` in a chat's message box, at the start or after a space at the end
> of what you've written, to see the skills on your computer: the built-in ones, those you
> installed from the Marketplace for Nekko Agent, and the ones Nekko Agent found in your Claude
> Code, Codex or Gemini skill folders. Pick one, add details if you like, and send. Text you typed
> before the `/` stays in the box and goes along as the skill's details. Nothing is copied to the phone: the list is read from the computer each
> time you open a chat, so a skill you install or remove there shows up on the phone right away,
> and the computer adds the skill's instructions itself, so they never leave it. `/goal` is not
> offered on the phone, and skills are installed and removed on the computer.
>
> **Long chats on the phone**: the phone gets the newest 300 messages of a chat, without the
> screenshots inside tool results and with long tool output shortened to 4,000 characters, so even
> a very long agent run opens in seconds. The chat says how many earlier messages, characters and
> images stayed on the computer; open it there for the full detail.
>
> The Android app is **locked by default**: every time you open it, or come back to it, it asks for
> your fingerprint, face or the phone's screen lock (PIN, pattern or password) before it shows
> anything. While it is locked nothing can be read or approved, and the recent-apps preview shows a
> plain cover instead of your chats. After a restart it doesn't connect to your computer until you unlock. Turn it off in
> **Settings → Security → App lock**; turning it off asks for the same check first. Screenshots and screen
> recording of the app work as usual, lock on or off; on Android 14 and later the screenshot toolbar
> some phones show afterwards (Samsung) no longer hides the app behind the cover. A phone with no screen lock can't be locked;
> Settings says so and links to the phone's security settings.
>
> The Android app **reconnects by itself** as soon as the phone changes network (Wi-Fi to mobile data,
> airplane mode off), instead of waiting out its retry delay. While a chat on your computer is running,
> **Settings → Connection → Stay connected while a chat runs** (on by default) keeps the app connected
> after you leave it, with a silent "Staying connected · 1 chat running on Mac" notification that goes
> away as soon as the reply is done. **Notify me** (on by default; Android 13+ asks for permission)
> sends a notification when a reply finishes or fails, or a chat waits for your approval or answer,
> while you're out of the app. Notifications say what happened and in which chat, never the reply, the
> command or the question; with the app lock on they don't name the chat either, and tapping one opens
> the chat through the lock. Without push (not built yet), these only arrive while the phone is still
> connected. If Android restricts Nekko in the background, Settings says so and opens the app's
> system page.

The iOS and Android app (`apps/mobile`) is built for the phone rather than being the desktop on a
small screen: your computer's chats with **Working** / **Needs you** badges, new chats on any of the
computer's models and folders, live replies, **Allow this?** cards for risky commands, the agent's
questions as tap-to-answer choices, follow-ups that queue while a run is going, and Stop. It can
pair several computers and talks to one at a time.

It also runs **models on the phone itself** (llama.cpp, curated small GGUF models from Hugging Face
sized to the phone's memory), so you can keep chatting when the computer is off. Those chats never
leave the phone and don't use the relay.

**The native iPhone app** (`apps/ios`, SwiftUI) does the same over the same encrypted relay, and
adds what only iOS can: a **Live Activity** for each running chat on the Lock Screen and in the
Dynamic Island, with **Allow / Deny** for a waiting tool and **Stop**; notifications with Allow /
Deny actions while the app is in the background (Allow asks you to unlock first); photo attachments;
and dictation (Whisper on your computer when Nekko Voice is installed, else the iPhone's own
speech recognition). Its pairing screen leads with Tailscale and shows whether Tailscale is on on
the iPhone. If a Tailscale relay can't be reached, the app says which side is the problem:
Tailscale is off on the phone, or the computer isn't answering. With the app lock on (Face ID or
passcode, on by default), the Lock Screen and notifications never show chat titles or commands.

On the phone, the pairing key and the derived encryption key live in the iOS Keychain / Android
Keystore. The app drops any provider API keys your computer sends with its settings and never
stores them.

Manage devices from the same card: **rename** them, **revoke** one instantly (it's kicked live and
denied from then on), or **Rotate secret** to cryptographically reset the room, which unpairs
everything at once. A revoked phone can come back only the way a new one does: choose **Pair a
device** on the computer and scan the new QR from the phone (the one-time code is the proof). Older
computers refused a revoked phone even then; on those, **Rotate secret** first.

Remote access survives restarts: if it was enabled, the agent reconnects when Nekko Agent starts.

## What a paired phone can do

Your computer decides what a paired phone may ask for, whatever the phone app does: locking the
phone app is not the boundary, your computer is. A phone can use your chats and nothing that
changes how the computer itself is set up:

- **Allowed:** list, open, start, fork, complete and delete chats; send, queue, edit or remove
  queued, and stop messages; answer approvals and the agent's questions; pick a model from the
  computer's providers and a folder from its list; voice status and transcription; read a chat's
  pull requests, the computer's automations, its usage and plan limits, and run an automation now;
  git in a chat's folder and its terminals and SSH (below); a chat's or saved folder's files and the computer's logs (below);
  and a few settings (below).
- **Never allowed from a phone:** wiping data or resetting settings, remote access itself (pairing,
  revoking, rotating the secret), terminals not opened for a chat, files by a path on the computer or outside a chat's or
  saved folder, creating files, accepting or reverting changes,
  git outside a chat's own folder, restacking or linking stacked pull requests, making, changing or
  deleting automations, adding or removing folders, installing
  or removing voice models, connecting or disconnecting connectors, provider keys and sign-ins, MCP
  servers and hooks. Everything not on the allowed list is refused too, with an error that starts
  *Not allowed from a paired phone*.
- **Settings a phone may change:** the chat mode for new chats (Ask, Guardrails or YOLO), what the chat pane's top-right button does (Complete or Delete),
  whether deleting asks first, and voice on/off and its language. An update that touches any other
  setting is refused as a whole: nothing in it is applied.
- **Settings a phone can read:** only the theme and accents, the default and starred models, your
  saved prompts (name and text), whether automations are paused, and the settings above. API keys, tokens, provider details, folders, hooks, guardrails and your
  instructions never leave the computer this way; provider lists arrive as name and type only.
- **A chat's changes, read only, only if you allow it:** with *Let phones see changes* on (off
  unless you turn it on, in Remote access on the computer), a phone can see a diff of the files the
  agent changed in a chat. Your computer works out the diff and sends only that: short paths, a
  capped number of lines, and files that may hold secrets (`.env`, keys, `.ssh`, `.aws`) counted but
  never shown. A phone still can't accept or revert changes or read any other file.
- **Git in a chat's folder:** a phone names a chat, never a folder, and your computer runs git in
  that chat's checkout (its worktree when the chat is isolated); a folder's own id from a phone is
  refused. Reading (status, diffs, history, branches, compare, a pull request's checks and files)
  needs *Read*; staging, committing, a model-written message, pushing, switching branch, aborting a
  merge, opening a pull request and approving, merging, closing or reopening one need *Change* and a
  fresh signature. What reaches the phone is smaller than the desktop's view: at most 100 files,
  300 lines of each file's diff and 256 KB of diff per answer. Files that may hold secrets (`.env`,
  keys, `.ssh`, `.aws`) are listed, so a commit never carries one unseen, but their diff is never
  sent. Commits show the author's name, not their email; no path on the computer is sent. A
  pull request is named by its GitHub address only. Pushes never force, and commits never skip
  hooks or amend.
- **Files in a chat's or saved folder:** a phone names a chat or a saved folder, never a path on
  your computer. Paths are relative to that folder, and anything that leaves it (`..`, absolute
  paths, a link pointing outside) is refused. Listing, searching by name and opening a file need
  *Read*; saving needs *Change* and a fresh signature. A phone only saves over the version it
  opened (your computer checks the file's hash) and never creates a file. What reaches the phone is
  smaller than the desktop's view: at most 500 entries per folder, 100 search results, 256 KB of a
  file's text and images up to 2 MB; a save is at most 256 KB. Files that may hold secrets
  (`.env`, keys, `.ssh`, `.aws`, git credentials and `.git/config`) are refused before your computer
  even looks, and left out of listings and search results (counted, never named).
- **Logs, read only:** the desktop app's log, the engine's log and each chat's agent run log, with
  *Read*. A phone gets at most the last 256 KB of a log, or up to 500 matching lines of a search
  (each cut at 2,000 characters). API keys, tokens, passwords and other secret-looking values are
  replaced with `[redacted]` before a line leaves the computer, and a search only matches the
  redacted text.
- **Terminals and SSH in a chat:** a phone sees only terminals opened for a chat and the agent's
  command log (read only), never your other terminals, and only one chat's list at a time. Reading
  a terminal's last 64 KB and the SSH hosts needs *Read*; opening a terminal, starting a new one (in
  the chat's folder, with your default shell; a phone can't pick a folder or a shell), opening an SSH
  session, Ctrl-C and closing need *Change* and a fresh signature. Opening hands the phone a token
  for typing into that terminal only, so it doesn't ask for Face ID on every key: it ends when the
  phone leaves or disconnects, after 5 minutes without typing and after 30 minutes in any case, and
  your computer checks the phone's *Change* switch on every keystroke. Output goes only to the
  phones that opened that terminal, at most 32 KB every tenth of a second (a flood is cut short and
  the phone reads the end again). The desktop shows *Phone attached* on a terminal while a phone has
  it open. SSH hosts arrive as alias, host name and port (no user name); SSH runs on your computer
  with its own keys and config, and nothing about the keys reaches the phone. Running a command
  without typing it, renaming terminals and listing shells stay off.
- **One chat's options:** a phone can change a chat's model, title, pin and tags, complete it, and
  switch it between Ask, Guardrails and YOLO, but not its tools, isolation or
  offline/incognito switches. Messages cannot attach files from the computer. Moving a chat (or the
  default for new chats) to a mode with fewer approvals, Ask to Guardrails or anything to YOLO, is
  confirmed on the phone like any other change: Face ID or the passcode on the iPhone. Android can't
  confirm changes yet, so there you change the mode on the computer.

### What phones can do: Read and Change, per phone

Git, files, logs, terminals and SSH are on the iPhone now (above); task boards are coming.
*Remote access → What phones can do* on the computer lists each paired phone with two switches:

- **Read:** see your chats and their messages, settings, models, automations, usage and limits, and
  look at files, git status and history, logs and boards.
- **Change:** send and queue prompts, stop a run, approve tools, answer questions, start, fork,
  delete and change chats, change the phone-settable settings, run an automation, transcribe a voice
  prompt; edit and save files, commit and push, branch and pull request actions, type in a
  terminal, edit boards, SSH.

Both are on for every phone, including phones paired before the switches existed. Turn one off and
your computer refuses those requests from that phone, whatever the phone app does: with Change off a
phone can watch but can't make the agent do anything, and with Read off it sees nothing. Every
request a phone can make is in one of the two; anything else is refused.

**File, git, terminal and SSH changes, and moving a chat to Guardrails or YOLO, are confirmed on
the phone and checked by your computer.** (Sending a prompt or approving a tool needs only the Change
switch, so it doesn't ask for Face ID each time.) The first time a phone
makes a change, it creates a key in its Secure Enclave (on iPhone) that only Face ID, Touch ID or
the passcode can use, and gives your computer the public half. Each change after that is signed
with the key, and your computer checks the signature before doing anything: a change with no
signature, a wrong one, one more than 5 minutes old, or one it has already seen is refused. One
Face ID covers 5 minutes, as for *Allow* from the Lock Screen.

Your computer trusts the first key a phone gives it. A phone that later shows up with a different
key is refused until you remove it and pair it again. *Forget all computers* on the iPhone deletes
its key too.

**Activity.** *Activity* under each phone lists every change it made or tried, prompts and approvals
included, newest first, with why one was refused (Change off, no fresh Face ID or passcode, a changed
key). Your computer keeps the newest 200 per phone; rotating the secret clears them.

**Older phone apps.** Phone apps from before relay replay protection (below) still connect for one
release. Your computer writes it to its log, shows *Older app: update it on the phone* next to that
phone and adds one *Connected with an older app* line to its activity. To refuse them now, set
`"acceptLegacyPhones": false` in `remote.json` in the data folder; such a phone is then told to
update its app.

**Revoke** a phone to stop all of it at once. Whatever the switches say, a phone can never reach
provider keys or other credentials, remote access itself (pairing more devices, revoking,
rotating), wiping data or resetting settings, or the computer's own sign-in windows, dialogs,
updater and shell.

### Where the logs live

The logs a phone reads are files you can open yourself: `logs/app.log` and `logs/nekkod.log` in the data folder
(`~/.nekko-agent` unless you moved it). Each is rotated at 5 MB, and the last three old copies are kept
(`app.log.1` to `app.log.3`). Windows' engine log holds only start-up lines and crashes for now.

## Security model, honestly stated

| Threat | Defense |
|---|---|
| Relay operator reads your traffic | Impossible by construction: E2E encryption, relay sees ciphertext only |
| Stranger connects to your room | Needs the pairing secret (128-bit) for transport auth, then a registered device or a live pairing code |
| Leaked/stale pairing link | The one-time code is single-use and expires in 10 min; the link is scrubbed from the phone's URL/history after pairing |
| Lost/stolen phone | The Android app asks for the phone's fingerprint, face or screen lock every time it opens. Revoke the phone in Settings: kicked immediately, denied afterward, push token dropped |
| Revoked device replays old creds | The agent refuses its handshake and unicasts nothing to it; it gets back in only with a fresh one-time pairing code from the computer's owner; rotate the secret for a full cryptographic reset |
| Malicious relay withholding/reordering | Availability only; it still can't read or forge frames (AES-GCM auth) |
| Phone asks for something dangerous | Your computer only serves the phone allowlist above (no wipe, settings reset, remote-access changes, terminals outside a chat, file writes); tool calls run on your machine under your guardrails/sandbox and chat mode |
| Someone records the relay's traffic and plays it back | Every connection starts with a fresh random challenge from your computer that the phone's sealed hello must answer, once; every request after it carries that challenge and a number that only goes up. A replayed hello or request is dropped and never runs. (Phone apps from before this are accepted for one release, see *Older phone apps*.) |
| Someone else picks up the phone, or the relay replays a request, to make a change | Each change must be signed by the phone's Secure Enclave key, which needs Face ID or the passcode (one check lasts 5 minutes); your computer checks the signature, its age and that it was not used before, and logs every attempt in the phone's activity |

What the relay does see: connection metadata (IPs, timing, frame sizes), the room code, and, if you
enable push, device push tokens plus the content-free fact "a run finished". That's the whole list,
and it's why relayed local-model use is inherently zero-data-retention for content.

## Choosing a relay

How the Android and iOS apps each handle the connection (URL rules, pairing, reconnects, push, background) is compared in [phone-connection.md](phone-connection.md).

### Nekko Cloud (the managed relay): `wss://nekko-agent-relay.fly.dev`

The app calls this **Nekko Cloud** and never shows the URL. Zero setup; free during beta with per-connection rate limits. When Nekko Cloud launches, the
managed relay becomes part of the paid plans (it already supports gating via
`NEKKO_RELAY_AUTHZ_URL`), while self-hosting stays free forever.

### Private relay over Tailscale (free, no account, nothing hosted)

If your phone and computer are both on a [Tailscale](https://tailscale.com) network, you do not
need a hosted relay at all: run the relay **on the computer** and bind it to the computer's
Tailscale address. Only devices on your tailnet can reach it, Tailscale encrypts the hop
(WireGuard), and the app's end-to-end layer still sits on top. This is how free remote-desktop
tools such as Moonlight stay free: nothing runs in the cloud, the two ends find each other over a
network you already own.

**In the desktop app:** Settings → Remote access → **Use Tailscale**. The app finds this computer's Tailscale address (any interface in `100.64.0.0/10`), starts the
bundled relay bound to that address only, and turns remote access on through it. Phones dial the MagicDNS name
(for example `ws://gomi.tailfd6474.ts.net:4400`) when the Tailscale CLI reports one, else the
`100.x.y.z` address. Then **Pair a device** and scan the QR from the phone with Tailscale switched
on. Without Tailscale on this computer the option links to Tailscale and stays off.

- **It stays on:** once started it comes back with the app.
- **It waits for Tailscale:** with Tailscale off it binds nowhere and waits, and starts when
  Tailscale connects.
- **It follows address changes:** it moves when the tailnet address changes.
- **It says why it isn't running:** for example Tailscale off, or the port (4400) already in use.
- **It is on your Wi-Fi too:** next to the tailnet address it listens on this computer's private
  LAN addresses (192.168.x.x, 10.x.x.x, 172.16.x.x to 172.31.x.x; never the internet, and not the
  virtual adapters of WSL, Hyper-V, Docker or VMs). Pairing
  codes then carry both routes, and the iPhone app uses the LAN when it is on the same Wi-Fi and
  moves to Tailscale by itself when it leaves, coming back once the LAN answers steadily again.
  Switch **Also on this Wi-Fi** off to keep the relay on the tailnet only; pair the phone again
  after changing it. Phones paired before this keep the one route until they scan a new code.

On the iPhone, **Settings → Connection** shows the route in use. **Check routes** looks up,
connects to and says hello on each route with timings, and **Share diagnostics** shares those
results and the connection log as text, without rooms, keys, codes or messages.

It runs as its own process (`out/main/relay.js`, under the app's own runtime) and exits with the
app. It has no push keys, so phones get no "finished" notifications through it; the in-app
connection and Live Activities while the app is open work as usual.

**Headless or without the desktop app**, the scripts do the same by hand:

```bash
npm run relay:tailscale        # Windows (PowerShell); or scripts/private-relay.sh on macOS/Linux
```

The script prints the URL to paste into **Settings → Remote access → Use your own relay**. Either way the relay only
listens on the Tailscale interface, so agent enrollment without an access token
(`NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1` in the script) is safe here; never use that flag on a public
bind.

The computer refuses a plain `ws://` relay on the open internet, whether you press Connect or start
a headless agent with `NEKKO_RELAY_URL`. It uses the same rule as the phones, below.

Plain `ws://` is fine on a tailnet: the transport is already encrypted end to end by WireGuard, and
the app's own end-to-end encryption sits on top. The Expo iOS app ships with Expo's default App
Transport Security (arbitrary loads allowed). **The native iPhone app allows plain `ws://` only toward
private networks**: Tailscale (`*.ts.net` names and `100.x.y.z` addresses) and your local network.
It refuses a `ws://` link to anything on the open internet before dialing; use `wss://` there. **The Android app allows plain `ws://` only to Tailscale
MagicDNS names (`*.ts.net`)**, so use the name the script prints (`ws://gomi.tailfd6474.ts.net:4400`),
not the `100.x.y.z` address: Android can't allow an IP range, and blocks the bare address. If you
use an address the phone can't reach (a bare Tailscale IP, `localhost`, or any other plain `ws://`
host), the Android app says so on its pairing screen and in the chat list instead of spinning on
"Connecting…". If you prefer `wss://`, enable **HTTPS certificates** in the tailnet's DNS settings
and either put `tailscale serve --bg 4400` in front (needs Serve enabled once per tailnet) or
terminate TLS with `tailscale cert` on your own proxy.

Trade-offs: the computer must be awake and Tailscale running; push notifications need APNs/FCM
keys on this relay like any other; Tailscale's free plan covers up to 100 devices and 3 users.

### Self-host (free forever, one command)

The relay is a tiny stateless Node service; anything that runs a container can host it.

**Docker**

```bash
docker run -d --name nekko-agent-relay -p 4400:4400 --restart unless-stopped \
  -e NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1 \
  ghcr.io/nekko-labs/nekko-agent-relay:latest
```

**Docker Compose**

```yaml
services:
  nekko-agent-relay:
    image: ghcr.io/nekko-labs/nekko-agent-relay:latest
    ports: ["4400:4400"]
    environment:
      NEKKO_RELAY_ALLOW_UNAUTHENTICATED: "1"
    restart: unless-stopped
```

**Coolify** (recommended if you already run one): add a new service → Docker image
`ghcr.io/nekko-labs/nekko-agent-relay:latest`, expose port 4400, attach a domain, and let Coolify's
proxy terminate TLS. Point Nekko Agent at `wss://relay.your-domain.com`.

**Fly.io**: `fly deploy -c apps/relay-server/fly.toml` from a repo checkout. Keep it at **one machine**
(`fly scale count 1`): rooms live in a machine's memory, so agent and phone must land on the same
instance.

Put any self-hosted relay behind TLS (`wss://`) for internet use; the E2E layer protects content
regardless, but TLS also protects the transport-auth query string. Then paste the URL into
**Settings → Remote access → Use your own relay**.

Environment knobs:

| Env | Meaning |
|---|---|
| `NEKKO_RELAY_PORT` / `NEKKO_RELAY_HOST` | Bind (default `0.0.0.0:4400`) |
| `APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID` | Enable iOS push |
| `FCM_SERVICE_ACCOUNT` | Enable Android push (service-account JSON) |
| `NEKKO_RELAY_AUTHZ_URL` | Gate agent enrollment on a Nekko Cloud account (managed hosting) |
| `NEKKO_RELAY_ALLOW_UNAUTHENTICATED=1` | Explicitly allow unauthenticated agent enrollment for trusted/private deployments; otherwise agent enrollment is disabled when no authz URL is configured |

The relay validates device IDs as UUIDs and push tokens as non-empty platform
tokens. A connected device cannot replace another connection's push token for
the same device ID. Keep the relay behind TLS (`wss://`) and do not enable the
unauthenticated mode on a public endpoint.

## Headless agents

A machine without a screen (server, homelab box) can expose itself with the relay-agent mode:

```bash
NEKKO_RELAY_URL=wss://your-relay NEKKO_ROOM=myroom NEKKO_PAIR_KEY=<secret> npx nekko-agent
```

It prints a one-time pairing code (10 minutes) at boot and keeps the same persistent device
registry as the desktop app.
