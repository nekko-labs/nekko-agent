---
title: "Hardware keys, step-up on phone and desktop, and remote sign-out (2026-10-24)"
area: platform
---

# Hardware keys, step-up on phone and desktop, and remote sign-out (2026-10-24)

`[implemented 2026-10-24, SK-1..11, not verified on real hardware: shared constants and security.json, TS and Rust verifiers on one golden (Swift and Kotlin twins too), the daemon asking for a step-up on a phone's mode raise and on the desktop's and Local Web UI's guarded actions, the safety exits on the computer and on both phones, Settings → Security and the step-up sheet on desktop, Local Web UI, iPhone and Android, per-machine methods on Nekko Cloud machines, an end-to-end relay itest, and the docs page. Unit- and integration-tested where the container could run them; the iPhone and Android apps were written without being compiled, and nothing has met a real key (SK-12). Known gap: the phones cannot use keys or passkeys under the `nekko-computer:<id>` rpId (iOS associated domains, Android Digital Asset Links), so they fall back to a code until the rpId question in decision 0018 is settled; the desktop's key ceremony runs on `http://localhost` with rpId `localhost`. Each surface shows the owner's note that the developers had no hardware key to test with]`  Asked for by Philip on 2026-10-24: support for hardware keys and other MFA on both the phone and the desktop, and a way to log out or shut down the remote device app for safety. Decision record: [docs/decisions/0018-the-computer-is-the-relying-party-for-step-up.md](../../docs/decisions/0018-the-computer-is-the-relying-party-for-step-up.md). Tasks: SK-1 to SK-12 in [TASKS.md](../../TASKS.md). Builds on the signed Change proof (IO-33) and the phone access classes in [phone-access-classes-and-relay-replay-protection.md](../phone/phone-access-classes-and-relay-replay-protection.md).

## User intent

Today one factor stands between a stolen or borrowed phone and the computer: the phone's own Face ID / passcode, which also unlocks the Secure Enclave Change key. On the desktop nothing at all stands between someone at the keyboard and *Rotate secret*, *Pair a device*, YOLO mode or a provider key: the operating-system login is the only boundary. The owner wants:

1. A **second factor they hold**, a hardware security key (YubiKey, Titan, any FIDO2 authenticator over USB-C, NFC or Lightning) or another MFA method (a passkey on another device, or a one-time code), required for the actions that would let an attacker take the computer over or hide what they did.
2. The same protection on the **desktop** (and the Local Web UI), where today there is none.
3. A **safety exit**: from the phone, sign this phone out and, when something is wrong, stop remote access on the computer or shut the agent down, in one tap, without needing the computer in hand. And from the desktop, sign every phone out at once (today: *Rotate secret*, which is named for its mechanism rather than its purpose).

## What the owner sees

### Step-up: which actions ask for the second factor

A **step-up** is an extra confirmation, with a hardware key or another registered method, on top of what already happens today (Face ID on the phone, nothing on the desktop). It applies to a short, fixed list, the **guarded actions**, on every surface:

| Guarded action | Phone today | After this |
| --- | --- | --- |
| Raise a chat's mode (Ask → Guardrails → YOLO), or the default mode | Face ID (Change proof) | Face ID + step-up |
| Turn remote access on, change the relay or the connection | n/a (desktop only) | desktop step-up |
| Pair a device, rotate the secret, sign all phones out | n/a (desktop only) | desktop step-up |
| Change what a phone may do (Read / Change switches) | n/a (desktop only) | desktop step-up |
| Add, show or change a provider key or account | n/a (desktop only) | desktop step-up |
| Turn step-up itself off, or remove a registered key | n/a | step-up with a *different* registered method, or the recovery code |
| Stop remote access on the computer / quit the agent from a phone (new, below) | n/a | **no** step-up: a safety exit must never be harder than the attack |
| Sign this phone out (new, below) | n/a | **no** step-up, same reason |

Everything else (sending a prompt, approving a tool, answering a question, saving a file, pushing a branch) keeps today's rules. The list is a product decision, not a per-channel switch; it is the same list in `packages/shared/src/step-up.ts` and the daemon, held together by a golden fixture.

### Registering a method

**Settings → Security** (new section, desktop and phone) lists the registered methods for this computer, each with a name, when it was added and when it was last used:

