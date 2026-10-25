---
title: "Agent-linked files and local previews on the phone"
area: phone
---

# Agent-linked files and local previews on the phone

`[computer side implemented 2026-10-26 (issue #1095): TS and Rust screens and projections with shared golden cases, nekkod handlers with unit tests (temp folders, a local HTTP server) and a seeded-chat daemon HTTP integration test; not yet run from a phone, on a device or over the managed relay; the separate iPhone UI is now on main but not verified here; Android not started]` Decision record: [docs/decisions/0025-the-computer-serves-what-the-agent-linked-to-the-phone.md](../../docs/decisions/0025-the-computer-serves-what-the-agent-linked-to-the-phone.md). The decision remains proposed, not owner-accepted; the status above describes code and verification, not a new product policy. Builds on [phone access classes](phone-access-classes-and-relay-replay-protection.md) and *Files and logs on the iPhone* in [native-ios-app.md](native-ios-app.md).

## User intent

An agent that writes a report, a chart or a small web page links it in its reply, usually as an absolute path or a `file://` URL, often outside the chat's folder (a chat may have no folder at all). An agent that starts a dev server links `http://localhost:5173`. On the desktop both open. On a paired phone neither did: the phone can't reach the computer's disk or its loopback ports. The owner wants to tap those links on the phone and see the thing the agent made, without the phone gaining general access to the computer's files or network.

## What the computer serves

