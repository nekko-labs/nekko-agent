---
status: accepted
date: 2026-10-24
---

# 0016. A phone may carry a provider key sealed to a computer; it never holds or reads one

## Context

On 2026-10-19 the *Full phone access* decision (spec: [native-ios-app.md](../../spec/phone/native-ios-app.md)) put provider keys out of every phone's reach for good: `providers:save`, `providers:remove` and `providers:importCliAuth` are in `PHONE_DENIED_FOREVER` (`packages/shared/src/phone-access.ts`), and `providers:list` reaches a phone as `{id, kind, label, enabled}` only.

On 2026-10-24 Philip asked for provider setup from the phone, for a paired computer and for a Nekko Cloud machine (decision [0017](0017-nekko-cloud-machines-run-tools-in-a-per-user-jail.md)), where there may be no desktop to type a key into at all. Design: [reports/ios-chat-modernization-2026-10-24.md](../../reports/ios-chat-modernization-2026-10-24.md) §5.

What the 2026-10-19 rule protects: a phone is the device most easily lost, most often unlocked in public, and its saved transcripts and logs are shared for bug reports. A usable key must never sit in its storage, its logs, or a message it can read back.

## Options considered

1. **Un-deny `providers:save` with redaction.** It takes a plaintext `ProviderConfig` and answers the full provider list (keys, `tokenKey`, `baseUrl`); redacting both directions adds two leak surfaces and still puts the plaintext key in the phone's memory and wire frames.
2. **The phone opens a prompt on the desktop; the key is typed there.** Keeps the 2026-10-19 rule whole, but needs someone at the computer and does nothing for a cloud machine with no desktop.
3. **The phone carries a sealed key.** The phone seals the key to the computer's device public key (HPKE, P-256, the primitives `nekko-sync` and `SyncCrypto.swift` already carry), sends it once over a new change-class channel, and the computer opens it, tests it, stores it in its own keychain and answers `{ok, models}` or the provider's error. The phone never writes the key, never reads one back, and the computer never returns one.

## Decision

Option 3. Two new phone channels:

- `providers:saveSealed({id, kind, label, baseUrl?, sealedKey})`, class **change** (a signed Secure Enclave proof, so Face ID or the passcode). The computer refuses a `baseUrl` on a loopback or link-local address it cannot reach itself, tests with `providers:testConfig`, saves as `providers:save` does, and answers `{ok, models: [...]}` or `{ok: false, message}`. It never echoes the key or the provider list.
- `providers:setEnabled(id, enabled)`, class **change**: flips one boolean and nothing else, which is why it is not `providers:save`.

`providers:save`, `providers:remove` and `providers:importCliAuth` stay in `PHONE_DENIED_FOREVER`; subscription sign-ins (ChatGPT OAuth) stay on the computer, and Claude plan sign-in stays removed by policy. An optional *Approve provider changes on the computer* switch under Remote access, on by default for the first provider a given phone adds, shows a notice on the desktop that the owner clicks once; a cloud machine has no desktop, so there the Face ID proof is the whole gate.

The rule now reads: **a phone may carry a sealed key to a computer; it may never hold or read one.**

## Consequences

- The phone's Keychain, logs, saved transcripts and diagnostics never contain a provider key; the sealed blob is useless to anything but the one computer's device key.
- A key typed on the phone is in that process's memory for one call. Clipboard paste is the phone's own risk, as it is in any password manager.
- The computer gains an HPKE open path for its device key and a provider test that never leaks the key into the answer; golden parity for the two channels' screens and views, as for every phone channel.
- We will know it was wrong if a phone-side log or transcript is ever found to carry a key, or if users cannot set up a cloud machine's provider without a desktop.
