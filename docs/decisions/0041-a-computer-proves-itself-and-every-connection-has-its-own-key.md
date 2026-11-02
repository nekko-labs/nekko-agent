---
status: accepted
date: 2026-11-02
---

# 0041. A computer proves itself, and every connection has its own key

## Context

A device proved who it was to the computer (decision 0036), but the computer
never proved who it was back. Every device in a room also held the same
pairing secret, and every frame was sealed under a key derived from it, so
revoking a device changed nothing about what it held. Two reviews of connected
computers (decision 0040) found what that allowed, tracked as #1501:

- A revoked device that kept the secret could connect to the relay as the host
  (the relay takes the newest agent), answer a client's handshake, and read
  its prompts until the real host redialed.
- The same device could pass a real challenge to a paired client and reuse the
  signed HELLO, because the signature was not tied to the connection.

Both need a device that was once paired. It matters more for computers than for
phones, because a computer's agent-class calls need no proof.

## Decision

1. **A host key, pinned from the pairing link.** Each computer has a P-256 key
   in `remote.json` (`hostKey`, the private scalar). Its public half is in the
   link as `host=`. A device pins it and never takes one from anywhere else: no
   trust on first use, because the case that matters is a revoked device
   posing as the host at the moment a new one pairs.
2. **Each connection runs a signed key exchange.** The challenge carries the
   computer's one-use P-256 key (`eph`) and the host key's signature of
   `nekko-host-v1, room, challenge, eph`. A device that can't verify it drops it
   and sends nothing, so the pairing code is never offered to an impostor. The
   device makes its own one-use key and both derive
   `HKDF-SHA256(ECDH, zero salt, "nekko-session-v1, room, challenge, hostEph, clientEph")`.
3. **Every frame after the challenge is sealed under that key.** The device
   answers `{eph, enc}`: its public half beside the sealed HELLO. Each connection
   has its own key and keeps none past the socket, so a recorded session can't
   be opened later even with every long-term key.
4. **The HELLO is signed for this exchange.** The text is `nekko-hello-v2, deviceId,
   room, challenge, hostEph, clientEph`. The agent hands the verifier the keys it
   used itself, not what the device says. A relayed challenge produces a
   signature nobody else can use, on a connection nobody else can read.
5. **The room secret gets a device onto the relay and no further.** It still
   derives the relay credential and the key that carries the challenge. That
   key opens nothing else: a device ignores any frame under it but a challenge,
   so it can forge no refusal and no reply, and the computer refuses any HELLO
   under it with `update-required`, whatever it claims.
6. **Older pairings are replaced.** `pairing: 3` in `remote.json`. The first start
   makes a new room, secret and host key and keeps the device list, as decision
   0036 did, so a secret a revoked device kept dies with the upgrade. Every
   device pairs again once. Nekko Cloud mints the key pair with the machine and
   puts the public half in its link (`NEKKO_HOST_KEY`), so no path needs a
   first-seen key.

## Consequences

- Protocol 6 replaces the legacy paths. A phone with an older app is told to
  update; a phone with a newer app and a computer too old to send a signed
  challenge can't connect until the computer updates.
- Events are sealed once per connection instead of once per event. A computer
  has a handful of connections, so the cost is small.
- A reply still in flight when a connection is challenged again is dropped: it
  has no key to go out under. The caller times out or retries.
- **What this leaves.** The room credential is still shared, so a revoked device
  that kept it can still reach the relay. It can knock the real computer offline
  for the two seconds it takes to redial, and while connected as the agent send
  content-free notifications and Live Activity text to phones through the relay.
  It can't read or forge anything sealed. *Sign out all phones* replaces the
  room and shuts it out for good, at the cost of every device pairing again.
  Per-device relay credentials would close this and are a change to the relay,
  left out here.
- A host key that leaks can pose as the computer. It lives where the pairing
  secret and device registry already do; rotating replaces it.
