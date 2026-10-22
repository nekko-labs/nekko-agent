---
title: "Per-step plan working icons (2026-10-17)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Per-step plan working icons (2026-10-17)

Implemented with focused component coverage: Agent Monitor displays a static spoke-style Working icon for every active plan step independently, including multiple simultaneous active steps. Token streaming is not required: tool work and parallel work still count. An explicitly interrupted last reply with no running turn displays pause bars labeled Paused on active entries instead. Resuming a live turn takes precedence over interruption history. Done keeps its check, pending is a hollow circle, and skipped uses a slashed circle and struck-through title. Each status has an accessible label and tooltip. No animation or new data, network, or permission access is introduced. Hidden isolated Electron before/after captures cover 240px and 360px rails, light/dark, working/interrupted states; The initial evidence had invalid theme matching and is superseded by v2 captures from unchanged base e9ecabda and the implementation. Each capture uses a fresh isolated profile, requested theme before mount, asserted computed background/text colors and a captured background pixel. Parent actual-pixel inspection of browser-owned corrected v2 screenshots approved the affected surface: matching working 240px before/after pairs in dark and light show two legible, unclipped Working icons; paused 240px dark/light pairs show two correct pause icons; working 360px light is also visible. Signoff covers these inspected cases, not every captured case. Evidence uses synthetic hidden Windows Electron fixtures, not a packaged build or native-window verification; packaged/native platform behavior remains unverified.
