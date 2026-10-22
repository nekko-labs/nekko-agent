---
title: "Agents dashboard simplification (2026-10-06)"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Agents dashboard simplification (2026-10-06)

Implemented and verified with isolated Windows Electron interactions and inspected matching light/dark, wide/narrow captures: Command Center is renamed Agents, with a stationary navigation cat. The former Agents workspace is Chat and is default-hidden behind Developer → Show Chat workspace. This is preparation for unification, not a merged workspace implementation. The corner mascot is blank-faced by default and occasionally opens/blinks; motion cycles are less frequent and respect reduced motion and hidden pages.

Utilization removes the outdated-quota note and offers an accessible refresh icon, requesting an authorized provider poll while retaining the 30-second provider throttle and showing errors. Composer removes its external-arrow shortcut and duplicate context/cost indicators; those stay in agent windows. Window Focus shortcut is removed; selection remains click-based. Online is a green indicator button toggling the owning session offline flag, without authorizing network use or changing other sessions. Hardware contains only CPU/memory/GPU/VRAM monitors. Dock Insights suppresses cost, savings/optimization, and model-cost details because Budget owns them. Side-dock panel headers support drag reorder and Alt+ArrowUp/Down; normalized order persists with existing settings and browser fallback.

Acceptance: matched main/current captures and sampled mascot/reorder motion frames were inspected. Chromium pointer drag/drop, saved keyboard ordering, owning-chat offline payloads and explicit provider refresh payloads pass isolated Electron checks. Grid and Fixed use available viewport height; Grid preserves saved splits and its separate scrollable Add row, with the same Add cell size as Fixed. The performance fixture uses the Agents navigation label and explicitly enables the optional Chat workspace; performance budgets remain unchanged. Provider refresh keeps existing credential boundaries; sandbox verification uses synthetic records and no external connections. Command Logs now disclose missing/failed snapshots and reactivate when commands append after a finished turn. New command output is persisted asynchronously beside session JSON; previously lost output cannot be recovered.
