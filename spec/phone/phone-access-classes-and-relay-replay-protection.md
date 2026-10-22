---
title: "Phone access classes and relay replay protection"
area: phone
---

# Phone access classes and relay replay protection

`[implemented 2026-10-22; Rust, TS, Swift (`swift test`) and Android protocol and app unit tests pass, plus the daemon's end-to-end relay test; not yet run on a device, against the managed relay, or from the Expo app]` Decided by Philip on 2026-10-22 after a security review of the phone path. Decision record: [docs/decisions/0011-phone-access-classes-and-relay-replay-protection.md](../../docs/decisions/0011-phone-access-classes-and-relay-replay-protection.md). Builds on *Full phone access, the foundation (IO-33)* in [native-ios-app.md](native-ios-app.md) and *What a paired phone may do* in [how-its-built-the-window-and-the-engine-daemon.md](../platform/how-its-built-the-window-and-the-engine-daemon.md).

## User intent

The *Read* and *Change* switches under *Remote access → What phones can do* mean what they say for everything a phone does, not only for files, git and terminals. A phone with Change off can watch but cannot make the agent do anything; a phone with Read off sees nothing. Letting a chat run with fewer approvals (Guardrails or YOLO) from a phone is confirmed on the phone like saving a file. And someone who can see the relay's traffic (the managed relay, or a LAN relay that is plain `ws://`) can't record a phone's frames and play them back later to act as that phone.

## What changed for the owner

- **Every phone channel has a class, and a channel with none is refused.** Before, about 30 channels (sending prompts, approving tools, answering questions, running automations, changing settings and chat options, reading chats) were in no class, so neither switch applied to them. Now:
  - **Read** (`read-off` when off): the chat list and a chat (`sessions:summaries`, `session:get`, `chat:pending`), changes, settings, providers, models, skills, tasks, workflows, usage, limits, PR status, voice status and saved folders, plus the git, files, logs and terminal reads that already were.
  - **Change, no proof per call** (`change-off` when off; `PHONE_AGENT_CHANNELS`): `chat:send`, `chat:queue`, `chat:editQueued`, `chat:abort`, `chat:answer`, `tool:approve`, `session:create`, `session:delete`, `session:fork`, `session:setOptions`, `settings:update`, `task:runNow`, `workflow:run`, `voice:transcribe`. Each call is written to the phone's activity, allowed or refused, like the proof-checked changes.
  - **Change with a proof** (unchanged): file saves, git and PR actions, opening terminals and SSH.
  - **Open to any paired phone:** `app:info` only.
  - A channel on the allowlist in no class is refused with `channel-denied` (fail closed), so a future channel added without a class never reaches the computer unchecked.
- **Raising a chat's mode needs Face ID.** `session:setOptions` setting `mode`, and `settings:update` setting `defaultChatMode`, to a more permissive mode than the current one (Ask, then Guardrails, then YOLO; a chat's current mode is its own, else the computer's default, else Guardrails) needs the same signed Change proof as saving a file, and is refused `proof-required` without one. Lowering or keeping the mode needs none. A phone may still pick YOLO; it just confirms it.
- **The iPhone** tries a mode change as a plain call and, when the computer answers `proof-required`, signs it with Face ID or the passcode and sends it again. A prompt queued offline for a new chat whose mode can't be raised from the queue goes out under the computer's default mode instead, with a note on the item. Refusals from the computer (`read-off`, `change-off`, ...) are shown as plain sentences where a send, an approval, an answer or an automation run fails.
- **Android** has no Change signer yet (AN-30), so raising a mode there is refused with a message to change it on the computer; the switch shows the old mode. Its refusals are also shown as plain sentences.
- **The desktop** words the switches accordingly (Read: see chats, files, git, logs and boards; Change: send prompts, approve tools, run automations, edit files, commit and push, type in terminals) and labels a phone still on an older app.

## Relay replay protection (phone protocol 4)

The relay only ever sees ciphertext, but before this a sealed HELLO was welcomed on its device id alone and requests carried no counter, so a recorded HELLO and its requests could be replayed into a new connection or repeated on a live one. Now:

1. When the relay announces a connection (`client-open`), the agent seals it a random challenge: `{type:'challenge', challenge}`, 18 random bytes in base64.
2. A phone on protocol 4 waits for the challenge and answers it in its sealed HELLO (`protocol: 4, challenge`). The agent keeps one outstanding challenge per connection and uses it once: a HELLO with a missing, wrong or already used challenge is never checked against the registry, and the connection gets a fresh challenge.
3. Every request after the welcome carries the same challenge and a `seq`, 1 for the first request after each welcome and rising. A request with a `seq` not above the last one, or another connection's challenge, is dropped without an answer and the connection goes back to the handshake with a new challenge (the phone says hello again on its own; it is not kicked, so nothing on the phone reads as unpaired).
4. The protocol version is 4 on the computer, the iPhone and Android (the welcome's version drives the phone's *update* banner as before).
5. The shared vector `crates/nekko-remote/tests/golden/relay-handshake.json` (key, sealed challenge, the exact HELLO and first two requests, the legacy HELLO) is checked by the Rust golden test, the iPhone's `RelayHandshakeTests` and Android's `RelayClientTest`.

Not done: the agent's own replies and events carry no counter the phone checks. Events are sealed once for every connected phone, so binding them to one connection means sealing per connection; the requests, where a replay makes the computer act, are covered.

**Compatibility, for one release.** A HELLO with no `protocol` or one below 4 is a legacy phone: it has no challenge and its requests no counter. The computer still welcomes it unless the owner set `"acceptLegacyPhones": false` in `remote.json` (no UI switch yet), logs it to `nekkod.log`, marks the device `legacyProtocol: true` (the desktop shows *Older app: update it on the phone*) and writes one `relay:hello` entry with reason `legacy-protocol` to its activity when the mark is first set. With the setting off a legacy HELLO is refused `update-required`, which the new apps word as "update this app". A new phone talking to a computer from before this waits 3 seconds for a challenge, then sends the legacy HELLO (`protocol: 3`); once it has seen a challenge from a computer it never falls back again in that session, and redials instead. The plan to drop legacy acceptance is TASKS.md IO-35.

## Acceptance criteria

- With Change off, every agent-class and change-class call is refused `change-off` before the computer runs anything, and is in the activity; reads still work.
- With Read off, every read-class call is refused `read-off`; `app:info` and Change calls still work.
- A channel in the allowlist but in no class is refused `channel-denied` (Rust test `an_unclassed_channel_fails_closed`, TS `fails closed`).
- Raising a mode without a proof is refused `proof-required` and runs nothing; with a valid proof it runs; the same proof again is `proof-replayed`; lowering needs no proof.
- A HELLO that declares protocol 4 is welcomed only with the connection's outstanding challenge, once; a replayed request is dropped and re-challenged; the daemon's end-to-end test replays a request byte for byte and sees the challenge.
- At most 64 connections wait for a HELLO; the oldest waiting one is forgotten first, a welcomed one never.
- Legacy phones are welcomed and marked by default and refused `update-required` when `acceptLegacyPhones` is false.

## Security boundaries

The computer decides; neither phone app is trusted to class its own calls. The challenge and counter sit inside the sealed frames, so the relay can neither forge nor strip them; it can still drop or delay frames, which is a denial of service, not an action. Proof-checked changes keep their own replay check (the proof fingerprint) on top.
