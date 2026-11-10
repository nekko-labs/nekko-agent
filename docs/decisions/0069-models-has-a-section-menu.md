---
status: accepted
date: 2026-11-08
---

# 0069. Models has a section menu, with Cloud above Local

## Context

[Decision 0057](0057-models-is-one-page-without-a-side-menu.md) dropped the Models side menu because it held only two links, and put Cloud and Local side by side. The local half holds several sections of its own (the model server, the agent server, the model library and connected servers), so reaching one meant scrolling a long column, and the two columns made the page hard to scan.

## Options considered

- Keep two columns without a menu. Both halves stay visible on a wide window, but nothing jumps to a local section.
- One column, Cloud then Local, with a side menu listing both and Local's own sections beneath it.

## Decision

Models is one scrolling page: **Cloud providers** on top, **Local model server** below. A compact floating side menu, centred vertically beside the content rather than attached to the far-left edge, lists Cloud providers and Local model server, with Models and Connected servers indented under Local. Choosing an entry scrolls to it, and the entry for the section at the top of the page is highlighted as you scroll. Local's own entries appear only once the full local page shows, not on the first-local-model screen; one whose section is not on screen lands on Local's heading. The `models` and `modelserver` view identifiers stay and still scroll to their section. This supersedes 0057.

## Consequences

Updated for #2489: the menu takes 192px with a 40px gap beside the page on wide windows, has no full-height divider, and becomes two-column rows above the page at 1000px or narrower. The two local destinations are separate 40px targets, spaced further apart. Cloud and Local remain stacked sections, but cloud families can share a row in up to three columns (content-width breakpoints at 880px and 1320px). A clicked destination keeps its highlight until the user takes over scrolling, avoiding page-end clamping and fractional-pixel scroll-spy races. A new local section needs a `data-models-section` mark and an entry in `MODELS_SECTIONS`.
