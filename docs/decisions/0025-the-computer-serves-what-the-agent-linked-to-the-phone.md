---
status: proposed
date: 2026-10-26
---

# 0025. The computer serves the phone what the agent linked in a chat, and nothing more

## Context

Agents link what they make: a report or a chart as an absolute path or a `file://` URL, often outside the chat's folder (a chat may have no folder), and a dev server as `http://localhost:5173`. The desktop opens both. A paired phone could open neither: it reaches the computer only through the end-to-end encrypted relay and the channel allowlist (decision 0012), and the phone's file browser (IO-33 FA-1) only names files relative to a chat's or saved folder, so an absolute path elsewhere was out of reach, and no channel reached a loopback port. Issue #1095.

Constraints: the phone must not gain general file access or a general network proxy through the computer (`file:read`, `dir:list` and `image:fetch` stay refused); a prompt-injected agent should not be able to widen what the phone can reach beyond what it could already show; every reply has to fit the relay's 9 MiB frame.

## Options considered

1. **The phone hosts it**: the agent or the computer pushes the files to the phone, which renders them. Pros: no new computer-side read path. Cons: the computer has to guess what to push and when; a dev server can't be pushed at all; large or many files fill the phone for nothing.
2. **General file access from a phone**: let a phone read any absolute path, like the desktop's `file:read`. Pros: simplest. Cons: one paired phone, or one stolen phone with Read on, reads the whole disk; contradicts IO-33's scoped design and decision 0012.
3. **A general loopback proxy**: let a phone fetch any `localhost` URL. Pros: every local tool works. Cons: exposes every local service (databases' web consoles, admin panels, other apps' local APIs, the engine's own port) to the phone; no notion of what the owner meant to share.
4. **A tunnel (Tailscale or similar)** so the phone reaches the computer's ports directly. Pros: full fidelity, no proxying. Cons: needs a VPN set up on both ends, exposes ports by network rather than by intent, and does nothing for files; the relay exists so none of this is needed.
5. **Scoped to what the agent linked in that chat** (chosen): two read-class channels, `artifact:read` and `preview:fetch`. The computer reads the chat's assistant messages for linked files and loopback origins (the desktop's artifact rules plus `file://` URLs and absolute paths) and serves only those, a linked HTML page's own asset folder, and GET/HEAD to a linked origin over 127.0.0.1 or ::1, with caps.

## Proposed decision and implementation status

The product decision remains proposed, not owner-accepted. This PR implements option 5 on the computer; it does not establish new product policy or claim device/relay verification. The separate iPhone consumer is now on main.

Option 5. The link in the agent's reply is the owner-visible statement of what the chat produced; scoping to it means the phone sees exactly what the desktop would let the owner click, in that chat, and nothing else. It needs no setup, works through the existing relay and access classes, and its rules are shared TS and Rust code held equal by a golden fixture.

The guard rails: assistant messages only (a user's or a tool's text never opens anything); real paths checked again after symlinks; secret-looking files always refused; a page's asset folder limited to asset extensions with no dot-folders, and never a disk root or the home folder; fetches connect only to loopback addresses with no DNS, no proxy, no phone headers or cookies, redirects only within the origin, 15 s and 4 MiB caps.

## Consequences

- A phone can open reports, charts, documents and small static sites the agent made, and look at a dev server's pages, without new setup.
- A prompt-injected agent can still make a file readable from the phone by linking it, but only a file it can already read and could paste into its reply, and never a secret-looking one. If that proves too wide, the next step is limiting artifacts to files the agent wrote in that chat (the change tracker already knows them).
- A dev server's page that loads assets from another origin, or that needs cookies or a POST, will not fully work on the phone; the phone has to rewrite a page's URLs to go through `preview:fetch` (phone UI, separate change).
- Read-class calls are not written to the device's activity list, so these reads leave no trail on the desktop. Revisit if the owner wants one.
- Spec: [spec/phone/agent-linked-files-and-previews-on-the-phone.md](../../spec/phone/agent-linked-files-and-previews-on-the-phone.md).
