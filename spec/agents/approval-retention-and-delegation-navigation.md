---
title: "Approval retention and delegation navigation"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Approval retention and delegation navigation

Implemented: a tool result clears only its matching pending chat approval; unrelated results no longer hide a waiting request. The existing transcript/full approval surface and composer-only exclusion remain unchanged. Observed, unambiguously associated subagents have a separate keyboard-accessible Open control beside the details toggle in activity groups and tool cards; it uses the existing workspace pane opener without rearranging existing panes. Ambiguous or unobserved delegation associations deliberately have no link. Focused tests and hidden isolated full-ChatPane fixtures verify event retention, hydration and store navigation. Open remains within the narrow viewport beside a shrinkable details toggle. Parent review inspected the actual matching light/dark 1200px and 390px baseline/patched pixels, confirming retained approvals and unclipped Open controls. Packaged/native-window verification remains unverified; the fixture uses synthetic local bridge events.

## A sub-agent's wait shows on its parent chat (#3270)

Intent: when a sub-agent stops to ask (an approval, a question or a secret), the chat that started it says so, so the run does not look busy while it waits on the person.

Implemented:
- A sub-agent's row (the delegation row in the transcript, the plan tray's agent cards, Agent Monitor and the working sub-agents chip) says "Waiting for approval." (or "Waiting for your answer." / "Waiting for a secret.") until that request is answered, the run ends, or the chat stops. A later event from the same sub-agent, such as a sibling tool's result, no longer replaces it.
- Waits already open when a window starts are read from the host's pending inputs, because the engine does not resend them.
- While any sub-agent below the chat waits (children and their own sub-agents), a line above the composer reads "Sub-agent “<title>” is waiting for your approval." with an Open button that opens that sub-agent's chat. With several waiting it gives the count and opens the first one, approvals first. The line steps aside while the chat itself waits on a question or an approval.

Verified by unit tests with synthetic events (a sibling result after the request, the request as the child's first event, launch seeding, grandchildren). Not yet verified in the packaged app with a live sub-agent.
