---
title: Settings breadcrumb back to Agents
area: desktop
---

# Settings breadcrumb back to Agents (#3122)

User intent: return from Settings directly to Agents. The breadcrumb sits in the main content area, not the navigation rail.

## Behavior and acceptance

- Show a quiet **← Agents / Settings** breadcrumb at the top of the Settings content column, above the current section. It scrolls with the page. Do not add a shell-wide row or breadcrumbs to other destinations.
- The rail, column widths, padding, section arrangement and scrolling are otherwise unchanged; sections start one breadcrumb row lower.
- Agents is a translated native button that selects the existing Agents destination, not browser history. Keyboard activation works and preserves the selected chat and wall preferences. Settings is marked as the current page.
- Existing Settings section navigation, search and page-specific Back controls remain unchanged. Use existing theme tokens and button feedback, including touch targets.
- Privacy/security: local view selection only. No API calls, credentials, permissions, settings writes, chat mutations or external side effects.

## Status

Implemented in the shared desktop/Local Web UI renderer, in the Settings content column (moved from the rail on Philip's request, 2026-11-22). The hidden full-App sandbox checks placement in the content column, absence elsewhere and real Enter activation at 1440, 390 and 840 CSS pixels. Native iOS/Android navigation is unchanged. Installed builds and live Local Web UI hosting are unverified.
