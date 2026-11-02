---
title: "Chat transcript width (2026-10-19, revised 2026-11-02)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat transcript width (2026-10-19, revised 2026-11-02)

User intent: a reply reads as one block. Its prose, tables and code blocks end at the same edge, so the text never looks cut off halfway across under a table that runs on ([#1526](https://github.com/nekko-labs/nekko-agent/issues/1526)).

- `[implemented; focused test and hidden desktop captures at 1500px and 700px]` The transcript is one centred column at the prose measure: 68 characters of reply text (`.chat-column`, `max-width: calc(68ch * 14 / 16)`, about 600px, because the column inherits 16px text and reply prose is 14px). Prose, tables, code blocks, tool cards and the user's turns all stay inside it; a table or code line wider than the column scrolls inside its own block. In a pane narrower than the measure the column fills the pane inside the transcript scroller's 30px gutter, as before. The composer width is unchanged. No new data, network or permission access.

## History

- 2026-10-19 (#776): the transcript spanned the full pane inside a 30px gutter, replacing a centred three-quarter column that left wide margins.
- 2026-11-01 (#1429): prose alone was capped at 68ch, which in a wide pane left it ending halfway across while tables and code blocks still ran the full width.
- 2026-11-02 (#1526): the whole column is capped at that measure and centred. Unlike the old three-quarter column, it is no wider than the prose, so nothing in a reply runs past the text.
