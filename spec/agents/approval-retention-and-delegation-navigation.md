---
title: "Approval retention and delegation navigation"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Approval retention and delegation navigation

Implemented: a tool result clears only its matching pending chat approval; unrelated results no longer hide a waiting request. The existing transcript/full approval surface and composer-only exclusion remain unchanged. Observed, unambiguously associated subagents have a separate keyboard-accessible Open control beside the details toggle in activity groups and tool cards; it uses the existing workspace pane opener without rearranging existing panes. Ambiguous or unobserved delegation associations deliberately have no link. Focused tests and hidden isolated full-ChatPane fixtures verify event retention, hydration and store navigation. Open remains within the narrow viewport beside a shrinkable details toggle. Parent review inspected the actual matching light/dark 1200px and 390px baseline/patched pixels, confirming retained approvals and unclipped Open controls. Packaged/native-window verification remains unverified; the fixture uses synthetic local bridge events.
