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
- **PR attribution:** the branch's PR from git status plus confirmed successful PR-creation results from the chat transcript (`prsBySession`), merged by URL. Arbitrary prose links and PR-view commands do not claim ownership. A shell call (Nekko's `bash`, Claude Code's `Bash`, or Claude Code's `PowerShell` on Windows) counts when one of its top-level commands is `gh pr create` or a POST to the pulls API, the way agents really run it: alone, after `cd` or `git push`, after a heredoc or PowerShell here-string writes the body, or followed by `gh pr merge --auto`. Text inside quotes, heredocs and here-strings is never a command. The output must hold the new PRs' URLs as bare lines, no more of them than the call ran creates; more URLs than creates, a URL only inside prose, a failed call, or a create that reports the PR already exists attaches nothing. The Rust summary and live PR loader and the shared TypeScript collector run one fixture (`packages/shared/fixtures/pr-creation.json`). **Sub-agents' PRs are the chat's too** (added 2026-11-12, [#2642](https://github.com/nekko-labs/nekko-agent/issues/2642)): a sub-agent runs in a child chat of its own (Claude Code's Agent tool, background ones included, and Nekko's `spawn_agent`, both linked by `parentSessionId`), so the chat that fanned the work out also lists every PR its sub-agents, and theirs, created under the same rule, after its own and without repeats (`roll_up_child_pr_urls` in `crates/nekko-store/src/pr.rs`, applied to the session summaries and so to `pr:sessionList`, the card chip and the plan sheet alike). The child chats keep their own. A background Claude Code sub-agent's chat holds its whole transcript, filled from the copy Claude Code saved when it ends, so its PRs reach the parent even when the stream stopped carrying its steps ([#2645](https://github.com/nekko-labs/nekko-agent/issues/2645), [Subagents in Claude chats](claude-code-subagents.md#its-whole-transcript)). A parent cycle or nesting deeper than 16 stops the walk. Unit, store and daemon tested (a child's PR on the parent's summary and live list, a grandchild, a failed create attaching nothing, cycles and depth); not yet seen in a live chat. Not covered yet: PRs opened from inside a code-mode `run_code` script.
- **Why this was rewritten (2026-11-12):** the earlier rule took only a lone `gh pr create` with at most one leading `cd`. Over four days of real chats it attached 10 created PRs and missed about 64 (PowerShell calls, `git push && gh pr create`, a `cat > body.md <<EOF` before the create, `&& gh pr merge --auto` after it), so most cards had no chip. The same chats now attach 76 PRs across 43 chats.
- **Visible-card hydration:** every mounted card with summary PR URLs gets fetched, not just the first eight. At most eight reads run concurrently across overlapping effects; cached and in-flight cards are skipped, and unmount/filter changes stop queued reads. This includes the activity **Done** group without opening each chat. Hidden groups and rows behind Show more remain lazy.
- **Done context:** a chat in the activity Done state (finished reply, no armed watch) hides context token usage and compaction activity. This is independent of grouping and keeps model, PRs, subagents and windows. Working, needs-input, interrupted, watch-armed and draft chats retain the existing context behavior; archived Completed rows remain their existing compact presentation.

**Implemented and verified (2026-11-09):** 3,425 desktop tests plus 69 script tests, 115 shared PR tests, desktop production build/typecheck, Rust store/workspace tests and Clippy pass on Windows. Matched real-Electron base/fixed captures and interaction checks cover desktop/narrow widths (1440/420), dark/light, #PR +N and independent links. The screenshot harness disables only the unchanged popover fade and checks actual pixel luminance after theme changes. Captured pixels were inspected through a native offscreen image viewer; all ten published v2 images were anonymously fetched and SHA256-compared to local captures. Evidence: [PR #2346](https://github.com/nekko-labs/nekko-agent/pull/2346). Packaged desktop and native phone UI remain unverified; no motion change is claimed.

### Reproduce the isolated sidebar checks

Use the worktree bootstrap in [the typecheck runbook](../../docs/runbooks/worktree-typecheck.md), then run the shared launcher with `NEKKO_LAYOUT_FIXTURE=chat-pr-chiplets-fixture.tsx`, `NEKKO_LAYOUT_SANDBOX=chat-pr-chiplets-sandbox.cjs` and `NEKKO_TEST_LABEL=after`. For a baseline, use `NEKKO_TEST_LABEL=before` and `NEKKO_TEST_SOURCE` pointing at an unchanged base worktree. Output and the assertion report are under `.shots/layout-evidence/<label>/`. Profiles are disposable, provider/GitHub calls are stubbed and HTTP requests are blocked.

## Boundaries

No new data schema, permissions or endpoints: visible cards use the existing cached PR reader, with bounded reads across all mounted cards rather than a one-shot eight-card slice. Attribution does not scan user prose or unrelated PRs. Terminal cards and native phone presentation are unchanged.
