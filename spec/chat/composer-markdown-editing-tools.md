---
title: "Composer Markdown editing tools (implemented; isolated interaction checks verified, visual inspection pending)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Composer Markdown editing tools (implemented; isolated interaction checks verified, visual inspection pending)

- Scope: the existing shared desktop/web composer Markdown editor only. Drafts and sent messages remain Markdown source; this does not change Agent board layout or wall styling.
- Right-click opens Markdown controls first (bold, italic, strike, inline code, link, heading, bullet/numbered/task list, quote, code block), followed by Copy, Paste, Paste as Markdown, and Paste without formatting. Applicable controls expose pressed state; Copy is disabled without selected text. Non-empty editor selections also expose the same controls in a viewport-positioned floating toolbar.
- Formatting and text paste preserve selection and use the editor's existing undo/redo history. Ordinary paste remains plain text and routes clipboard images to the existing attachment handler. Paste without formatting inserts plain clipboard text literally (including typed Markdown); Paste as Markdown converts supported rich HTML emphasis, links, headings, lists, quotes, and code, falling back to plain text.
- Privacy/security: clipboard reads/writes happen only on explicit action. Rich clipboard HTML is parsed detached, never inserted into the app; active content and remote images are discarded, and only HTTP(S)/mailto links are retained. Clipboard permission failures show a keyboard-shortcut fallback message without changing the draft. Disabled editors and IME composition do not expose editing actions.
- Acceptance: context menu controls precede clipboard actions; selection survives menu focus; formatting toggles and active state work for applicable source spans/blocks; conversion never executes or fetches clipboard content; toolbar dismisses on Escape, outside pointer, resize, scroll, or composition. Focused unit tests and isolated real-editor Electron interaction checks cover source edits, selection, menu state, copy, paste conversion, undo, and clipboard rejection. Full-app visual inspection, native OS clipboard integration, and mobile-native behavior remain unverified. Rich conversion is intentionally limited (no table/image import or rich CSS interpretation); this is not a general rich-text editor.

## Multiline single-backtick code (verification pending)

- User intent: recognise pasted multiline code wrapped in a single backtick on each delimiter line, without requiring conversion to triple-backtick Markdown fences.
- A line containing only one backtick (allowing surrounding spaces or tabs and CRLF line endings) opens or closes this composer code region. Inline single-backtick spans stay inline; ordinary triple-backtick fences retain their existing behaviour.
- Inside the region, Markdown-looking content is code, not headings, emphasis or lists. Language-neutral syntax highlighting changes presentation in the single-surface editor only: token text is rendered as escaped text, never injected HTML, executed code or fetched content.
- Preserve exact source, including delimiters, whitespace and line endings, in the draft and outgoing message. Highlighting must not normalise, rewrite or strip source. This is composer recognition, not a change to sent-message Markdown rendering or the native editors.
- Verification: focused composer tests pass for paired and unfinished single-backtick regions, inline/triple compatibility, Markdown-like code, HTML-like input and exact source. Hidden isolated full-App Electron verifies synthetic paste, safe escaped SVG, syntax spans and exact outgoing single-tick source. Corrected desktop/narrow captures exist; actual pixel inspection remains pending because image tools are intermittent. This addition is implemented, not yet released.

## Selection-connected single-row toolbar (implemented and isolated verification passed)

- User intent: keep the text-styling toolbar on one line, modernize its presentation, and make its relationship to the affected text obvious.
- The floating toolbar is a compact rounded surface with distinct active, hover, and keyboard-focus states and a small pointer aimed at the selected text. It is centered on the first visible text rectangle of a multiline selection and positioned using its measured dimensions, normally above the selection and below when top clearance is insufficient.
- The body-level portal can extend over neighboring agent panes instead of being clipped to the composer. It stays within the viewport; exceptionally small viewports scroll the tool row horizontally rather than wrapping. All eleven actions remain available. The right-click menu retains its compact wrapping layout and clipboard actions.
- Draft/source edits, selection preservation, undo/redo, IME and disabled-editor behavior, clipboard consent, privacy boundaries, and dismissal rules are unchanged. No external resources or new permissions are introduced.
- Acceptance: desktop and 390px web screenshots, one tool row, cross-pane overflow, top-edge flip, right-edge clamp, active formatting, keyboard destination selection, and exact direct/delegated follow-up payloads. Native mobile editors are outside this change.

Verification for this refinement: 30 focused tests, 2,885 desktop tests, desktop typecheck and production build pass. Hidden isolated Electron checks cover desktop/390px one-row layout, cross-pane overflow, top/bottom placement, right-edge clamping, formatting selection/active state, keyboard radio selection and exact follow-up send text. Matched dark-theme before/after screenshots and edge captures were inspected; actual-frame slider motion was captured. Full ChatPane and composer clipboard/undo regressions pass. Packaged Windows/Linux and native phone editors were not exercised; the native editors are unchanged.
