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
2. **A computer access class, added to the phone classes.** `COMPUTER_ACCESS`
   only adds. Credentials, sign-ins, sync, remote-access settings and the
   machine's administration stay refused.
3. **The grant sets the class.** `remote:pairComputer` mints a grant for a
   computer, and enrollment writes `kind: "computer"` on the device record. A
   code pairs only what it was minted for, so a phone can't use a computer's
   link, nor a computer a phone's, and nothing in a later HELLO can change it.
4. **Links live in the engine, and only the window reaches them.** `computers:*`
   answers on the window's socket. An agent's tools, the CLI's API and the Local
   Web UI use other paths and never reach a paired machine.
5. **No prompt per call for changes.** A phone signs behind Face ID. A desktop
   saves files and commits all day, so it signs with its device key, with no
   presence check per call. Raising a chat to a more permissive mode still needs
   a proof, and a click in the window.

## Consequences

- Every host needs a build with the class: an older computer can't mint a
  computer link.
- A paired computer is more powerful than a phone, and weaker to losing: a
  stolen unlocked laptop can act until it is revoked, with no Face ID in the way.
  `docs/REMOTE.md` says so.
- A prompt-injected agent on the client that reaches the OS key store item could
  use the link. That is closed on a signed macOS build and open on Windows, where
  Credential Manager has no per-app rule.
