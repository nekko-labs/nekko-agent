# Proposal: push notifications for Tailscale-only setups (PH6)

Status: **proposal, not built** (2026-10-17). It needs the owner's decision because it changes the pairing-link format and what the hosted relay accepts for free.

## Why

A phone gets push only from the relay its computer uses, and only if that relay holds an APNs key and an FCM service account. Tailscale-first is the default story now: the "Relay on this computer" card (PH4) runs a private relay on the tailnet. A private relay has no APNs or FCM credentials, and can't have Apple's, so those users get no push. They get no Live Activity updates while the app is suspended, and no "your run finished" when the phone is in a pocket. Orca and Codex both push. This is the biggest functional gap left for Tailscale users.

## What it would be

The desktop keeps all traffic on its own relay or the tailnet, and **also** dials the hosted relay (`nekkoagent.com`) into a separate **push-only room**. That room carries only what push needs, which is already content-free by design:

- phones register their APNs, FCM or ActivityKit tokens there;
- the computer sends `notify` and `activity` frames;
- nothing else.

| | Proposal |
| --- | --- |
| **Push-only room** | A new room flag on the hosted relay. It accepts only `register-push`, `register-activity`, `notify`, `activity` and `push-remove`. It refuses `c`/`d` routing, so no chat traffic can flow through it even by mistake. The relay already drops unknown agent frames. |
| **Secrets** | Its own room id and secret, separate from the traffic room's. A leak of one doesn't open the other. |
| **What the hosted relay learns** | When notifications happen, the device push tokens and the platform (iOS or Android). It never learns content: `notify` is already "Your task finished.", and `activity` carries phase, opaque tag, call id and severity, as today. That's the same exposure as using the hosted relay for everything, minus all traffic. |
| **Pairing link** | Three optional parameters: `push=wss://…`, `proom=…` and `pkey=…`. Old phones ignore unknown parameters (both parsers do today), so old links and old apps keep working without push. |
| **Desktop setting** | *Remote access → Notifications through nekkoagent.com*. The default needs a decision; on is proposed when the traffic relay is private, with a one-line explanation of what the hosted relay sees. |
| **Free-tier limits** | Push-only rooms are free and don't count toward traffic (PH7). Per room: about 120 `notify` an hour and 600 `activity` updates an hour, so a runaway loop can't spam a phone; past that the relay drops frames silently. All of this is in env with documented defaults. |
| **Revocation** | Revoking a device sends `push-remove` to both rooms. Rotating the secret also rotates the push room. |

## Where the code would go

- **Shared:** the pairing-link parse and build for the three parameters, mirrored in `Pairing.swift` and `PairingTest.kt` with fixtures. Also the push-room frame allowlist.
- **Relay:**
  - the push-only flag at room creation (agent side);
  - the frame allowlist and the rate limits;
  - tests: chat frames are refused in a push room, and the limits hold.
- **TS host and Rust daemon:** a second outbound connection used only for push frames, and the setting, with TS↔Rust goldens.
- **Phones:**
  - store the push room;
  - send push and activity tokens there when it's present, else as today;
  - Settings → Connection shows "Notifications via nekkoagent.com".

## Risks, honestly

- **Metadata to Nekko's server** for people who chose Tailscale to avoid it: when runs finish, and how many devices. The setting and its explanation make this a choice.
- **One more connection** from the desktop. It's small (control frames only) and reconnects with the same backoff.
- **Push credentials** (APNs key, FCM service account) still have to be put on the hosted relay. That's already a human blocker.

## The decision needed

1. **Yes or no** to push-only rooms on the hosted relay, carrying content-free frames only.
2. **The default** for the desktop setting when the traffic relay is private: on, or off.
3. **The rate limits** above, or others.

With a yes, the work is one PR for shared and relay, one for the desktop (TS and Rust), and one for each phone.
