---
title: "Mermaid diagrams on the phone (planned 2026-10-25)"
area: phone
---

# Mermaid diagrams on the phone (planned 2026-10-25)

**User intent:** Philip asked (2026-10-25) for Mermaid diagrams to render on the phone. Tasks MM-1 to MM-4 in [TASKS.md](../../TASKS.md).

**Status `[planned; nothing implemented]`.** The desktop and Local Web UI already draw a ```` ```mermaid ```` fence as a diagram. They use the `mermaid` package in a strict, sandboxed frame with Copy, Expand and a source fallback (`ArtifactPreview.tsx`, [Rich replies](../code/rich-responses-reports-and-design-workspace.md)). The phones show the fence as a code block. The shared system prompt (`crates/nekko-context/src/prompt.rs`, "Rich replies in chat") already tells the model that chat renders Mermaid inline, so phone users currently get diagram source where they were promised a picture.

## What the user gets

- **The diagram appears inline.** A ```` ```mermaid ```` fence in a reply, or in the user's own message, shows as the drawn diagram, scaled to the bubble's width. It uses the app's light or dark theme and redraws when the theme changes.
- **Tap to open full screen.** The diagram opens with pinch-zoom and pan, and has *Copy source*, *Share image* (PNG), *Save to Photos* and *Show source*.
- **While a reply is still streaming**, the fence shows as source with a quiet *Drawing when the reply finishes…* line. The diagram is drawn once the fence closes, never once per token.
- **When a diagram fails to parse**, the fence falls back to its source code block with Mermaid's one-line error above it. The rest of the reply is unaffected.
- `.mmd` and `.mermaid` files opened from *Files* use the same view.

## How it works (planned design)

- `mermaid.min.js` (the same major version as the desktop, 12.x) is bundled in the app; nothing is fetched. One shared, off-screen `WKWebView` renderer is created on first use. It has JavaScript enabled only for the bundled script, the non-persistent data store, a content rule list that blocks every network load, and a navigation delegate that refuses all navigation. Mermaid runs with `securityLevel: 'strict'` and `htmlLabels: false`.
- **Rendering goes through a queue**, one diagram at a time, as on the desktop. The result is an SVG string, which is snapshotted to an image at the screen's scale and then cached in memory and on disk, keyed by source, theme and width class. Scrolling past a diagram never re-renders it, and reopening a chat shows cached diagrams immediately.
- **The SVG is never shown in a live web view in the transcript.** The bubble shows the image, so a long chat holds no web views. Only the full-screen view displays the SVG for crisp zoom, in a web view with JavaScript off and loads blocked.
- **Cost:** the renderer adds about 3 MB to the app. It is loaded lazily, so a chat without diagrams never starts it. Render time per diagram is measured and logged in [perf history](../../docs/perf-history.md) when this ships.

## Boundaries

- Diagram source never leaves the phone, and the renderer cannot reach the network. Clicks and links inside a diagram are ignored (strict mode, no navigation).
- A diagram whose source exceeds 50,000 characters, or whose render takes over 5 seconds, falls back to source with *Too large to draw on the phone*.
- VoiceOver reads *Diagram, flowchart* (or the diagram type) and offers *Show source*.
- Android (MM-4) follows the same design with a bundled script in a locked `WebView`.

## Acceptance

- Unit tests (Linux) cover the fence detection, the cache key, the streaming rule (no render before the fence closes) and the size cap.
- On macOS CI, a UI test renders a flowchart, a sequence diagram and a broken diagram, in light and dark. Their screenshots appear in the PR.
- An offline check confirms that rendering works with the network off.
- Status stays *planned* or *unverified* until the app has run on a simulator.
