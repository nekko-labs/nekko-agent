---
status: accepted
date: 2026-11-13
---

# 0091. The design canvas controls a served design over postMessage, through a script the preview server adds

## Context

Library opens a design on a canvas (#2696): the whole page at its full size, with zoom,
versions, and Play and Pause when the design moves. Two of those need something from
inside the page: how big it is, and a way to hold its motion.

The page is untrusted HTML an agent wrote. [Decision 0085](0085-html-previews-are-served-with-their-folder.md)
serves it with its folder and frames it with `sandbox="allow-scripts allow-forms allow-modals"`
and no `allow-same-origin`, so its origin is opaque: the app cannot reach into the frame,
and the frame cannot reach the app. That wall has to stay.

## Options considered

1. **A script the server adds, spoken to over `postMessage`.** The server already adds a
   storage stand-in to every served page. One more inline script answers three words
   (`probe`, `pause`, `play`) with a few numbers. Works in the desktop app and the Local
   Web UI alike, and holds CSS animations, Web Animations, `requestAnimationFrame` loops
   and media. Cost: the page is modified, and a hostile page can lie in its answers.
2. **Drive the frame from the Electron main process** (`webFrameMain.executeJavaScript`,
   or the DevTools protocol's `Animation.setPlaybackRate`). Nothing is added to the page,
   and the protocol can pause everything. Desktop only: the Local Web UI has no such
   handle, and the two would behave differently.
3. **Freeze from outside with CSS** (`animation-play-state` cannot be set across the frame
   boundary) or by swapping the live frame for a screenshot. No way in without the
   script; a screenshot is not a pause, and resuming would restart the design.
4. **Give the frame `allow-same-origin`** and reach in directly. Simplest code, and it
   removes the wall: the page would share an origin with the preview server, and in the
   Local Web UI with the app's host.
5. **Ask designs to implement a contract themselves** (expose `play`/`pause`). Right for a
   published design format one day; today no design does, and Pause would do nothing.

## Decision

Option 1. The preview server adds the control script only when a page is served with
`controls: true`, which only the design canvas asks for. The script answers only its
parent frame, replies with running or paused animations, media elements, animation
frames so far, a paused flag and the page's scroll size, and reads nothing else. The
canvas posts only the command word, listens only to its own frame's window, and reads
only non-negative numbers and one boolean from a reply.

A design can therefore misreport its size (bounded to 8000 by 12000) or show a Play
button that does nothing. It gains no access it did not have.

## Consequences

- Pause holds what the platform exposes: the document's animations, media that was
  playing, and frame callbacks. Motion driven by `setTimeout` or `setInterval` alone
  keeps running and is not detected.
- The page's size is taken once per load, since a page sized in viewport units would
  grow with each answer.
- Every host that serves previews gets the canvas with no host-specific code.
- If an open design-file format defines its own playback contract (option 5), the
  canvas should prefer it and keep this script as the fallback.
