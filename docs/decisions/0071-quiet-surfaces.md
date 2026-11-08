---
status: accepted
date: 2026-11-09
---

# 0071. Quiet surfaces: structure from space and type, not boxes

## Context

Screens built at different times drew their structure differently: card tiles
inside cards, bordered rows, filled status pills, native selects inside framed
blocks, and stacked paragraphs of caveats. The Claude connections draft (#2336)
showed the cost: a picker of boxes within boxes where the thing the user came
to do (pick an account, pick a model) was hard to find. The newer surfaces (the
agent panel's flat rows, the borderless composer footer, the plan sheet) already
used whitespace and type instead, but nothing wrote the rule down, so each new
screen re-decided it.

## Decision

The app follows one written design system, [quiet surfaces](../design-system.md):

- One surface per layer; no card inside a view or popover except for objects
  (fields, the composer, code, a dragged item, workbench panels).
- Separation by whitespace first, then size and weight, then colour tier, and a
  single hairline only between sections of a different kind.
- Rows have no border or resting background; hover is a neutral wash, selection
  is accent text and a check (or `--accent-soft` for a persistent selection).
- Status at rest is a dot and a word, not a filled pill.
- Shared blocks (`Group`, `Row`, `QuietTabs`, `Rule`) and CSS utilities
  (`quiet-row`, `quiet-tab`, `quiet-field`, `quiet-rule`) carry the rules, so a
  screen composes them instead of re-declaring markup.

## Consequences

- Older screens migrate when touched, not in a sweep, so the app is mixed for a
  while. The model picker and the Models page move first.
- The tokens in TASKS.md are unchanged; three spacing tokens (`--q-inline`,
  `--q-group`, `--q-section`) name the rhythm that replaces boxes.
- Reviewers can point at the checklist in the design system page rather than
  arguing taste per PR.
