---
status: accepted
date: 2026-11-09
---

# 0075. The quiet design system: 8/20 spacing, Dusk, Petrol, Geist, motion and icon rules

## Context

[Decision 0071](0071-quiet-surfaces.md) set the layout rule (structure from space and type, not boxes) but left colour, spacing scale, type, motion and icons to the token list in TASKS.md, which had drifted: it still named the retired violet accent. A survey of the renderer on 2026-11-09 found 353 bordered boxes and `card` tiles, 30 Tailwind palette colours, 40 `var(--token, #hex)` fallbacks and 42 `white`/`black` literals. Every light-mode state colour failed 4.5:1 when used for words. Light Nekko's faint and soft ink were nearly the same colour. Status had three ambers and an off-brand blue for "running".

Philip reviewed a working guide with live examples and chose each option.

## Decision

[docs/design-system.md](../design-system.md) is the single reference, and AGENTS.md tells every agent to follow it for UI work.

- **Principles**: space before lines; say it once; only what matters now; colour means something; every action moves; one surface per layer.
- **Spacing**: 8px steps inside components, 20px for layout (panel padding, group gap; sections 40). 4px only for tightly coupled pairs. Rows 40 tall on a page, 32 in a popover.
- **Dark neutrals**: Dusk, halfway between the old Ink dark and a blue midnight (`#0B0C14` page). Light stays Light Nekko, with a lighter faint ink (`#6E5A6C`).
- **Third colour**: Petrol (`#1F6680` / `#6BB8D4`) for information, "New" and the third chart series. It replaces the blue `--info` and sits across the wheel from plum. Indigo was rejected as too close to plum.
- **State words**: each state colour gains a darker `-text` value that passes 4.5:1. Working stays green (the rocket); `--running` aliases `--success` and `--highlight` aliases `--warning`.
- **Type**: Geist and Geist Mono replace Inter Tight and JetBrains Mono. The website keeps its fonts for now.
- **Icons**: Gentleface for controls, played once on hover, focus or press. Agent status uses our rocket and Nekko glyphs.
- **Motion**: every action animates with one curve, 120 / 200 / 260ms, 8px at most, never bouncing.

Rejected: a plum "Night" dark (`#190019` page: the primary button vanished and long sessions felt heavy); Aubergine, Abyss and Soot darks; Inter, IBM Plex and Figtree.

## Consequences

- Screens keep migrating when touched; Security settings, the model library and change review move first as reference screens.
- The phone apps keep their own palettes until their follow-up lands (tracked in its own issue); desktop and the Local Web UI change together.
- Reviewers point at the checklist in the design system page.
