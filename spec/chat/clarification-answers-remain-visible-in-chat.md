---
title: "Clarification answers remain visible in chat"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Clarification answers remain visible in chat

Implemented, verification in progress: replies submitted through ask_user appear as visible user-facing Q/A transcript rows at the saved tool result's chronological position, including existing chats when reopened. Selected labels and freeform notes stay literal; skipped or unattended questions show an explicit unanswered state. Pending, failed, malformed and unrelated tool results do not invent a user response. Model-facing answer wrapper instructions remain hidden. This is a display-only projection of existing stored history, not a duplicate user message or a change to model context. Projected replies support ordinary text copying but cannot edit, rewind, split or reuse a nonexistent persisted user-message ID. Acceptance requires focused transcript tests and isolated matched before/after evidence. Parent inspection of the original contact sheet and narrow light capture confirmed visible chronological Q/A and honest skipped/unattended states. Current-main integration preserves compact delegation and composer containment; 957 desktop tests across 142 files, desktop typecheck, production app build and 52 real-renderer assertions passed after integration. Fresh matched integration captures were inspected in narrow light/dark; original wide/narrow contact sheet was inspected. Optimized transcript projection passes 958 desktop tests; fresh hosted integration gates remain pending. PR #512 remains draft and unmerged during this handoff; live-provider and cross-platform verification remain unverified.
