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

Models is one scrolling page: **Cloud providers** on top, **Local model server** below. A side menu in the Settings rail style lists Cloud providers and Local model server, with Model server, Agent server, Models and Connected servers indented under Local. Choosing an entry scrolls to it, and the entry for the section at the top of the page is highlighted as you scroll. Local's own entries appear only once the full local page shows, not on the first-local-model screen; one whose section is not on screen lands on Local's heading. The `models` and `modelserver` view identifiers stay and still scroll to their section. This supersedes 0057.

## Consequences

The menu takes the rail's 240px on a wide window and becomes wrapping rows above the page on a narrow one, as in Settings. A new local section needs a `data-models-section` mark and an entry in `MODELS_SECTIONS`.
