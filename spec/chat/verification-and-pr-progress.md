---
title: "Verification checklists and PR progress in chat"
area: chat
---

# Verification checklists and PR progress in chat

## User intent

A tool row that says `browser · dedicated` does not tell someone whether verification is advancing or stuck. Agent chats should expose the intended verification checks, which ones have actually passed, the device and current activity, and followable PR progress without opening a separate monitor.

## Implemented contract and presentation

Desktop and the shared Local Web UI renderer show a collapsible verification checklist above the footer PR dock whenever a plan is published. Steps explicitly tagged through `update_plan` carry pending, active, passed, failed, blocked or unknown verification reports. The summary is **n of n passed**, counting only explicit passed reports, never generic done or skipped plan steps, screenshots captured, browser actions returned or tool groups completed. Untagged plans display **Unknown: no checklist published**, not an invented checklist. The rows show the device, current detail (falling back to the plan note), report age and safe evidence links. The agent must publish and update these reports; this is not independent inspection certification.

Each report shows its own age. At two minutes it is labeled **Stale**, including a clear explanation that stale means no recent update, not proof the agent is stuck. Blocked and failed counts remain visible in the summary. Missing or invalid times are explicitly unknown. Disclosure and bounded scrolling keep the checklist usable in narrow agent windows.

The existing live PR action card adds linked CI and review-thread progress using the same deduplicated polling subscription and engine cache, not a second poller. It shows finished/total head checks, successful/neutral/skipped, pending, failing and unknown counts, plus expandable per-check states and follow links. Finished includes failures, so a finished denominator never implies success. A complete empty response means none reported; missing or partial data is unknown. Review counts are resolved/unresolved **threads**, not individual comments or approvals. CI links open the PR checks tab; thread links open the PR files tab. Local checked time is independent of GitHub's PR modification time and stale observations remain labeled.

## Boundaries and safety

- Read-only metadata is fetched with existing GitHub credentials and permissions. No new automatic actions, credentials or provider switching.
- New evidence/check links accept only HTTP(S) with no embedded credentials. GitHub tab links are constructed only from validated canonical GitHub PR paths.
- No tool-name or output-text heuristics certify visual verification.
- No mutation of user apps/devices is implied by a progress report. Device status is reported by the agent; it is not device telemetry.
- Native iOS/Android progress rendering is outside this initial shared-renderer scope. Older stored plans remain readable and unknown until explicit reports are published.

## Acceptance and verification status

Implemented with focused metadata persistence, validation, pagination, fallback/cache and renderer tests. Hidden isolated Electron fixtures cover the real checklist and PR card at 900px and 390px, active and updated passed/blocked/stale states, safe link destinations and disclosure interaction, with no document horizontal overflow. Matching base captures cover the prior PR card; the verification checklist is a new surface with no before state. PNG and GIF capture is not pixel inspection. Actual pixel/motion review and publication are pending and remain release blockers for the UI layer until recorded. Packaged-app, real paired-device flows, and native phone UI have not been verified.

Narrow PR cards (up to 480px content width, including narrow desktop panes) show CI and review content across the card width with wrapping actions on a separate row. Wider cards retain side-by-side actions. Verification report ages remain visible for all states, but only active/pending reports are labeled stale; passed, failed, blocked and unknown reports do not expire merely with age. PR polling staleness remains independent. Updated renderer captures require pixel inspection before visual signoff.
