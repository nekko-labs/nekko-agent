---
title: "Per-step plan working icons (2026-10-17)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Per-step plan working icons (2026-10-17)

Implemented with focused component coverage: Agent Monitor displays a static spoke-style Working icon for every active plan step independently, including multiple simultaneous active steps. Token streaming is not required: tool work and parallel work still count. An explicitly interrupted last reply with no running turn displays pause bars labeled Paused on active entries instead. Resuming a live turn takes precedence over interruption history. Done keeps its check, pending is a hollow circle, and skipped uses a slashed circle and struck-through title. Each status has an accessible label and tooltip. No animation or new data, network, or permission access is introduced. Hidden isolated Electron before/after captures cover 240px and 360px rails, light/dark, working/interrupted states; The initial evidence had invalid theme matching and is superseded by v2 captures from unchanged base e9ecabda and the implementation. Each capture uses a fresh isolated profile, requested theme before mount, asserted computed background/text colors and a captured background pixel. Parent actual-pixel inspection of browser-owned corrected v2 screenshots approved the affected surface: matching working 240px before/after pairs in dark and light show two legible, unclipped Working icons; paused 240px dark/light pairs show two correct pause icons; working 360px light is also visible. Signoff covers these inspected cases, not every captured case. Evidence uses synthetic hidden Windows Electron fixtures, not a packaged build or native-window verification; packaged/native platform behavior remains unverified.

## Explicit verification reports

Implemented plan contract: `update_plan` accepts optional verification metadata on a step: `status` (`pending`, `active`, `passed`, `failed`, `blocked`, `unknown`), device, current activity/detail and a safe evidence URL. Metadata persists in the existing session plan and updates by step id. Generic plan statuses remain unchanged. A generic `done` or successful screenshot/browser tool return must never count as a verification pass. Only an explicit inspection report with verification status `passed` counts.

The tool's guidance asks the agent to publish the verification checklist before starting, report the device and current activity, update it during the flow, and keep missing inspection unknown or blocked. This is agent-reported status, not an independent certification. Invalid metadata is ignored safely; device/detail are bounded and credential-bearing or non-HTTP(S) evidence URLs are dropped. Existing steps without metadata retain their legacy behavior and exact serialized golden outputs. Freshness uses the step's existing update time. Renderer presentation and actual pixel inspection are handled in the following UI layer.
