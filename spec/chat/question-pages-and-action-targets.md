---
title: "Question pages and comfortable action targets"
area: chat
---

# Question pages and comfortable action targets

Tracked by #2079 (CTA sizing) and #2082 (questions and visible replies).

## Implemented in this change

- Shared desktop (macOS, Windows, Linux) and Local Web UI `.btn` controls reserve a real 44 × 44 CSS-pixel minimum layout target. Composer attachment, dictation, send/stop, and question option/navigation controls use the same minimum without enlarging their glyphs. Expanded dictation still collapses to a 44px target.
- The native desktop caption/titlebar strip remains a compact chrome exception; these are not primary CTAs. This does not claim every bespoke icon in the app has been audited.
- Desktop/web, iOS, and Android show one question per page. A compact Back icon is at the top left, the page count in the middle, and Skip at the top right. Back is disabled on the first page. The bottom action is Next, then Send answers on the final page.
- Back retains picks and free text. Skip clears only the current page and advances; on the last page it submits answers from all other pages. Skipped questions are omitted from the answer payload and the host formats them as `(not answered)`. Skipping every page resolves the request with an empty answer list.
- Existing single-select, multi-select, free-text, and desktop keyboard entry remain supported. There is no jump-to-page dot row exposing later questions.
- A sending card disables submission and preserves its data if the host rejects the answer. A failure presents a retryable error instead of dismissing the card. Resolved calls do not clear a newer question.
- iOS Back/Skip retain 44pt hit targets; Android uses 48dp navigation targets.

## Answer visibility

See [Clarification answers remain visible](clarification-answers-remain-visible-in-chat.md). Desktop live turns now project the same literal answer row as saved messages, so live-tail replacement cannot hide it. Projection is deduplicated by tool call and survives replay, retry, and settlement; it adds no model-facing message.

Native phone transcript outputs are projected after saved/live reconciliation, not fed back into the prompt-merge reducer. Successful `ask_user` outputs with the expected complete wrapper become literal user-style answer rows; failed, unrelated, orphaned, and incomplete results do not. Projected rows cannot be fork/edit anchors. Valid long answer output is not clipped by the ordinary 4,000-character tool-detail cap before projection. The existing relay transport cap still applies.

## Verification status

- Windows hidden Electron fixture: live answer visibility, one mounted question, Back preservation, per-question Skip, final payload, 44px bounds, padded-edge input, and no question-panel horizontal overflow at 1100/390 CSS-pixel widths in dark/light themes. Matched before/after PNGs are captured from real components with synthetic state and a network-blocked bridge.
- Shared TypeScript unit/type checks cover live/saved answer behavior and card markup. Native protocol/form regressions cover literal output, merge/reopen behavior, long notes, and skip state.
- **Pending:** visual inspection of captured images (image tools failed in the implementation session), native iOS/Android builds and page-navigation/device evidence, and an actual macOS runtime reproduction/confirmation. Shared-code test success is not a macOS or native-device visual sign-off.
