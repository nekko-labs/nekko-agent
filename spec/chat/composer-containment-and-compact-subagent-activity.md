---
title: "Composer containment and compact subagent activity (2026-10-13)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Composer containment and compact subagent activity (2026-10-13)

Implemented and renderer-verified in PR #515; landing pending final documentation checks. The wall composer grows with new and wrapped draft rows, including queued prompts, attachments, skills and footer controls. A bottom-docked composer expands upward in normal layout and reserves space by reducing the board area, rather than covering agent windows. Deleting text shrinks it. Saved manual height remains a preference, not a hard ceiling that clips content. At a viewport-aware height cap only the draft editor scrolls: the composer shell and body never own another scrollbar, and text stays inside the composer ring. Top docking retains normal layout behavior.

Delegation activity is compact and collapsed by default while sending tasks or receiving large results. Its chat headline and subagent lists share a bounded plain-text, one-sentence activity summary and event-derived Working, Waiting, Completed, Failed or Stopped status. Questions/approvals override working status; terminal status is not inferred solely from a stored reply. Full task/result details remain available on explicit expansion with bounded scrolling. Summaries use existing local events and introduce no additional model calls or network disclosure. Ambiguous child associations must not display another child's status. This does not forcibly resize a user's entire agent pane.

Acceptance includes multiline/wrapping/long-token drafts, queued messages and attachments, manual sizing, shrink/cap and board displacement, plus synchronized child status transitions and large collapsed results. Matched isolated light/dark wide/narrow renderer evidence and typing motion are required. User screenshots are reference evidence, not implementation verification. Verified: 952 desktop tests, desktop typecheck/build, and 96 isolated renderer assertions with inspected matched light/dark wide/narrow captures and typing frames. Published media URLs were verified. Native macOS/Linux interaction and live-provider integration remain untested. Child identity is best-effort parent/title/creation timing; historical or ambiguous matches remain unknown until the transport provides an authoritative child ID.
