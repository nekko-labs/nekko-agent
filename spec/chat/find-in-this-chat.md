---
title: "Find in this chat (2026-10-16)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Find in this chat (2026-10-16)

`[implemented; unit-tested and verified in an isolated hidden renderer (42 checks, light and dark, plus Agents wall placement and Ctrl+F); awaiting the user's go-ahead before a PR; real desktop app, macOS and Linux not checked]` Users can search a chat for a keyword. A magnifier button is the first of the chat window's header icons, immediately left of Changes (±) and Files (folder), in their exact button style (ghost button, 26x22 px) and icon format (14x14 px, 24-unit viewBox, 1.7 stroke). This supersedes an earlier placement beside the composer's **+**, which the user moved. **Ctrl+F** (Cmd+F on macOS) opens the same search. Ctrl/Cmd+K is unchanged and still opens the command palette (the user chose Ctrl+F so the palette keeps K). The search bar floats at the top right of the transcript with the query on an underline-only field (no focus ring or tint), a count (**N of M**, or **No results**), up/down buttons, and a close **X**.

- **Matching:** whole word or phrase, case-insensitive. Word characters are letters and digits in any script plus underscore, so `scroll` matches *Scroll* and *SCROLL* but not *scroller*, *autoscroll* or *scroll_bar*. Whitespace inside a phrase matches any run of whitespace. Regex characters are literal.
- **What is searched:** the message text a reader sees in user and assistant messages (a skill message's typed input). Tool calls and output, reasoning, Done/turn-stats lines, hover actions, code-block Copy buttons, and link and image targets are not searched. Link text is.
- **Count and navigation:** the count covers the whole conversation, including rows the windowed transcript has not rendered. A new query always starts at **1 of M**, the first match from the top of the chat. Up/down buttons, Enter/Shift+Enter and the arrow keys step through matches and wrap at both ends; a match in an unrendered row is scrolled to, rendered, and centred.
- **Highlights:** every match gets a soft wash and the current one is solid, drawn with the CSS Custom Highlight API so message DOM, selection and copying are unchanged. Esc or X closes the bar and removes every highlight; focus returns to the composer.
- **Targeting:** the window containing keyboard focus, else the visible full chat, else the Agents wall's selected transcript window. On the wall, each window's title strip carries its magnifier, and Ctrl/Cmd+F with focus in the shared composer opens search on the transcript window that composer drives.
- **Boundaries:** local and read-only; no network, persistence, telemetry or new permissions. Search state is not saved and resets each time the bar opens. Acceptance: `apps/desktop/scripts/chat-search-integration.cjs` plus `chatSearch.test.ts`.
