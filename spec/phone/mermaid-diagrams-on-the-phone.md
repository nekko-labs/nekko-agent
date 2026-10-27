---
title: "Mermaid diagrams on the phone (iPhone implemented 2026-10-25; Android planned)"
area: phone
---

# Mermaid diagrams on the phone (iPhone implemented 2026-10-25; Android planned)

**User intent:** Philip asked (2026-10-25) for Mermaid diagrams to render on the phone. Tasks MM-1 to MM-4 in [TASKS.md](../../TASKS.md).

**Status `[MM-1 to MM-3 implemented and verified on the macOS CI simulator (Native iOS run 40198943879 (Xcode 16.2, iPhone simulator on iOS 18.2)); MM-4 Android planned]`.** `MermaidRules` (`apps/ios/Protocol/Sources/NekkoProtocol/Mermaid.swift`) holds fence detection, the streaming rule, the size cap and the cache key, with `MermaidRulesTests` passing on Linux. `apps/ios/App/Views/Mermaid.swift` has the renderer, the inline diagram and the full-screen view; the bundled script is `vendor/mermaid` (Mermaid 12.2.0, the version `package-lock.json` resolves for the desktop, pinned by `scripts/vendor-mermaid.mjs`). The UI test `MarkdownTests.testDiagramsDrawAndABrokenOneFallsBack` draws a flowchart, a sequence diagram and a broken diagram on the Debug-only fixture screen and checks that the renderer's page cannot reach the network. Verified there in light and dark: both diagrams drew, the broken one showed its source with Mermaid's error, full screen opened with its actions, and a `fetch` from the renderer page was blocked. Not exercised by a test: *Share image*, *Save to Photos*, `.mmd` files from *Files*, the 5-second and 50,000-character fallbacks on a device, and a run with the device's network switched off (the probe shows the page itself cannot load anything). Before this work, the desktop and Local Web UI already draw a ```` ```mermaid ```` fence as a diagram. They use the `mermaid` package in a strict, sandboxed frame with Copy, Expand and a source fallback (`ArtifactPreview.tsx`, [Rich replies](../code/rich-responses-reports-and-design-workspace.md)). The phones show the fence as a code block. The shared system prompt (`crates/nekko-context/src/prompt.rs`, "Rich replies in chat") already tells the model that chat renders Mermaid inline, so phone users currently get diagram source where they were promised a picture.

The isolated stack run at `59570f8f` also passed the light/dark diagram tests (Xcode 27.1, iOS 26.5). The archived light-mode source/flowchart before/after pair was historically visually inspected. Current captures and motion clips still require visual inspection; current integration CI remains pending.

## What the user gets

- **The diagram appears inline.** A ```` ```mermaid ```` fence in a reply, or in the user's own message, shows as the drawn diagram, scaled to the bubble's width. It uses the app's light or dark theme and redraws when the theme changes.
- **Tap to open full screen.** The diagram opens with pinch-zoom and pan, and has *Copy source*, *Share image* (PNG), *Save to Photos* and *Show source*.
- **While a reply is still streaming**, the fence shows as source with a quiet *Drawing when the reply finishes…* line. The diagram is drawn once the fence closes, never once per token.
- **When a diagram fails to parse**, the fence falls back to its source code block with Mermaid's one-line error above it. The rest of the reply is unaffected.
- `.mmd` and `.mermaid` files opened from *Files* use the same view.

## How it works (planned design)

- `mermaid.min.js` (the same major version as the desktop, 12.x) is bundled in the app; nothing is fetched. One shared, off-screen `WKWebView` renderer is created on first use. It has JavaScript enabled only for the bundled script, the non-persistent data store, a content rule list that blocks every network load, and a navigation delegate that refuses all navigation. Mermaid runs with `securityLevel: 'strict'` and `htmlLabels: false`.
- **Rendering goes through a queue**, one diagram at a time, as on the desktop. The result is an SVG string, which is drawn onto a canvas in the same locked page (its only allowed load is that `data:` image) at the screen's scale and then cached in memory and on disk with its SVG, keyed by source, theme, width step and the bundled Mermaid's version. Scrolling past a diagram never re-renders it, and reopening a chat shows cached diagrams immediately.
- **The SVG is never shown in a live web view in the transcript.** The bubble shows the image, so a long chat holds no web views. Only the full-screen view displays the SVG for crisp zoom, in a web view with JavaScript off and loads blocked.
- **Cost:** the bundled `mermaid.min.js` is 5,494,801 bytes (measured, Mermaid 12.2.0; the plan guessed about 3 MB). Diagrams are drawn at the bubble's width rounded down to 40-point steps, so the cache key holds a width step rather than a size class. It is loaded lazily, so a chat without diagrams never starts it. Render time per diagram is measured and logged in [perf history](../../docs/perf-history.md) when this ships.

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