Two read-class phone channels (the device's **Read** switch applies; refused `read-off` when off). Both are scoped to **what the agent linked in that chat's assistant messages**, and nothing else.

**Which links count** (`chatLinks`, packages/shared/src/chat-links.ts; Rust copy `crates/nekko-remote/src/chat_links.rs`; held equal by `crates/nekko-remote/tests/golden/phone-artifacts.json`):

- Only assistant messages. A user's or a tool's text never opens anything.
- **Artifacts**: Markdown links and images (`[label](href)`, `![alt](href)`) outside fenced and inline code, the desktop's artifact rules (`chatArtifacts`) plus `file://` URLs (local only, percent-decoded, `file:///C:/...` on Windows) and absolute paths. A relative link resolves against the chat's folder when it has one, and is ignored when it has none. Other URL schemes, UNC shares, control characters and Windows alternate data streams are not artifacts. Extensions: md, markdown, html, htm, svg, png, jpg, jpeg, gif, webp, pdf, csv, json, txt, doc, docx, xls, xlsx, ppt, pptx.
- **Loopback origins**: `http(s)://localhost`, `127.0.0.1`, `0.0.0.0` (one origin, `localhost`) or `[::1]` (its own origin), with a port or the scheme's default, anywhere in an assistant message outside fenced code. Inline code counts, because agents usually write the dev server's address as `` `http://localhost:5173` ``. `http://localhost.example.com` and `http://localhost@example.com` are not loopback.

**`artifact:read [sessionId, path]`** → `{ path, name, mime, size, mtime, kind: 'text' | 'binary', content?, base64?, truncated }`

- `path` is absolute or a `file:` URL. The gate normalises it (`\` to `/`, `.` and `..` resolved, query and fragment dropped) and refuses a relative path, another scheme or a secret-looking file before the computer is asked.
- The computer allows it when it equals a linked artifact (compared case-insensitively on Windows and macOS), or lies inside the folder of a linked `.html`/`.htm` page with an asset extension (css, js, mjs, json, map, svg, png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf, html, htm, md, txt, csv; no WebAssembly) and no dot-folder or dot-file below the page's folder. A page at a disk root or directly in the user's home folder opens only itself, not the folder around it.
- The real path (symlinks followed) is checked again: it must be a file (`not-a-file` for a folder), not a secret (`secret-file`: the `.env*`, `id_*`, `.ssh/`, `.aws/`, `.gnupg/`, `.npmrc`, `.netrc`, `.pypirc`, `credentials`, key and certificate files, `.git-credentials`, `.git/config` rule the phone's file browser uses), still the same canonical linked file with a linked extension, and for an asset still inside the page's real folder with no dot-folder or dot-file in its real relative path.
- Text files (md, markdown, html, htm, svg, css, js, mjs, json, map, csv, txt) up to 1 MiB come as UTF-8 `content`; longer text is cut at 1 MiB (on a character boundary) with `truncated: true`. Text that is not UTF-8, and every other file, comes as `base64` up to 4 MiB; a larger file comes with no body and `truncated: true`. `mime` is always present (by extension, `application/octet-stream` when unknown); `mtime` is milliseconds since the epoch; `path` is the normalised path.

**`preview:fetch [sessionId, url, { method? }]`** → `{ url, status, contentType, headers, base64, truncated }`

- `url` is `http` or `https` to a loopback host, with no user info; `method` is `GET` (default) or `HEAD`; any other option is `option-denied`. The URL's origin must be one the chat linked.
- The computer connects to 127.0.0.1 or ::1 only: `localhost`, `127.0.0.1` and `0.0.0.0` go to 127.0.0.1 then ::1, `[::1]` to ::1. It never looks a name up in DNS and never uses a proxy. It sends the original `Host` (so dev servers that check it answer), `Accept: */*` and a `NekkoAgent-Preview` user agent; no body, cookies, credentials or headers from the phone. A local `https` server's certificate is not verified (dev servers use self-signed ones; the connection never leaves the computer).
- Redirects: up to 5, only within the same origin; any other redirect, and the sixth, comes back as the 3xx it is (`location` is not among the headers returned).
- 15 s for the whole fetch; at most 4 MiB of body, beyond which the body is cut and `truncated` is true.
- `headers` holds only `content-type`, `content-length`, `last-modified`, `etag` and `cache-control`. `url` is the final URL after redirects.

**Errors** are `code: message` from the computer (`not-found: no such chat`, `not-linked: this file was not linked in this chat`, `not-linked: this preview was not linked in this chat`, `secret-file: ...`, `not-a-file: ...`, `not-found: no such file`, `unreachable: nothing is answering at <origin>`, `timeout: ...`, `bad-request: ...`), or the gate's `Not allowed from a paired phone (<code>): <detail>`.

## Acceptance criteria

- A file linked in a chat's assistant message (absolute path, `file://` URL, or relative to the chat's folder) reads from a phone; the same file not linked in that chat is `not-linked`.
- A linked page's stylesheet, script, image and font in its own folder read; a file beside it outside that folder, one under a dot-folder, an executable, or a symlink that leaves the folder is refused.
- A secret file is refused, even when linked or reached through a symlink.
- A preview at a linked origin answers through 127.0.0.1 with the phone's `Host`, no cookies sent and none returned; an unlinked port or host is `not-linked`; an off-origin redirect comes back as a 3xx; a body over 4 MiB is cut; a hung server times out; nothing listening is `unreachable`.
- The TS and Rust gates screen the same calls the same way and project the same results (`phone-artifacts.json`).

## Privacy and security boundaries

- The scope is what the agent linked in that chat. A prompt-injected agent can link a file it can already read, and the phone can then read it; that is no more than the agent itself could show in its reply, and secret files are refused regardless. No general file access and no general proxy to the computer's network or loopback ports.
- Only loopback: the fetch never resolves a name and never reaches the LAN or the internet, so the phone can't use the computer to reach other machines (`image:fetch` stays refused).
- The phone's own headers, cookies and body never reach the dev server, and the server's cookies never reach the phone.
- Both channels are read class: the Read switch turns them off, and they are not written to the phone's activity list (reads never are).
- Filesystem checks resolve symlinks before reading, but are not an atomic sandbox against a concurrent local process replacing files or directories during the read.
- GET/HEAD restrict the HTTP method, not the behavior of the linked local service; a service can still have side effects on GET. No general claim of service-side read-only behavior is made.
- Caps keep every reply under the relay's 9 MiB frame (4 MiB of body is about 5.4 MiB of base64).

## Not yet

- The phone UI (tapping a link, rendering a page and its assets, a preview) landed separately on main; this backend PR does not verify it. Android not started.
- Not run from a device or over the managed relay. A daemon HTTP integration test seeds a chat with assistant messages on disk and exercises both channels, missing chats, user-only links and page assets. It does not exercise pairing or the encrypted relay; the phone gate is tested separately and held to the TS by golden cases.
