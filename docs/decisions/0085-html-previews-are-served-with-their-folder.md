---
status: accepted
date: 2026-11-11
---

# 0085. HTML previews are served with their folder, in an opaque-origin frame, offline by default

## Context

The file pane (and so Library) drew a local `.html` page by putting its text in a
`srcdoc` frame with `sandbox=""` and `default-src 'none'`. That keeps a page inert, but a
design the agent writes is rarely one file: it links `assets/style.css`, a script or two,
images and fonts beside it. None of those could load and no script ran, so most designs
opened as unstyled text. Philip asked for designs in Library to load, with a web server.

## Decision

- The host serves the page with its folder over HTTP (`@nekko-agent/profile/html-preview`):
  the desktop app's main process on 127.0.0.1, the Local Web UI server on its own host and
  a second port. Engine calls never carry it; the channels are `htmlPreview:serve` and
  `htmlPreview:release`.
- Each page gets an unguessable path prefix. Only files under its real folder are served,
  never a hidden file or folder, a secret-looking file (`phoneFilesSecret`) or a type off
  the web-asset list, and never through a link that leaves the folder. A page directly in
  a disk root or the home folder is refused.
- The renderer frames it with `sandbox="allow-scripts allow-forms allow-modals"`, never
  `allow-same-origin`. The page's origin is opaque, so it can read no cookie or storage of
  the app, even when the Local Web UI is on the same host. Files therefore carry
  `Access-Control-Allow-Origin: *` (the secret path is the capability), and HTML gets an
  in-memory `localStorage`/`sessionStorage` stand-in, since the real ones throw there.
- Every response carries a CSP that keeps the page on its own server. **Load from
  internet** re-serves the page with `https:` (and `wss:` for connections) added; never
  `http:`, so no other service on the computer becomes reachable. It is per preview and off
  again for the next file.
- Where nothing can serve the page (a relayed browser, an `https` front end, an `.svg`), the
  old scriptless `srcdoc` preview stays.

## Alternatives not taken

- **Serving from the engine (nekkod).** One implementation, but the Local Web UI would
  still need to proxy it onto a host the browser can reach, and the engine has no idea
  which host that is.
- **Serving on the UI's own origin** (a `/preview/` route in the Local Web UI). The page's
  scripts would share the app's origin and could call its API.
- **`allow-same-origin`.** Real storage for designs, but the page would share cookies with
  any app on the same host name, ports included.
- **Always online.** Designs that use a CDN would look right on first open, at the cost of
  every opened page reaching the network unasked.

## Consequences

Designs render as written. A CSP does not cover WebRTC, so a page's script could still
open a peer connection while "offline"; a page only ever sees its own folder, so what it
could send is limited to that. The isolated interactive window (`nekkoPreview.open`)
remains for the scriptless fallback.
