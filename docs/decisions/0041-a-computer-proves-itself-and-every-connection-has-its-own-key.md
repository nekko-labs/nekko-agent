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
   so it can forge no sealed refusal and no reply, and the computer refuses any
   HELLO under it with `update-required`, whatever it claims.
6. **Older pairings are replaced.** `pairing: 3` in `remote.json`. The first start
   makes a new room, secret and host key and keeps the device list, as decision
   0036 did, so a secret a revoked device kept dies with the upgrade. Every
   device pairs again once. Nekko Cloud mints the key pair with the machine and
   puts the public half in its link (`NEKKO_HOST_KEY`), so no path needs a
   first-seen key.

7. **Nothing unsealed ends a device's link.** Closes come from the relay, and
   anyone holding the room credential can cause one, so a 4001 or a "bad pairing
   key" is a failed route: a real removal arrives as a sealed refusal on the next
   dial. On a plain LAN address, before a welcome, "agent offline" fails the route
   too, because anyone can answer there. A device gives up on a HELLO that gets no
   welcome, since a challenge can be replayed.
8. **Revoking ends the session on the computer.** A kick is only a request to the
   relay, so the connection, and its key, go first. A relay that ignores it has
   nothing more to pass on.
9. **Only a welcomed device registers for pushes.** The Live Activity card carries
   chat text in the clear, so a room credential alone must not get it. The agent
   names who it welcomed (`welcomed`, before the sealed welcome), and the relay
   takes `register-*` only from that connection, under that device id.
10. **A link can't move a pin.** Pairing again with the same room and a different
    host key is refused. A real reset changes the room.

## Consequences

- Protocol 6 replaces the legacy paths. A phone with an older app is told to
  update; a phone with a newer app and a computer too old to send a signed
  challenge can't connect until the computer updates.
- Events are sealed once per connection instead of once per event. A computer
  has a handful of connections, so the cost is small.
- A reply still in flight when a connection is challenged again is dropped: it
  has no key to go out under. The caller times out or retries.
- **What this leaves.** The room credential is still shared, so a revoked device
  that kept it can still reach the relay. Where it can also take the agent role (a
  relay with no enrollment gate, or any valid access token), it can knock the real
  computer offline while it stays, register for pushes as a device it invents, and
  send phones content-free notifications or Live Activity text. It can't read or
  forge anything sealed. *Sign out all phones* replaces the room and shuts it out,
  at the cost of every device pairing again. Per-device relay credentials would
  close this and are a change to the relay, left out here.
- The relay's replies aren't numbered, so a malicious relay can replay or reorder
  events within a connection, and move an in-flight reply to another paired device
  by reopening a cid. Display-level only: it can't read them.
- The first update leaves the old room abandoned. A protocol 5 app keeps dialing
  it, sees only "offline", and a revoked device with the old secret can claim it,
  so ship the computer and the phone apps close together.
- A Nekko Cloud machine created before this has no way to give out a host key:
  its link was only ever shown once. Delete it and make a new one.
- A host key that leaks can pose as the computer. It lives where the pairing
  secret and device registry already do, so a device with terminal or agent access
  could have read it, and revoking doesn't replace it; rotating does.
