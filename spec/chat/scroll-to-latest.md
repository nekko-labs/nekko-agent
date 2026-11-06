---
title: Scroll to latest
area: chat
---

# Scroll to latest

Implemented in the shared desktop and Local Web UI transcript. Focused geometry tests, desktop typecheck and 18 isolated Electron interaction checks pass; visual inspection of the final evidence remains pending.

Readers browsing earlier messages need a way back to the newest message even when the conversation is idle or completed.

- A floating **↓ Scroll to latest** pill sits at the bottom center of the transcript, above the composer, whenever the transcript is unpinned from the bottom.
- It appears on scrolling up without waiting for new output. Existing bottom proximity tolerance remains unchanged.
- Clicking it returns to the latest message and resumes following new output. Returning manually also hides it.
- It stays hidden at the bottom and in an empty chat, and is contained at narrow widths.
- This reuses the existing transcript navigation and does not change stored messages, make requests, or collect data.
- Native iOS and Android are outside this shared-renderer change.

Regression command (from the repo root): set `NEKKO_LAYOUT_FIXTURE=transcript-scroll-fixture.tsx`, `NEKKO_LAYOUT_SANDBOX=scroll-latest-sandbox.cjs`, and `NEKKO_TEST_LABEL=after`, then run `node apps/desktop/scripts/layout-evidence-integration.cjs`. The fixture uses synthetic records, blocked network access and an isolated, non-focusable off-screen Electron window.
