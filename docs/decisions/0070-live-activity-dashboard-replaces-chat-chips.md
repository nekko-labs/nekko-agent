---
status: accepted
date: 2026-11-08
---

# 0070. The Live Activity dashboard replaces chat chips

## Context

PR #2047 replaces the Live Activity surface while main gained tappable chat
chips (#1912). Combining the two would restore competing chat-specific actions
and focused-chat speech, undermining the dashboard's app-wide voice boundary.

## Decision

The user explicitly selected the status dashboard for #2047: counts for the
named computer, primary Talk to Nekko, and secondary Open app. It replaces the
resting chip UI and focused-chat mic at every enabled level. Approvals and chat
navigation belong in the app; separate actionable notifications are unchanged.
The Settings preview renders the dashboard. Preserve main's protocol, lifecycle,
security, localization and regression coverage where compatible.

## Consequences

- iOS 18+ uses an authenticated recording intent; iOS 17 opens the list without
  automatic capture. Android opens an unlocked foreground sheet and requires Listen.
- Initial command grammar remains English and deterministic; named-chat delivery
  requires exact confirmation. It is not a free-form assistant or approval executor.
- Minimal strips chat text from pushes; Standard/Detailed still permit it even
  though the view shows counts. Counts-only rendering is not transport privacy.
- The repair skips extra visual/device verification at the user's request, not
  required CI. Existing media remains historical, not evidence of the merged head.
  Native UI, accessibility, hardware microphone/authentication and real push
  limitations stay explicit in the [dashboard spec](../../spec/phone/live-card-status-dashboard.md).
