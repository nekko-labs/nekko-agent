---
status: accepted
date: 2026-11-06
---

# 0057. Models is one page without a side menu

## Context

[Decision 0024](0024-one-models-workspace-with-local-and-cloud-sections.md) gave the Models workspace left subnavigation. With Settings, Skills, Connectors and Models moved onto the Artifacts and Scheduled Tasks page shell, a rail with two entries spent 240px on what two section headings already say.

## Options considered

- Keep the rail, matching Settings. Consistent, but it holds only two links.
- Remove the rail and make the two section headings carry the structure.

## Decision

Models has no side menu. It is one scrolling page with **Local model server** and **Cloud providers** as the biggest headings in their sections, each with its icon. The `models` and `modelserver` view identifiers stay, and moving between them still scrolls to that section. This amends 0024 on navigation only; the rest of it stands.

## Consequences

Reaching Cloud providers from the page means scrolling past the local section, since no in-page link jumps there. Arriving from another screen opens at the top, as it always has. While on Models, the command palette and voice commands scroll to the section they name.
