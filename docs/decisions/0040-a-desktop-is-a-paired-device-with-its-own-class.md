---
status: accepted
date: 2026-11-02
---

# 0040. A desktop is a paired device, with its own access class

## Context

Philip works from a MacBook and wants to run and watch agents on his other
computers from it. Phones already reach a computer over relay v2, but the phone
gate is too narrow for a desktop: it cuts tool output to 4,000 characters, keeps
the newest 300 messages, and refuses compaction, truncation and accepting
changes. Design: [connected computers](../superpowers/specs/2026-11-02-connected-computers-design.md).

## Decision

1. **Reuse relay v2.** A desktop pairs as a device: same sealed frames, signed
   HELLO, routes, device registry and revocation. The engine gains a relay
   client, a port of the iPhone's.
2. **A computer access class, beside the phone classes.** `COMPUTER_ACCESS`
   adds what a remote chat needs, and takes away what a phone reaches only
   behind Face ID: terminals, SSH, adding a folder by path and setting provider
   keys. Credentials, sign-ins, sync, remote-access settings and the machine's
   administration stay refused.
3. **The grant sets the class.** `remote:pairComputer` mints a grant for a
   computer, and enrollment writes `kind: "computer"` on the device record. A
   code pairs only what it was minted for, so a phone can't use a computer's
   link, nor a computer a phone's, and nothing in a later HELLO can change it.
4. **Links live in the engine, and only the window reaches them.** `computers:*`
   answers on the window's socket. An agent's tools, the CLI's API and the Local
   Web UI use other paths and never reach a paired machine.
5. **No prompt per call for changes.** A phone signs behind Face ID. A desktop
   saves files and commits all day, so it signs with its device key, with no
   presence check per call. Choosing a more permissive mode in the window is the
   only act of intent; step-up on the host still stops it.
6. **Attachments stay inside the chat.** A turn reads every attached path with no
   tool call and no approval, so a computer may attach only what it imported into
   that chat.

## Consequences

- Every host needs a build with the class: an older computer can't mint a
  computer link.
- **Pairing is equivalent to being at the machine.** The gate limits what a
  computer calls directly, but it can start a YOLO chat, and that agent can do
  anything the logged-in account can, keys included. The refusals are not a
  sandbox against the paired computer: they keep it out of the paths that need no
  agent, leave an activity trail, and hold when the host is in Ask mode with
  step-up on. `docs/REMOTE.md` says so.
- **The host isn't authenticated, and revoking doesn't re-key.** Every device in a
  room holds the same secret, so a revoked device that keeps it can pose as the
  host on the relay. A per-device key from an ECDH with a host key pinned in the
  link closes this; it is a protocol change, tracked apart.
- A prompt-injected agent on the client that reaches the OS key store item could
  use the link. That is closed on a signed macOS build and open on Windows, where
  Credential Manager has no per-app rule.