- **Security key**: register by touching the key. On the desktop, the renderer calls WebAuthn (Chromium in Electron supports USB, NFC and Bluetooth FIDO2 keys and the platform authenticators: Windows Hello, Touch ID, Linux through the key only); on the iPhone, `ASAuthorizationSecurityKeyPublicKeyCredentialProvider` (NFC and Lightning / USB-C); on Android, the Credential Manager with FIDO2 (NFC, USB-C). The **computer is the relying party**: it generates the challenge, stores the credential's public key and counter, and verifies every assertion itself. No server, no Nekko Cloud account, no domain registration: the relying-party id is the computer's own stable id (`nekko-computer:<installId>`), and WebAuthn's origin check is satisfied because the desktop renderer runs at a fixed app origin and the phones use the Apple and Google app-attestation paths.
- **Passkey on this phone / this computer**: the platform authenticator (Face ID, Touch ID, Windows Hello, Android biometrics) registered through the same WebAuthn path. On the iPhone this is distinct from today's Secure Enclave Change key only in that it is a FIDO2 credential the computer verifies by the FIDO2 rules (signature counter, user verification flag), so a phone can hold both: the Change key signs every change, the passkey or the security key answers a step-up.
- **One-time code (TOTP)**: a secret the computer generates and shows once as a QR for any authenticator app; the phone and desktop accept the six digits. Offered because a security key can be forgotten at home. Rate-limited on the computer (5 wrong codes, then a minute, doubling).
- **Recovery code**: ten single-use codes shown once when the first method is registered, stored by the owner. Used only to turn step-up off when every method is lost. There is no Nekko Labs reset: that is the point.

At least **two** methods must be registered before step-up can be turned on (a security key and a TOTP, or two keys), so a lost key never locks the owner out of their own computer. The desktop warns, not refuses, when the second method is TOTP on the same phone that is being protected.

### Asking for it

A guarded action opens the step-up sheet: *Confirm with your security key* (touch it, or hold it to the top of the phone for NFC), a **Use a code** fallback, and the action's name and target in plain words (*Switch "Refactor auth" to YOLO on Philip's Mac Studio*). One confirmation covers **five minutes** on that surface for the same class of action, the same window the Change signer already uses, so raising three chats to Guardrails is one touch. The desktop sheet says which key answered (by its registered name). Cancel leaves everything as it was.

On the phone the step-up is carried **inside the sealed request** as a second proof beside the Change proof: `proof: { ts, sig }` is unchanged, and `stepUp: { credentialId, authenticatorData, clientDataJSON, signature }` (or `{ totp: "123456" }`) is added. The computer verifies the Change proof first (so an unregistered or revoked phone never reaches the authenticator check), then the step-up, and refuses `step-up-required`, `step-up-invalid` or `step-up-stale` with a plain sentence the phone shows. A step-up challenge is fetched with `security:challenge` (read class), is single-use and expires in two minutes; the challenge, not a timestamp, binds the assertion, so it cannot be replayed on another connection even by the relay.

On the desktop the guarded action's IPC call goes through the same check in the main process: the renderer gets a challenge, the WebAuthn assertion (or TOTP) rides along with the call, and the main process verifies before acting. The Local Web UI uses the identical path over its socket. Phone-callable channels and desktop-only channels keep their separation: a phone can never call the desktop's registration channels.

### Safety exits

**From the phone, Settings → This computer**, and in the connection banner's overflow menu, so it is reachable while a chat is running:

