---
title: Settings breadcrumb back to Agents
area: desktop
---

# Settings breadcrumb back to Agents (#3122)

User intent: return from Settings directly to Agents. This is a navigation addition, not a Settings layout redesign.

## Behavior and acceptance

- Show a quiet **← Agents / Settings** breadcrumb in the existing Settings navigation rail only. Do not add a shell-wide row or breadcrumbs to other destinations.
- Preserve the Settings content column, widths, padding, section arrangement and scrolling. Content geometry must match the unchanged baseline at desktop, narrow/folded and unfolded web widths.
- Agents is a translated native button that selects the existing Agents destination, not browser history. Keyboard activation works and preserves the selected chat and wall preferences. Settings is marked as the current page.
- Existing Settings section navigation, search and page-specific Back controls remain unchanged. Use existing theme tokens and button feedback, including touch targets.
- Privacy/security: local view selection only. No API calls, credentials, permissions, settings writes, chat mutations or external side effects.

## Status

Implemented in the shared desktop/Local Web UI renderer. All 18 focused tests, desktop typecheck and 48 hidden full-App assertions pass, including exact baseline content geometry at 1440, 390 and 840 CSS pixels and real Enter activation. A raw RGBA comparison of the Settings content region finds zero changed pixels at all three widths. This proves content preservation, not visual approval of the new rail control. Earlier all-page evidence is superseded. Matched Settings captures are available, but the image tool does not expose viewable pixels in this session. Actual visual review remains a release blocker. Native iOS/Android navigation is unchanged. Installed builds and live Local Web UI hosting are unverified.

Design: [Settings breadcrumb v2](../../nekko-designs/agents-back-breadcrumb-design-v2.html).
