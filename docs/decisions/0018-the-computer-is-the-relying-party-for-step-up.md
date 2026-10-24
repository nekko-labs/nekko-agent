---
status: proposed
date: 2026-10-24
---

# 0018. The computer is the relying party for hardware keys and step-up; safety exits are never guarded

## Context

Philip asked (2026-10-24) for hardware keys and other MFA on the phone and the desktop, and for a way to sign out or shut down the remote device app for safety. The phone path already has a per-call signed Change proof (IO-33, a Secure Enclave P-256 key behind Face ID) and the Read / Change switches (decision 0012). The desktop has no authentication of its own: the OS login is the boundary, and anyone at the keyboard can pair a phone, rotate the secret, read a provider key or set YOLO. The computer has no account and no server of its own; Nekko Cloud identity (decision 0005) is optional and must not become required for a security feature of the local product.

## Options considered

1. **Make Nekko Cloud the relying party.** WebAuthn with a real domain (`nekkoagent.com`), credentials stored per account. Pros: textbook WebAuthn, passkeys sync through iCloud / Google. Cons: requires an account and the internet for a local-only product, puts a credential list on Nekko Labs servers, and a cloud outage or a Nekko Labs operator could affect whether the owner can raise a mode on their own computer. Rejected.
2. **The computer is the relying party.** Each computer issues its own challenges, stores credential public keys and counters in `security.json`, and verifies FIDO2 assertions itself; the relying-party id is the computer's install id; the desktop renderer and the phones each use their platform's FIDO2 client against it. Pros: no account, no server, works offline, one verifier shared by desktop, Local Web UI and phones (through the sealed request). Cons: a credential is per computer (a key holds one per computer), and passkey sync is irrelevant since the credential is bound to one computer anyway.
3. **Extend the Change proof instead (a second Secure Enclave key, a longer touch).** Pros: no new protocol. Cons: it is still the phone's own factor; a stolen unlocked phone has it. Not a second factor.

For the verifier's home: in the daemon (Rust, `crates/nekko-remote/src/step_up.rs`) with a TypeScript twin and a golden fixture, like `proof.rs` / `change-proof.json`, rather than only in the Electron main process, because the Local Web UI and Nekko Cloud machines run the daemon without Electron.

For the safety exits: guard them (consistent) or leave them open (safe). A guarded exit means the owner who has lost their key, or whose phone is being used against them, cannot stop remote access from the phone; an unguarded exit costs at most a re-pair.

## Decision

Option 2. The computer is the relying party and the single verifier for every second factor: FIDO2 security keys and platform passkeys over the platforms' native clients, TOTP as the no-hardware fallback, recovery codes as the only reset. Step-up applies to a fixed list of guarded actions (the spec's table), carried as a second proof inside the sealed phone request and as a challenge-bound assertion on desktop IPC. Two registered methods are required before step-up can be turned on. `device:signOut`, `remote:stop` and `app:quit` are agent-class phone channels exempt from the Change switch and from every proof, with `app:quit` behind a desktop opt-in; *Rotate secret* is renamed *Sign out all phones*.

## Consequences

- Four FIDO2 clients to wire (Electron renderer, iOS AuthenticationServices, Android Credential Manager, Local Web UI shares the renderer's) against one verifier, held equal by one golden fixture of assertions.
- A key is registered per computer; owners with several computers touch the key once per computer. The Settings page says so.
- The desktop gains its first authentication boundary, so the first-run flow and the Remote access card get a *Protect this computer* prompt once remote access is on; it stays optional.
- A stolen phone can stop remote access or quit the agent on the computer (denial of service, visible on the desktop with the phone's name and time); it cannot raise a mode, pair, or read a key.
- Lost key and lost recovery codes mean removing `security.json` with physical access to the computer, the same bar as today.
- Settled while building SK-1 to SK-3 (2026-10-24): no `security.json` means step-up off, as before the feature; one that cannot be read or parsed counts as on with no method, so every guarded call is refused (fail closed). Any answer to a live challenge spends it, accepted or not. One accepted step-up covers that phone's guarded calls for five minutes, in the daemon's memory only (a restart asks again). The accepted `clientDataJSON.origin` values are a per-computer list in `security.json` (`origins`), filled at registration (SK-4 to SK-7), not a built-in constant. The TOTP rate limit lives in `security.json`, so it survives a restart. The safety exits are answered by the daemon's phone gate itself; `stoppedBy` lives in `remote.json` beside the switch it explains; `quitFromPhone` is an app setting a phone cannot change.
- Found while building SK-4 to SK-7 (2026-10-24), still open: the platforms' FIDO2 clients will not use `nekko-computer:<installId>` as an rpId. Chromium accepts only a domain that matches a secure page, so the desktop runs its key ceremony in a window served from `http://localhost:<port>` and records `rpId: localhost` on each credential (the verifiers check a credential's own `rpId` when it has one; any localhost port is accepted). iOS ties passkeys, and possibly security keys, to the app's associated domains, and Android's Credential Manager to a Digital Asset Links domain; an Android assertion's origin is `android:apk-key-hash:…`, which no computer lists in `origins` yet. Until the phones get a domain-based rpId (for example a per-computer name under a domain we own, with the two association files) or another route, they answer step-ups with a one-time code. `security:challenge` now names the rpId for the phones. To settle with the hardware check (SK-12); this record stays proposed until then.
- Spec: [spec/platform/hardware-keys-step-up-and-remote-sign-out.md](../../spec/platform/hardware-keys-step-up-and-remote-sign-out.md). Tasks: SK-1 to SK-12 in [TASKS.md](../../TASKS.md).