- **Sign out this phone.** The phone sends `device:signOut` (agent class, no proof, no step-up), the computer revokes the device as if the owner had tapped *Revoke* on the desktop (kick 4001, `revoked` on the record, one activity entry), and the phone forgets the computer's pairing material, outbox, drafts and offline files for it. Re-admission needs a new pairing code, as for any revoked device. Works offline too: the phone forgets locally and sends the sign-out when it next connects, or never; the computer's *Paired devices* list shows the phone as *signed out from the phone* once it hears.
- **Stop remote access on the computer.** `remote:stop` (agent class, no proof): the computer turns remote access off exactly as the desktop's switch does, kicks every phone, and shows a banner on the desktop: *Remote access was stopped from Philip's iPhone at 14:02. Turn it on again from here.* Only the desktop can turn it back on (and, with step-up on, only with the second factor). This is the "I think my phone is compromised" button: a phone with Change off may still press it, because stopping is never a change the switches guard. `[decided 2026-10-24, Philip]` The phones are disconnected, not signed out: each keeps its push registration, so notifications resume as soon as remote access is back. A phone loses push only when it is disconnected on purpose (*Sign out this phone*, or *Revoke* / *Sign out all phones* on the desktop); a phone that is asleep or inactive keeps it too.
- **Quit Nekko Agent on the computer.** `app:quit` (agent class, no proof), behind a confirm sheet on the phone. The daemon finishes nothing: running chats are interrupted as on a normal quit, the app and the daemon exit, and the tray icon goes away. There is no remote start: the owner turns it on again at the computer. Shown only when the computer reports `quitFromPhone: true` in `app:info` (off by default in the desktop's Remote access card, so a phone cannot shut down a computer whose owner did not opt in).

All three write an activity entry and a desktop notification. None asks for a proof or a step-up: a safety exit done by an attacker costs the owner a re-pair, while a safety exit the owner cannot do costs them the computer.

**From the desktop, Remote access card:**

- *Rotate secret* is renamed **Sign out all phones** (the mechanism line under it still says that the room is re-keyed and every phone must pair again). Guarded by step-up when it is on.
- A **Lock phones** switch: every phone keeps Read and loses Change until the switch is turned off (one toggle instead of flipping each device's Change switch). Guarded.

## Platforms

- **Desktop (Electron)**: WebAuthn in the renderer with the main process as relying party (`@simplewebauthn/server` or the daemon's own verifier in Rust, see decision 0018 for why the daemon). Windows Hello, Touch ID and USB / NFC keys. Linux: keys only (no platform authenticator in Chromium on Linux).
- **Local Web UI**: the same renderer code over `http://localhost`; WebAuthn treats `localhost` as a secure context, so keys and platform authenticators work there too. A reverse-proxied Local Web UI on another host name is told that step-up needs `https`.
- **iPhone**: `AuthenticationServices` for security keys (NFC, Lightning, USB-C) and platform passkeys; the step-up sheet is the system sheet. The Watch never asks for a step-up (it has no authenticator); a guarded action from the Watch is refused with *confirm on your phone*.
- **Android**: `androidx.credentials` with `GetPublicKeyCredentialOption`, which reaches USB-C and NFC keys and the device's own passkey. Android's Change signer (AN-30) is still missing; step-up does not wait for it, because a step-up is verified on its own.
- **Expo app**: no step-up (it is being retired by the native ports); guarded actions are refused with *use the native app*.
- **Nekko Cloud machines**: the cloud machine is a computer like any other and runs the same relying-party code; registered methods are per machine, never per account, so a Nekko Labs operator cannot add one. `[decided 2026-10-24, Philip]` A cloud machine has no desktop to turn remote access back on, so a restart re-attaches it even after a phone's *Stop remote access* (today's behavior), and Nekko Cloud keeps at least one of the owner's machines running, so stopping one never leaves the owner with nothing reachable.

## Acceptance criteria

- With step-up on, each guarded action (the table) is refused `step-up-required` without a valid step-up, on the phone (inside the sealed request) and on the desktop (main-process check), and runs with one; the same assertion again is `step-up-replayed`; an assertion for another challenge is `step-up-invalid`; a challenge older than two minutes is `step-up-stale`. Golden fixture shared by TS, Rust, Swift and Kotlin, like `change-proof.json`.
- A FIDO2 assertion with a signature counter not above the stored one is refused and the credential is flagged *possibly cloned* in Settings → Security.
- Step-up cannot be turned on with fewer than two registered methods; turning it off or removing a method needs a step-up with a different method or a recovery code; each recovery code works once.
- TOTP: RFC 6238, 30 s, ±1 window, SHA-1 default for app compatibility; 5 wrong codes then a minute, doubling, per computer.
- `device:signOut`, `remote:stop` and `app:quit` are agent class, refused `change-off` **never** (they are exempt from the Change switch by name, with a test that fails if the exemption list grows), refused `read-off` never, and each writes an activity entry; `app:quit` is refused `quit-disabled` unless the desktop switch is on.
- A signed-out phone is denied `revoked` at its next HELLO; a new pairing code admits it again with a fresh record (no Change key, no step-up credentials).
- After `remote:stop` the relay agent is down within one second, every phone sees 4001, and the desktop shows who stopped it and when; the desktop's switch turns it back on (with step-up when on).
- The desktop's Remote access card never lets a phone call `security:register*`, `remote:enable` or `remote:setAccess` (they stay out of `PHONE_CHANNELS`; a test pins this).

## Security boundaries

- The computer verifies every factor itself and holds the credential public keys and the TOTP secret (in `security.json` beside `remote.json`, mode 600, TOTP secret and recovery-code hashes only). Nothing about registered methods goes to the relay, Nekko Cloud or a phone; a phone learns only *step-up required*, which methods exist by kind, and the computer's relying-party id (`nekko-computer:<installId>`, which the phone's FIDO2 client must name to ask a key for an assertion; not a secret, since every assertion's rpIdHash carries it), so it can show the right sheet.
- The step-up assertion is bound to a single-use challenge issued by the computer, carried inside the end-to-end sealed frame; the relay sees ciphertext and cannot forge, strip or replay it.
- Step-up is **in addition to** the Change proof and the Read / Change switches, never instead: a phone with Change off cannot raise a mode even with a key.
- Safety exits are deliberately unguarded. The worst an attacker with a stolen phone can do with them is a denial of service that the owner repairs at the computer in two taps; the activity list and the desktop banner say which phone did it and when.
- Recovery codes are the only way past a lost second factor. Nekko Labs holds nothing that can turn step-up off; a lost key and lost codes mean reinstalling the computer's `security.json` away, with physical access, which is the same bar as today's OS login.
- The relying-party id is per computer, so a credential registered on one computer is useless on another; a key registered on three computers holds three credentials (FIDO2 resident-key capacity is a limit the Settings page mentions for keys that cannot make non-resident credentials).

## Not in scope

Account-level MFA for Nekko Cloud sign-in (Supabase identity, decision 0005) is a separate feature with its own threat model; this feature guards the computer, which has no account. SMS and e-mail codes are not offered (phishable, and the computer has no sender). Per-chat step-up (asking for a key before each prompt) is not offered; the Read / Change switches already give a watch-only phone.
