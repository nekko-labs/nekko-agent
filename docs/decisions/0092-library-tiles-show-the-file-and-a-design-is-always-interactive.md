---
status: accepted
date: 2026-11-13
---

# 0092. Library tiles show the file itself, files that are gone drop out, and a design on the canvas is always interactive

## Context

Feedback on Library after the design canvas (#2697, #2723): previews were line art drawn
from a file's kind, never the file; a design such as `checkout-design-v2.html` did not
render; and the **Interact** switch was not obvious, so a prototype looked dead until it
was found.

The design that did not render was not on disk at all. Library listed every path a chat
named or wrote, and the chat that built the canvas named fixture paths that only ever
existed in a test's temporary folder.

## Decision

1. **A tile shows the file.** An HTML page runs on its tile, served by the same preview
   server and sandbox as every served page ([0085](0085-html-previews-are-served-with-their-folder.md)),
   offline, inert, shrunk from a desktop width, and paused once settled through the
   canvas's control script ([0091](0091-the-design-canvas-controls-a-served-design-over-postmessage.md)).
   It is served only when its tile nears the screen and released when the tile goes. An
   image shows as itself. Other kinds keep their drawing. This drops the earlier rule
   that Library reads no file to draw a tile.
2. **Files that are gone drop out.** Library lists the folder of each file a chat named
   (names only) and leaves out a file the folder does not hold. A folder that cannot be
   listed keeps its files.
3. **The canvas is always interactive.** The design takes clicks and hover from the
   start. The canvas moves by dragging the space around the design, by holding Space and
   dragging anywhere, and by scrolling or pinching anywhere: the control script passes up
   a scroll the page has no scroll box for, any pinch, and whether Space is held. The
   **Interact** switch is gone.

## Options considered

- **Thumbnails captured in the main process and cached** (an offscreen window per page,
  `capturePage`). Cheaper to show many, and nothing runs while browsing. Desktop only,
  needs a cache and its invalidation, and the Local Web UI would differ. Live, lazy,
  paused frames work in both today; capture can replace them if many tiles prove slow.
- **Keep the drawings and mark designs better.** Does not answer "I don't see previews".
- **Keep listing missing files, marked as gone.** A file that was never written is noise,
  and a phantom newer version stood in for a design's real newest one.
- **Interaction on, canvas moved only from its margins.** No way to move a design that
  fills the view. **Scroll always to the canvas.** Breaks a prototype's own scrolling
  list. **A modifier other than Space.** Space is what design tools use.

## Consequences

- More pages run while browsing Library: up to the tiles near the screen (8 per kind
  under Large icons), each paused after about a second. Not measured on a slow machine.
- The control script now also tells the canvas about scrolls, pinches and Space. The
  canvas caps a scroll step at 400 pixels and keeps the pointer inside the frame, so a
  hostile design can nudge or zoom the view within its limits, or hold drag mode until
  Space is pressed and let go in the app, and nothing more.
- Library lists more folders: each chat file's folder, names only.
- A hidden test window cannot drive a real click into a cross-origin frame (nothing is
  painted, so the browser has no hit-test data for it); the journey checks the hit test
  on both sides instead.
