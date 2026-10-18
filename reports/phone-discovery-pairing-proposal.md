# Proposal: find and pair a computer on the same network (PH2/PH3)

Status: **proposal, not built** (2026-10-17). It needs the owner's decision because it changes how a phone gets the room secret, which is the root of the whole security model (`packages/shared/src/remote.ts`).

## Why

Today a phone pairs only by scanning a QR code, pasting a link, or opening a `nekko-agent-pair:` link from the computer. Orca and most remote-control apps also list the computers they can see nearby, so you tap one instead of finding a QR code. TASKS PH2 (desktop advertises `_nekko-agent._tcp`) and PH3 (phones browse it) describe the discovery half. Discovery alone isn't enough, though, and that's the reason this is a proposal rather than a PR.

## The gap discovery leaves

The TXT record may carry only `name`, `relay` (URL), `pair=1` and `v`. It can't carry the room or the secret, because anyone on the network can read it. A phone that discovers "Studio" therefore knows the relay URL but has no way into the room. PH3's line, "the desktop shows the approve prompt and the code exchange runs as today", assumes a key exchange that doesn't exist yet. Something has to move the room secret to the phone without a camera and without trusting the network.

## Options

| | How the phone gets the secret | New attack surface | Works over Tailscale | Phone and desktop work |
| --- | --- | --- | --- | --- |
| **A. Discovery only** | It doesn't. The phone lists "Studio, open Remote access there and scan its code", with the relay pre-filled. | None | Yes | Small. No new crypto. |
| **B. LAN listener + SAS** | The desktop opens a short-lived local port while pairing. The phone does X25519 with it, both screens show a 6-digit code, and the user approves on the desktop. The secret then goes over the ECDH channel. | A new inbound port on the computer, even if only for 2 minutes | Only if the tailnet allows the port | Medium. CryptoKit, noble and JCA all have X25519. |
| **C. Relay lobby + SAS** (recommended) | The same exchange as B, but over the relay the desktop already dials out to, in a one-off **pairing lobby** whose id is in the TXT record (`lobby`, random, valid while the pairing window is open). | None on the computer. The relay routes one more room type and sees only ciphertext and public keys. | Yes. It reuses the relay route. | Medium. The same crypto as B, plus a lobby room type on the relay. |
| **D. Relay lobby + PAKE** | Like C, but the user types a short code shown on the desktop into the phone (SPAKE2/CPace), with no comparison step. | As C | Yes | Larger. No PAKE in CryptoKit, so it needs a vetted implementation on three platforms. |

## Recommendation: C

**The flow:**

1. **Open the window.** On the computer, *Remote access → Pair a phone* opens the pairing window (as today: 10 minutes, single use). While it's open, the desktop advertises `_nekko-agent._tcp` with TXT `name`, `relay`, `pair=1`, `lobby=<16 random bytes, hex>`, `v=1`. The desktop then joins `lobby` on its relay as an agent.
2. **Pick the computer.** The phone lists it under *Computers → On this network* and the user taps it. The phone joins `lobby` as a client and sends an ephemeral X25519 public key. The desktop answers with its own key.
3. **Compare codes.** Both sides derive the shared key and a **6-digit comparison code** from the transcript hash: `SHA-256("nekko-pair-v1" ‖ lobby ‖ pubDesktop ‖ pubPhone)`, the first 20 bits as decimal. The desktop shows "Pair **Philip's iPhone**? Code **482 913**". The phone shows the same code, labelled "Check that your computer shows this code".
4. **Approve.** The user taps **Pair** on the computer. The desktop then seals `{relay, room, key, pair}` (today's pairing link, plus a fresh single-use code) with the shared key and sends it. The phone stores it exactly as if it had scanned the QR code. From there the existing HELLO enrollment runs unchanged.
5. **Close.** The lobby closes after one exchange, after 2 minutes, or when the window closes. A second phone needs a new window.

**Why C over the others:**

- It adds no inbound port on the computer. B does, which goes against "dial out only" (REMOTE.md).
- It works the same on the LAN and on the tailnet, where browsing happens over Tailscale's DNS-SD if published, or by picking the tailnet name.
- It needs only X25519, SHA-256 and the AES-GCM sealing already in `E2E`, all of which exist on every platform today.
- The comparison code defeats a man in the middle on the network or a malicious relay, provided the user really compares. That's the same assumption Bluetooth numeric comparison makes.

**What it doesn't change:**

- The room secret, the HELLO enrollment, revocation and rotation all work as today.
- QR, paste and links stay.
- Discovery never runs unless remote access is on and the user opens the pairing window. The "Visible on this network" toggle (PH2) controls only the advertisement, not pairing by QR.

## Where the code would go

- **Shared** (`packages/shared/src/pair-lobby.ts`): the transcript hash, the comparison code and the lobby frames, with golden vectors for Swift and Kotlin.
- **Relay** (`apps/relay`): a `lobby` room type. One agent and one client, a 2-minute TTL, frames of at most 1 KB, and no push.
- **Desktop and TS host:**
  - the mDNS responder (PH2, `dgram`) and the lobby client;
  - the approve sheet with the code;
  - Rust daemon parity in `crates/nekko-remote` with goldens.
- **iOS:**
  - `NWBrowser` for `_nekko-agent._tcp`;
  - `NSLocalNetworkUsageDescription` and `NSBonjourServices` in Info.plist;
  - the lobby client in NekkoProtocol, the code screen and an "On this network" section.
- **Android:**
  - `NsdManager` browse;
  - the lobby client in the protocol module, the code screen and "On this network".
- **Tests:**
  - vectors across the three languages;
  - relay lobby limits;
  - a live itest where the fake desktop approves and the phone ends up welcomed;
  - a MITM test where a relay that swaps keys yields different codes.

## Risks, honestly

- **People approve without comparing.** That's the weakness of any comparison code. The mitigations:
  - the approve sheet shows the phone's name;
  - the window is opened deliberately on the computer;
  - the lobby is single use;
  - a wrong approval still yields a device the owner can see and revoke.
- **Local network permission** on iOS shows a system prompt. It's asked only when the user opens "On this network".
- **mDNS on corporate or guest Wi-Fi** is often blocked; QR still works there.
- **Twenty bits** means an online attacker gets about a one-in-a-million chance per attempt, with one attempt per window.

## The decision needed

1. **Option C as described**, or A (discovery only), or D (PAKE with a typed code).
2. **The 6-digit code** (20 bits), or 8 digits.
3. **"Visible on this network"**: on by default while remote access is on (as TASKS PH2 says), or off by default.

With a decision, the work is about three PRs: shared, relay and desktop first; then iOS; then Android. Each has its own tests and a live itest.
