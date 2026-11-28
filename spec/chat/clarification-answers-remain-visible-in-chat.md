---
title: "Clarification answers remain visible in chat"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Clarification answers remain visible in chat

Implemented, verification in progress: replies submitted through ask_user appear as visible user-facing Q/A transcript rows at the saved tool result's chronological position, including existing chats when reopened. Selected labels and freeform notes stay literal; skipped or unattended questions show an explicit unanswered state. Pending, failed, malformed and unrelated tool results do not invent a user response. Model-facing answer wrapper instructions remain hidden. This is a display-only projection of existing stored history, not a duplicate user message or a change to model context. Projected replies support ordinary text copying but cannot edit, rewind, split or reuse a nonexistent persisted user-message ID. Acceptance requires focused transcript tests and isolated matched before/after evidence. Parent inspection of the original contact sheet and narrow light capture confirmed visible chronological Q/A and honest skipped/unattended states. Current-main integration preserves compact delegation and composer containment; 957 desktop tests across 142 files, desktop typecheck, production app build and 52 real-renderer assertions passed after integration. Fresh matched integration captures were inspected in narrow light/dark; original wide/narrow contact sheet was inspected. Optimized transcript projection passes 958 desktop tests; fresh hosted integration gates remain pending. PR #512 remains draft and unmerged during this handoff; live-provider and cross-platform verification remain unverified.

## Live turns and native phones (#2082)

Implemented in the current change: the shared renderer projects the same literal answer row in live turns, deduplicated by tool-call id and retained through replay, retry and settlement. Native iOS/Android project successful wrapped answers after saved/live reconciliation; these display-only rows are not model-history messages or fork/edit anchors. Native runtime verification remains pending. [Question pages and action targets](question-pages-and-action-targets.md) records the new Back/Skip behavior, coverage and outstanding checks.

## Pending question visibility

Implemented: unanswered question cards use the existing orange warning highlight by default, including the heading, progress, keyboard cursor, selected options and primary send action. On desktop and the Local Web UI, a regular surface with rounded corners and a soft warning-colored shadow distinguishes the question from the surrounding chat without a tinted fill or border. Options retain their existing backgrounds. Compact cards share this treatment; an explicit accent tone uses the theme accent for the shadow instead. Single/multi-select, freeform answers, keyboard navigation, stepping and “You decide” keep their existing behavior. No storage, model payload, privacy or permission boundary changes.

Verification: matched before/after screenshots were inspected at 1200px and 390px in the default dark theme, confirming a visible shadow with no border or fill tint. Isolated macOS renderer checks cover focus, selection, and keyboard answers at wide and narrow widths in light and dark. Packaged builds and native phones were not tested; native styling is unchanged.
