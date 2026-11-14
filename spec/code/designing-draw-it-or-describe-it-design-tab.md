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

## The board follows the designs folder (2026-11-12, #2680)

`[implemented, not yet released; engine tests and a real-daemon test, the card label checked in the hidden full-App fixture]` Before this, the copy in `nekko-designs/` was one-way: a design an agent saved there never reached the board, and an agent's edit to a concept's file was not shown, so the next **Refine** started from the old HTML and overwrote the edit. Requested as part of making designs something agents can see and use (#2677).

- **Designs saved into the folder become cards.** When the board loads, every `.html` or `.htm` file directly in the project's `nekko-designs/` folder that no card owns becomes a concept card, labelled from the page's `<title>` (else its file name as words) and marked **from the designs folder**. It can be refined, annotated and commented on like any concept. Up to 200 files are read per load; files over 1 MB, binary files and files with no markup are left alone, as are subfolders.
- **Edits to a card's file show on the card.** A concept whose file changed on disk takes the file's HTML, and the HTML it had is kept in **Previous versions** (the usual last ten) so it can be restored. A **Refine** then starts from the edited file.
- **Removing a card does not delete its file**, and the card does not come back while the file remains. To put it back, use **Add to design board** in the file pane, which makes a new copy.
- A file that is deleted or stops being a page leaves its card as it was. The board loads when the Design tab opens, when the project changes, and when an agent in that project finishes a turn; an edit made in between shows at the next of those. Nothing is written to the folder by following it, and the board's store is only written when something changed.
- Agents need no tool for this: any agent that can write a file in the project puts a design on the board. Nekko's own agents are told about the folder by the shared prompt ([Library](../desktop/library-and-first-visit-guide.md), [decision 0089](../../docs/decisions/0089-designs-are-files-in-the-projects-designs-folder.md)).

Not done: the Design tab is still an experimental page; pinned notes and live pages are not visible to agents (#2681); a design in a subfolder (`nekko-designs/login/index.html`) is listed in Library but is not adopted by the board; images are not adopted; the board does not watch the folder while it is open.

