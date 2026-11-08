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

## iPhone: a chat opens on its latest message (2026-11-08)

User intent: opening a chat shows its newest messages straight away, without having to touch the screen.

- Bug: opening a chat on the iPhone could show an empty transcript (the composer and plan card drawn, no messages) until the reader scrolled even slightly, then the messages appeared. The transcript is a lazy stack in a bottom-anchored scroll view. When it arrived in one go after the empty chat was laid out (or a re-read replaced it), the jump to the end happened in the same update as the new rows, before the stack had built the rows at the end.
- Fix: whenever rows are added or replaced (not a streamed token) while the reader is at the end, and when a chat opens with its saved copy already there, the transcript scrolls to its end again after layout (about 30 ms, then 150 ms, never animated). Scrolling to the end marker makes the stack build the rows there. Streamed tokens follow as before; a reader in the history is not moved.
- Acceptance: a long chat whose transcript arrives a second after it opens shows its last message and the one above it on screen with no touch. The keyboard, approval and question cards keep the latest message above them as before.
- Regression: `ChatRefreshTests.testALateTranscriptShowsItsEndWithoutScrolling` (fixture flag `-refreshSlowFirstRead`), run by the Native iOS workflow. Status: implemented. Whether the new UI test fails on the old code has not been checked yet, and the fix has not been seen on a device. Android's chat list is not known to have the problem and is unchanged.
