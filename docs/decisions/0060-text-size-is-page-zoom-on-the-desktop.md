# 0060: Text size is page zoom on the desktop

- Status: accepted
- Date: 2026-11-06
- Decided by: BobbyRobBob

## Context

Text size set CSS `zoom` on the root element. Under that zoom the app's coordinates
stop agreeing: `getBoundingClientRect()` and `clientX` are in zoomed pixels, `scrollTop`
and `window.innerWidth` are not, a `left` written back onto an element is zoomed a second
time, and `100vh` is taller than the window. Anything placed or scrolled from a measured
position was wrong at every size but 100%. Measured at 150%, Settings' section list
landed on the wrong section, its search box opened 209px from its button, and a box
placed from a rect landed 172px away. About 40 places in the renderer do this kind of
maths.

## Decision

The desktop app sets Chromium's page zoom (`webFrame.setZoomFactor`, through the
`nekkoChrome` bridge), the same as a browser's own zoom. Every coordinate then scales
alike, so none of those places needs to know about text size.

The Local Web UI cannot set page zoom from a page, so it stays on CSS `zoom`. Settings'
scrolling divides out the zoom (`zoomOf`) so that it is right on both.

## Consequences

- Media queries and `window.innerWidth` now see the zoomed size: at 150% a 1280px window
  lays out as an 853px one. Narrow layouts appear sooner, and a small window at a large
  size can need scrolling to reach the composer, which is how a narrow Focus wall
  already works.
- New code can measure and place in plain pixels on the desktop.
- In the Local Web UI, menus placed from a measured position can still land away from
  their button at sizes other than 100%.

## Alternatives

- **Correct each site for the zoom.** About 40 places, and every new menu or drag would
  have to remember it.
- **Scale with `rem`.** Most sizes in the app are fixed pixels, so this means converting
  the whole stylesheet.
