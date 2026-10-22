---
title: "Designing: draw it or describe it (Design tab)"
area: code
split-from: SPEC.md (2026-10-22)
---

# Designing: draw it or describe it (Design tab)

The **Design** tab is where designs get made, a Claude Design-style surface with two ways in, both ending as a working prototype:

1. **Draw it.** A pen-and-touch-first sketch canvas (built to be used from an iPad or iPhone via the Local Web UI: pointer events, Apple Pencil friendly, palm-safe `touch-action`). The user sketches boxes, arrows, and labels, adds an optional note ("mobile app, dark theme"), and hits **Generate prototype**: a vision model turns the sketch into a polished, self-contained HTML code prototype.
2. **Describe it.** Write a prompt ("a landing page for a sushi delivery startup") and watch a design pop up. Starter idea chips help the first prompt along.

Either way the concept lands on the board as a card and is **mirrored into the workspace as a real HTML file** (`nekko-designs/`, or an existing earlier-brand folder), so the user, or any agent, keeps iterating on it as code. Selecting a concept opens a side sheet with a **Refine** box ("make the hero darker", "add a pricing section") that regenerates the design in place, follow-up by follow-up: the user stays the designer, the model just drafts fast.

The board still holds **live snapshots** of the app's real pages. The user pins **notes** on a page or leaves a **comment** that they Add-to-prompt or Run-now. As the agent reworks the UI, the snapshots refresh live and an "updating" badge marks the page being changed; clicking it jumps to the agent doing the work. The board makes "what does my app look like, and what should change" a visual, direct-manipulation surface.
