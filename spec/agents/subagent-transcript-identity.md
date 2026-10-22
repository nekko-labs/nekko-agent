---
title: "Subagent transcript identity"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Subagent transcript identity

`[implemented and renderer verified on 2026-10-06]` Delegation in the desktop/shared web transcript carries a fork/branch icon alongside an agent icon, with the child task title and subagent count visible even when working steps are collapsed. Expanded persisted delegation steps distinguish **To subagent** (the task) from **From subagent** (the matching tool result), including an explicit failure or missing-result label. Ordinary tools and assistant narration are not relabelled as child replies. Agent-watch continuation prompts are shown as watch rows, not subagent replies (see *Watch rows and subagent models*); prefix recognition is a presentation hint, not authenticated provenance.

Acceptance: collapsed and expanded delegation remain distinguishable in light/dark themes and narrow/wide transcript panes; request/result association uses tool-call IDs; labels convey meaning without relying on color. No credentials, additional remote calls, routing changes or permission changes are introduced. The existing watch/task text remains intact. Native mobile transcript parity and authenticated watch provenance metadata are not implemented by this change. Automated component/transcript checks verify labels and association. Isolated full-chat Electron checks cover completed, failed and missing results, ordinary prompt controls, watch labels and expanded-state retention through virtualization. Matched wide/narrow light/dark captures and sampled expand/collapse frames were directly inspected.
