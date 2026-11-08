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
- **PR attribution:** the branch's PR from git status plus confirmed successful PR-creation results from the chat transcript (`prsBySession`), merged by URL. Arbitrary prose links and PR-view commands do not claim ownership. The Rust summary and live PR loader share one creation-only collector, matching shared TypeScript support for `bash`/`Bash`, one safe leading `cd`, heredoc bodies, trailing `head`/`tail` output trims and GitHub warnings before the final created URL. Ambiguous shell batches remain rejected.
- **Visible-card hydration:** every mounted card with summary PR URLs gets fetched, not just the first eight. At most eight reads run concurrently across overlapping effects; cached and in-flight cards are skipped, and unmount/filter changes stop queued reads. This includes the activity **Done** group without opening each chat. Hidden groups and rows behind Show more remain lazy.
- **Done context:** a chat in the activity Done state (finished reply, no armed watch) hides context token usage and compaction activity. This is independent of grouping and keeps model, PRs, subagents and windows. Working, needs-input, interrupted, watch-armed and draft chats retain the existing context behavior; archived Completed rows remain their existing compact presentation.

`[Implemented 2026-11-09; focused TS and Rust store/workspace suites and desktop typecheck pass. Isolated Electron matched baseline/fixed capture and interaction checks cover 1440/420 widths, dark/light, #PR +N and independent links; final pixel inspection and published evidence verification pending. Packaged app and native phone UI are not claimed.]`

## Boundaries

No new data schema, permissions or endpoints: visible cards use the existing cached PR reader, with bounded reads across all mounted cards rather than a one-shot eight-card slice. Attribution does not scan user prose or unrelated PRs. Terminal cards and native phone presentation are unchanged.
