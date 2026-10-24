# Protect this computer with a security key

> **Not yet tested on real hardware.** The Devs don’t have a hardware security key to test this one, so we tried our best without one! If you see any issues, please [let us know](https://github.com/nekko-labs/nekko-agent/issues/new) 🙏

Nekko Agent can ask for a **second factor you hold** before the few actions that would let someone take your computer over or hide what they did: raising a chat to YOLO, turning remote access on, pairing a phone, changing what a phone may do, or touching a provider key. The second factor is a hardware security key (a YubiKey, a Titan or any other FIDO2 key, over USB, NFC or Lightning), a passkey on your phone or computer, or a six-digit code from an authenticator app.

This is called **step-up**: an extra confirmation on top of what already happens. On a phone that is Face ID (or the passcode) plus the key; on the desktop, where until now nothing stood between someone at your keyboard and these actions, it is the key.

Your computer checks every answer itself. There is no Nekko Cloud account behind it and nothing to register with us: the computer keeps the keys' public halves in a file of its own and never sends them anywhere.

## Set it up

Open **Settings → Security** on the computer. It lists the methods registered for this computer, each with its name, when it was added and when it was last used.

1. **Add a security key.** Choose to add a security key, give it a name you will recognize, and touch the key (or hold it to the top of your phone for NFC). On a Mac you can use Touch ID, on Windows, Windows Hello. On Linux only a key works: Chromium has no built-in authenticator there.
2. **Add a second method.** Step-up cannot be turned on with fewer than **two** methods, so a lost key never locks you out of your own computer. Good pairs are two keys (keep one at home), or a key and a one-time code.
   - **One-time code:** choose to add a one-time code, scan the QR with any authenticator app (1Password, Google Authenticator, Authy and the like), and type the six digits it shows. Settings warns, but lets you go on, if the authenticator is on the same phone you are protecting.
   - **Passkey on this phone or computer:** registered the same way as a key, with Face ID, Touch ID, Windows Hello or the phone's fingerprint.
3. **Save your recovery codes.** When you register your first method, Nekko Agent shows **ten recovery codes, once**. Print them or keep them in a password manager. Each works once.
4. **Turn step-up on.**

You can also register a key from the iPhone or Android app's **Settings → Security**, when the computer allows it.

A key registered on one computer is useless on another: each computer is its own relying party (it uses its own id, `nekko-computer:` and an install id). If you protect three computers with one key, the key holds three credentials. Some older keys can store only a few; Settings → Security says so when it matters.

## Which actions ask

| Action | Asks for |
| --- | --- |
| Raise a chat's mode (Ask → Guardrails → YOLO), or the mode for new chats | Face ID on the phone, then the key. On the desktop, the key. |
| Turn remote access on, change the relay or the connection | the key |
| Pair a device, **Sign out all phones** | the key |
| Change what a phone may do (its Read and Change switches, **Lock phones**) | the key |
| Add, show or change a provider key or account | the key |
| Turn step-up off, or remove a registered method | a **different** method than the one being removed, or a recovery code |
| Sign this phone out, stop remote access, quit Nekko Agent from a phone | **nothing extra**: a way out must never be harder than the attack |

Everything else (sending a message, approving a tool, answering a question, saving a file, pushing a branch) works as before.

**One confirmation covers five minutes** on that phone or that desktop, so raising three chats to Guardrails is one touch. A step-up never replaces the other checks: a phone with Change switched off cannot raise a mode, key or no key.

## What it looks like

A guarded action opens a sheet that says what is about to happen in plain words (*Switch "Refactor auth" to YOLO on Philip's Mac Studio*) and asks you to **confirm with your security key**: touch it, or hold it to the top of the phone. **Use a code** switches to the six digits from your authenticator app. **Cancel** leaves everything as it was. On the desktop the sheet says which key answered, by the name you gave it.

On a phone the request carries the key's answer inside the end-to-end encrypted message, next to the phone's own signature. The relay sees ciphertext only, and each answer is tied to a one-time challenge from your computer that expires in two minutes, so it cannot be replayed, even by the relay. If something is off, the phone says why in a plain sentence. Behind it is one of four answers from the computer:

| The computer's answer | What it means |
| --- | --- |
| `step-up-required` | This action needs a step-up and none was sent (or the five minutes are up). |
| `step-up-invalid` | The key is not registered on this computer, the answer was for another challenge, or the code was wrong. |
| `step-up-stale` | The challenge is more than two minutes old. Try again. |
| `step-up-replayed` | That exact answer was already used. Try again. |

The **Apple Watch** never asks for a key (it has none); a guarded action from the Watch says *confirm on your phone*.

### Codes

One-time codes follow the usual standard (RFC 6238: six digits, a new code every 30 seconds, the previous and next code also accepted). After **five wrong codes** your computer stops accepting codes for a minute, then two, then four.

### A key that may have been copied

Every security key counts its uses. If a key answers with a count that is not higher than the last one your computer saw, the answer is refused and Settings → Security marks the key **possibly cloned**. Remove it and register it again, or use another method.

## Recovery codes

Recovery codes are the only way past a lost second factor, and they do one thing: turn step-up off (or remove a method) when every other method is gone. Each code works once.

There is **no reset from Nekko Labs**. We hold nothing that can turn step-up off: that is the point. If you lose every method and every recovery code, the way back is at the computer itself, with physical access: quit Nekko Agent and delete `security.json` from its data folder. That is the same bar as your computer's own login.

## Safety exits from the phone

If your phone is lost or you think something is wrong, the phone can shut the door without the computer in hand. None of these ask for a key or Face ID, because a way out that is harder than the attack is no way out. The worst someone with your phone can do with them is make you pair again.

They are in the phone's **Settings → This computer** and in the connection banner's menu, so you can reach them while a chat is running:

- **Sign out this phone.** The computer revokes this phone (as **Revoke** on the desktop does) and the phone forgets the computer: its pairing, drafts, outbox and offline files. Coming back takes a new pairing code. If the phone is offline, it forgets at once and tells the computer when it next connects.
- **Stop remote access on the computer.** Remote access turns off, every phone is disconnected, and the desktop shows *Remote access was stopped from Philip's iPhone at 14:02. Turn it on again from here.* Only the desktop can turn it back on (with step-up, when it is on). A phone with Change switched off may still press this: stopping is never a change the switches guard.
- **Quit Nekko Agent on the computer.** Running chats are interrupted as on a normal quit, and the app closes. There is no remote start: you turn it on again at the computer. This one is off unless you turn it on in the desktop's **Remote access** card, so a phone cannot shut down a computer whose owner did not opt in.

Each one is written to the phone's activity on the computer and shows a desktop notification.

On the desktop, the Remote access card has two matching controls:

- **Sign out all phones** (it used to be called *Rotate secret*): the room is re-keyed and every phone must pair again.
- **Lock phones**: every phone keeps Read and loses Change until you turn the switch off.

## Where it works

- **Desktop app**: security keys over USB, NFC or Bluetooth; Touch ID on a Mac; Windows Hello. Linux: keys only.
- **Local Web UI**: the same, at `http://localhost`. If you reach it through a reverse proxy on another host name, step-up needs `https`, and the page says so.
- **iPhone**: security keys over NFC, Lightning or USB-C, and passkeys.
- **Android**: security keys over NFC or USB-C, and passkeys.
- **Nekko Cloud machines**: a cloud machine is a computer like any other. Its methods belong to that machine, never to your account, so nobody at Nekko Labs can add one.
- **The older Expo app** does not support step-up; guarded actions there say *use the native app*.

## What never leaves your computer

The keys' public halves and use counts, the one-time-code secret and the recovery codes (stored only as hashes) live in `security.json`, next to the remote access settings, readable only by you. Nothing about them goes to the relay, to Nekko Cloud or to a phone. A phone learns only that a step-up is needed and which **kinds** of method exist (a key, a code), so it can show the right sheet.

See also [Phone remote control](REMOTE.md) for pairing, the Read and Change switches, and what a paired phone can do.
