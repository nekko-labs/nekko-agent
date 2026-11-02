---
title: "Chat transcript width (2026-10-19, revised 2026-11-02)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat transcript width (2026-10-19, revised 2026-11-02)

User intent: the conversation should use the space at the sides of the chat pane instead of a centred three-quarter column, while keeping about 30px from each edge. A reply reads as one block: its prose, tables and code blocks end at the same edge, so the text never looks cut off halfway across under a table that runs on ([#1526](https://github.com/nekko-labs/nekko-agent/issues/1526)).

- `[implemented; typecheck and focused tests; desktop visual check pending]` The transcript column spans the full chat pane at every pane width, inside a 30px gutter on the left and right of the transcript scroller. The gutter is the same with the Agent Monitor open (its floating toggle only shows while the monitor is closed, and the transcript already starts below it). The composer width is unchanged. No new data, network or permission access.
- `[implemented; focused test and hidden desktop captures at 1500px and 700px]` Reply prose (paragraphs, lists, quotes, headings) runs the full column width, like the tables and code blocks beside it. It is not capped at the 68-character reading measure that documents use. The user's own turn stays a bubble on the right at up to `min(85%, 68ch + padding)`.

## History

- 2026-10-19 (#776): the transcript spans the full pane inside a 30px gutter, replacing a centred three-quarter column that left wide margins.
- 2026-11-01 (#1429): reply prose was capped at 68ch, which in a wide pane left it ending halfway across while tables and code blocks still ran the full width.
- 2026-11-02 (#1526): the cap was removed from chat replies; documents keep it. A centred 68ch column for the whole transcript was tried and dropped, because it brought back the wide side margins #776 removed.
