---
title: Agents back breadcrumb
area: desktop
---

# Agents back breadcrumb (#3122)

User intent: return from any other page directly to the Agents view without finding the navigation rail.

## Behavior and acceptance

- The shared desktop and Local Web UI shell shows a quiet **← Agents / Page** breadcrumb above every non-Agents destination: Library, Skills, Training, Automations, Design, Models (including the Model Server alias), Connectors, Memory and Settings.
- **Agents** is a keyboard-accessible native button that selects the existing Agents destination, not browser history. It leaves the selected chat and wall preferences unchanged. It is absent on Agents itself and does not change first-run setup navigation.
- The final crumb names the current destination using existing navigation translations, with Models for the Model Server alias. It is marked as the current page. Existing Back to Settings, Back to Library and other local navigation remain available.
- The breadcrumb stays outside page scrollers, uses existing theme tokens and quiet button feedback, fits desktop/narrow/folded and unfolded web widths, and truncates a long destination instead of pushing the return button off-screen. Touch uses the existing 44px button target.
- Privacy/security: local view selection only. No API calls, credentials, permissions, settings writes, chat mutations or external side effects are added.

## Status

Implemented in the shared renderer. All 18 focused component/navigation tests, desktop typecheck, desktop/web builds and hidden full-App return-navigation/layout assertions pass at 1440, 390 and 840 CSS-pixel widths. Matched before/after screenshots are captured; actual pixel review is pending and remains a release blocker. Native iOS/Android navigation is unchanged; this is the desktop/shared-web page shell, not a native phone feature. Installed builds and live Local Web UI hosting are unverified.

Design: [Agents back breadcrumb](../../nekko-designs/agents-back-breadcrumb-design.html).
