# 0099. Library edits a page by its text, and keeps designs view-only

Date: 2026-11-14. Status: accepted. Issue: #2755.

## Context

Philip asked for every Library file except designs to be editable, HTML pages included, in code or by selecting an element. The file pane already edits text files and HTML source. What was missing was a way to change a page while looking at it, and a rule for designs.

## Decision

- **Designs open view-only in Library.** A design changes by a new numbered version beside it ([0090](0090-a-design-is-versioned-as-files-beside-it.md)); editing the newest file in place would quietly rewrite a version someone already saw. The canvas never edited, and the design's **Source** view now has no editing either. Changing a design is a request to an agent, or editing the file outside Library.
- **A running page edits its text, and only its text.** **Edit text** serves the page again with a small editor script (an `edit` serve option, separate from the canvas's control script). Clicking an element with no elements inside makes it editable in place; Enter posts the tag, the old text, which such element it is, and the new text. The app finds that element in the source by tag, plain text and order, and replaces only its text, escaped. Everything else in the file stays byte for byte, and the change is one undo step in the code view.
- **What can't be found is refused, not guessed.** Text a script wrote, an element with tags inside, or one written without its closing tag is left alone with a note to change it in Source.

## Alternatives not taken

- **Serialize the page's DOM back to the file.** Simple, but it rewrites the whole file: formatting, attribute order, entities and anything scripts added at run time.
- **Map elements to source positions with an HTML parser (parse5).** Exact even for script-added look-alikes and unclosed elements, but a new dependency in the renderer for an edge the text-and-order match only misses when a script creates an element with the same text before the one clicked. Upgrade to it if that shows up.
- **Edit attributes, styles and structure visually.** A design tool. Out of scope; Source covers it.

## Boundaries

The editor script runs only in pages served for editing, in the same offline, opaque-origin sandbox as every served page, and posts only to its own viewer. The app accepts a change only from that frame, only while Edit text is on, only as four bounded fields, and only applies it as escaped text, so a hostile page can at most change plain text in its own file while the person has it open for editing, which shows in the undo history.
