---
title: "Experimental outbound resource queue"
area: automation
split-from: SPEC.md (2026-10-22)
---

# Experimental outbound resource queue

An off-by-default developer experiment adds a manual coordinator section to Model Server. Register a local resource, inspect jobs, explicitly claim one and open its prompt in a new agent chat. Explicitly submit the final reply as untrusted output, never automatic approval. See docs/resource-queue.md for security and deployment gates.

## Chat PR ownership
PR cards and session PR links track only successful PR creation calls made in that chat. Mentioned URLs, reviews, status lookups, edits and failed creations do not attach PRs. Ordinary message links remain clickable. Historical chats without creation evidence do not claim ownership.

## Composer-connected PR deck
Live PR actions appear in a centered deck emerging from the divider between the chat and footer controls. The deck reserves layout space and never overlaps those controls. Open or draft PRs expand the deck automatically; when all tracked PRs are merged or closed, a collapsed count and resolved-status summary remains without action buttons. Manual expansion lasts only while the tracked PR statuses remain unchanged. Dismissed cards retract before removal. Reduced-motion users get effectively instant transitions. Transcript creation/merge milestones remain separate. Implemented in a draft change. Desktop typecheck and 15 focused tests pass. Isolated synthetic fixture geometry and open/merged/reopened checks pass at 1200 and 700 px in light and dark themes. Matching screenshots and recordings are captured, but screenshot pixels and video motion have not been inspected; visual acceptance remains pending. Real host/provider integration, native window chrome, and other platform behavior are unverified. `[updated 2026-10-16]` The deck now opens **upward**: it sits above the footer strip as a tab whose open bottom edge rests on the strip's top divider, the "N pull requests / Show actions" toggle stays on that divider, and the PR cards stack above it (the chevron points up when collapsed, down when expanded). It used to hang below the divider and open downward into the controls. In the wall composer, where there is no strip below, it closes into a standalone rounded card (`floating`). Verified with focused render tests (cards precede the toggle) and isolated hidden-Electron before/after captures of the real `PrActionDock` in light and dark, expanded and collapsed, inspected by the agent; the live app with real PRs was not exercised.
