---
status: accepted
date: 2026-11-11
---

# 0084. Automations is the tab, and Scheduled tasks is a section of it

## Context

[Decision 0045](0045-workflows-are-scheduled-tasks.md) renamed the Workflows tab to
**Scheduled Tasks**. The page already holds more than scheduled tasks: CI runners are a
second section beside the list, the header's switch is **Pause all automations**, and the
Monitors dock and the Agents wall already call the same things Automations. Philip asked
for the tab to be called **Automations** again, with Scheduled tasks kept as a section
under it.

## Decision

- The nav item and page title say **Automations**. The page's side menu lists
  **Scheduled tasks** (always) and **CI runners** (when this computer can host one).
- One task is still a *scheduled task*: buttons, the editor, the help strip and the CLI
  (`nekko-agent scheduled-task`) keep 0045's word. The rest of 0045 stands.
- The rail icon is the Gentleface bolt, the glyph the Monitors dock uses for Automations.
- Code identifiers keep `workflows` (the `workflows` view, `nav.workflows`), as 0045 set out.

## Consequences

The tab name and the item name now differ (Automations holds scheduled tasks), which is
the point: a new kind of automation can join the side menu without another rename. Docs
that pointed to "Scheduled Tasks > CI runners" now say "Automations > CI runners".
