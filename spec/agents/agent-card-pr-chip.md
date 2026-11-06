---
title: "Agent card PR chip"
area: agents
---

# Agent card PR chip

`[implemented 2026-11-06; unit-tested; verified in an isolated hidden renderer fixture against the base revision (default theme, detailed and title-only cards, long titles and branch names, the +N list on hover); not yet checked in the packaged app]`

**User intent:** see a chat's PR, and what became of it, at a glance on its card in the Agents panel: a chip at the card's bottom right with the PR glyph coloured by the PR's state.

## Behavior

- A chat card with PRs shows one chip at its bottom right: GitHub's glyph for the PR's state and `#123`, both in the state's hue. Clicking it opens the PR in the browser and never opens the chat.
- **State to glyph and colour,** as on GitHub and the same tokens as the PR chips in replies (`PrLinkChip`) and the iPhone list:
  - open: open-PR glyph, `--success` (green)
  - draft: draft glyph (dashed), `--ink-faint` (gray)
  - merged: merge glyph, `--merged-ink` (the theme's merged purple)
  - closed without merging: closed glyph, `--danger` (red)
  A draft that was merged or closed shows as merged or closed. The chip has no check or review state: the card's PR data carries checks, but the request was the PR's state, and the plan sheet already shows CI.
- **Several PRs:** the chip shows the one that matters most, then `+N` for the rest. In flight beats finished (open, then draft, then merged, then closed); within a state the newest by when it was opened, else the higher number in the same repository; otherwise the branch's own PR first. Hovering or clicking `+N` lists every PR, each with its glyph, title and state, each a link.
- **Placement:** the chip ends the card's last line (the model line, the computer line of an agent on another computer, the branch line or the sub-agents line, whichever is last), so it never adds a line. The branch line no longer lists PR numbers after the branch.
- **Title-only cards** (the view menu's metadata off) show the chip at the end of the title row, in place of the last-reply time, so the title keeps the room it had.
- Which PRs a chat has is unchanged: the branch's PR from git status plus the PRs its transcript names (`prsBySession`), merged by URL.

## Boundaries

No new data, permissions or network calls: the chip reads the PR state the card already loads. Terminal cards are unchanged.
