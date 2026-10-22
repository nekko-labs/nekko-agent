---
title: "Wall push and navigation shoulders"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Wall push and navigation shoulders

Implemented; 1,241 desktop tests, 18 launcher checks, desktop typecheck and production build pass. Matched isolated light/dark wide/narrow renderer captures and sampled motion frames inspected; native chrome and packaged macOS not tested. Opening an agent window reveals only the incoming window from its outer edge while existing windows slide to their new positions. Existing windows take their final width and height immediately, without a second top-left resize animation. Closing folds and reduced-motion behavior remain unchanged. Navigation shoulders begin 10px beyond the icon rows (compressed proportionally in short windows) and mirror at both ends. These visual changes add no host calls, permissions, network access or persisted settings.
