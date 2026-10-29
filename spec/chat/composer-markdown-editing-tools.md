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
