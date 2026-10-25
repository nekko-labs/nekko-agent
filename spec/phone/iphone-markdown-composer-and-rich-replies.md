---
title: "iPhone Markdown composer and rich replies (planned 2026-10-25)"
area: phone
---

# iPhone Markdown composer and rich replies (planned 2026-10-25)

**User intent:** Philip asked (2026-10-25) for the iPhone agent chat to support writing in Markdown, with a toolbar that applies styles, real nested bullet points, good-looking tables, and a choice between pasting as Markdown and pasting as plain text. Tasks MD-1 to MD-6 in [TASKS.md](../../TASKS.md). Diagrams are a separate spec: [Mermaid diagrams on the phone](mermaid-diagrams-on-the-phone.md).

**Status `[planned; nothing implemented]`.** The phone today renders assistant replies with a line scanner (`apps/ios/App/Views/Markdown.swift`). Nesting is only drawn as indentation, with one marker at every level and no handling of wrapped list lines. `[updated 2026-10-26]` Tables in replies now render as a native grid with alignment, sideways scrolling and VoiceOver cell labels ([iPhone chat: tables and link previews](iphone-chat-tables-and-link-previews.md), #1095); *Expand*, *Copy as Markdown* and *Share* from this spec are still planned. User messages are plain text. The composer is a plain `TextField` with no formatting and no paste choice. The desktop and Local Web UI already do all of this ([Composer Markdown editing tools](../chat/composer-markdown-editing-tools.md)), and the phone should match their behaviour.

## What the user gets

- **Drafts stay Markdown source**, as on the desktop. What is sent is what was typed, so the agent and every other client read the same text. The composer is not a rich-text editor: it shows the source with light live styling. Bold looks bold with its `**` dimmed, headings are larger, list markers are tinted, and code is monospaced.
- **A formatting toolbar** sits inside the composer card, directly above the text and below any attachments. It shows while the field is focused and the user can hide it with an *Aa* toggle; the choice is remembered. It is not a keyboard accessory, because that was removed to avoid the iOS 26 Done-button overlap. It scrolls horizontally and has these buttons, in order:
  - bold, italic, strikethrough and inline code
  - link
  - heading
  - bullet list, numbered list and task list
  - indent and outdent
  - quote and code block
  - table
  
  Each button acts on the selection, or on the current line for block styles. A button shows as pressed when the selection already has that style, and pressing it again removes the style. Every change can be undone with the system undo (shake or three-finger swipe).
- **Lists behave like lists while typing.** Return on a list line continues the list: the next number, or an empty task box. Return on an empty list item ends the list. Indent and outdent, or Tab and Shift-Tab on a hardware keyboard, nest the line by two spaces, or three for numbered lists. A numbered list renumbers itself when lines are added or removed.
- **Table** inserts a 2×2 skeleton (`| | |`, a separator row, one body row) with the cursor in the first header cell. When the cursor is inside a table, the toolbar adds *Add row* and *Add column*.
- **Paste has two choices.** A normal paste stays plain text, and images still go to attachments as today. Long-press → *Paste* shows the system item plus two of ours:
  - *Paste as Markdown*: when the clipboard holds rich text (HTML or RTF from Safari, Notes, Mail or Docs), it is converted to Markdown. This covers bold, italic, strikethrough, code, links, headings, nested lists, quotes, code blocks and simple tables. If there is no rich text, it pastes the plain text.
  - *Paste as plain text*: inserts the clipboard's plain text literally, including any Markdown characters it contains.
  
  After a normal paste of rich content, a small chip appears for 4 seconds: *Pasted as text · Use formatting*. Tapping it swaps the pasted text for the Markdown conversion, as a single undo step.
- **Replies and the user's own messages render the same Markdown.** User bubbles go through the renderer as on the desktop (T101).
  - **Nested lists** become a real tree. Markers change by depth: •, ◦, ▪ for bullets and 1., a., i. for numbers. Wrapped lines and lines that continue an item hang under the item's text. Task items are checkboxes.
  - **Tables** are a native grid. The header row is bold on a faint fill, rows are separated by hairlines, and column alignment follows the `:---:` markers. A wide table scrolls sideways inside its frame and never forces the whole chat to scroll. Long cells wrap up to a column width cap. A table with more than 4 columns or 12 rows also gets an *Expand* button that opens it full screen, where it can be zoomed and scrolled both ways.
  - **Tables have their own actions.** Long-pressing a table offers *Copy as Markdown*, *Copy as text* (tab-separated, which pastes into Numbers and Sheets as cells) and *Share*.
  - Everything that renders today keeps working: code blocks with Copy, headings, quotes, rules, inline links and selection.

## Boundaries

- Privacy/security: the clipboard is read only on an explicit paste action. Rich clipboard HTML is parsed off-screen and never shown or loaded: scripts, remote images, styles and iframes are discarded, and only `http(s):` and `mailto:` links are kept. The converter is a pure Swift function, unit-tested on Linux in `NekkoProtocol`.
- The renderer stays dependency-free and its output is cached as today (the `InlineMarkdown` NSCache). A streaming reply must not re-parse the whole message per token, and a reply of 500 lines with three tables should scroll at 120 Hz on a recent iPhone.
- Accessibility: every toolbar button has a VoiceOver label and pressed state. A VoiceOver user hears tables as rows ("Row 2 of 5: Name, Nekko; Status, done"). Dynamic Type scales the table text, and the grid scrolls rather than truncating.
- Android follows the same spec (MD-6); `Markdown.kt` already ports the iOS parser.

## Acceptance

- `MarkdownTests` in `NekkoProtocol` (Linux) cover:
  - nested lists three deep, mixed bullet and number lists, continuation lines
  - tables with alignment, escaped pipes, and ragged rows padded to the header
  - the toolbar's edit functions: toggling each inline style, block toggles on several lines, indent and outdent, list continuation and ending, table insert and add row/column
  - the HTML→Markdown converter, including the security cases
- A UI test types a nested list and a table with the toolbar, sends it, and reads it back rendered. Its screenshots appear in the PR, in light and dark and at the largest text size.
- Status stays *planned* or *unverified* until the app has run on a simulator. Code that exists but has not been run is not shipped.
