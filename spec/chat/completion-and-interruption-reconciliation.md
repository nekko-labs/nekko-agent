---
title: "Completion and interruption reconciliation"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Completion and interruption reconciliation

Implemented and verified with 1,124 desktop tests, typecheck, and 80 isolated renderer assertions plus matched completion screenshots: an explicit successful terminal record (`turnStats.stop: complete`) takes precedence over unmatched historical tool bookkeeping when inferring a persisted interruption. An explicit interrupted marker still wins, and unresolved tool calls without successful terminal evidence remain recoverable. A transient inferred interruption banner clears when the completed transcript arrives; provider errors and user-requested stops are not silently cleared. No transcript or private app data is rewritten. Acceptance: completed and genuinely interrupted fixture cases, delayed transcript reconciliation, and isolated light/dark wide/narrow evidence. The exact triggering transcript in the reported screenshot was not accessible in the workspace sandbox.
