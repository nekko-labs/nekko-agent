---
title: "Workspace context commands and connected composer"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Workspace context commands and connected composer

- Right-click chat workspace cards and saved-chat rows for a read-only session identifier labeled `Chat ID: <id>` (the label is not selectable; one click selects the whole ID for copying; implemented with isolated Electron checks and light/dark evidence), Open, Mark as completed, Change model, Stop, Continue, and permanent Delete. Delete bypasses Completed and asks for confirmation.
- Implemented: agent/chat `PaneFrame` top-right controls default to Complete using the existing archive flow (Completed retains chats until explicitly deleted). Settings > Appearance offers Complete or Delete; Delete always requires confirmation. Right-click the title bar for Complete, Delete, and non-destructive Close (only removes the window, preserving the chat). Other pane kinds retain Close. Focused handler/store tests cover these actions. Wide/narrow light/dark full-app screenshots were directly inspected; isolated fixture checks verified Complete, cancelled/confirmed Delete, and Agent-tab selection on 2026-10-06.
- Ctrl (or Command) toggles individual rows; Shift selects an inclusive range in visible sidebar order. Right-click a selected row applies commands to the selected chats. Stop skips idle chats, Continue skips running chats and uses non-destructive resume. Continue currently requires a saved specific model and an existing prompt; Auto chats ask the user to choose a model first. Failures are reported per chat.
- Composer model pickers and model-provider catalogs offer Set as default on right-click. The default is labeled and pinned first; a missing default remains visible but disabled. Model changes update mounted chat composers immediately.
- The composer uses 90% of the available pane width on desktop and full usable width on narrow screens. Questions extend from its upper center at 80% of composer width, with curved shoulders and no separate horizontal tray lines. They expand upward and retract on answer, with reduced-motion support.

## Per-chat information strip (implemented and renderer verified)

PR actions and model, effort, context, cost, and online/offline information are rendered below the chat composer in a per-session footer. Wall attention uses a slim local banner rather than an orange outer ring. The existing chat-type switch, dictation control and seasonal avatar are preserved when integrating the footer. Wide/narrow light/dark full-app screenshots and synthetic PR footer expand/tuck/dismiss behavior were directly inspected on 2026-10-06. Creation-time Image/Video selection and image/compact layout consolidation remain separate planned work; video generation is not implemented.

## Competitor follow-ups: implementation and verification
Running tool rows and collapsed activity groups show a conservative no-reported-progress duration after one minute. Updates occur at minute boundaries and hidden-pane timers pause. This is not a hang diagnosis. Renderer checks and inspected recording verify the one-minute boundary, expanded two-minute state, and reset on progress. Screen-reader verification is not claimed.
Mid-run failover has a tested, optional TS-loop hook and an Auto-pool-only selector foundation. It is not wired to production chats. Host pool verification, per-route usage accounting, exhaustion triggers, daemon support and context-budget checks remain unfinished. No automatic provider switch is enabled by this foundation.

Daemon HTTP response handling checks for malformed/non-JSON bodies and reports channel plus HTTP status without echoing raw bodies. Valid JSON API error envelopes remain supported. Focused response tests verified; the original desktop failure and upstream cause are not reproduced. No visual change.
