# Design system: quiet surfaces

How Nekko Agent looks, and the rules a new screen follows so it looks like the rest of the app. The tokens (colour, type scale, spacing, motion) are listed in [TASKS.md](../TASKS.md#design-system--uiux) and live in `apps/desktop/src/renderer/styles.css`. This page is the layer above them: how a screen is put together. Why we chose it: [decision 0071](decisions/0071-quiet-surfaces.md).

## The idea in one line

**Structure comes from space and type, not from boxes.** A view sits on one surface. Inside it, groups are told apart by the gap above them and the size of their heading; rows are told apart by their own padding. Borders, card backgrounds and tinted tiles are not how we separate things.

When something needs to stand apart, reach for these in order and stop at the first one that works:

1. **Whitespace.** A bigger gap above a group than between its rows.
2. **Size and weight.** A heading a step up the type scale, or semibold.
3. **Colour tier.** `--ink` for what you scan for, `--ink-soft` for supporting text, `--ink-faint` for metadata.
4. **A hairline.** One 1px `--line` rule between two peer sections of a different kind. Last resort.

## Surfaces

- **One surface per layer.** A page is one surface (`--paper`). A popover or menu is one floating surface (`--surface` with `--shadow-float`). Nothing inside either gets a card, a border, or a background tile of its own.
- **No card in a card, ever.** If a block inside a popover or panel seems to need a box, it needs a heading and a gap instead.
- **Allowed exceptions**, because they are objects, not grouping: text fields (they need an affordance), the composer, code blocks, a dragged item (`--shadow-lift`), the workbench panels (see Panels and the squircle in TASKS.md), and a destructive confirmation.

## Spacing rhythm

On the 4px grid (4 / 8 / 12 / 16 / 24 / 32). The rhythm is what replaces the boxes, so keep it exact:

| Between | Gap | Token |
| --- | --- | --- |
| Name and its meta on one row | 8px | `--q-inline` |
| Rows in a group | 0 (rows carry their own 8px block padding) | |
| A group heading and its first row | 4px | `--q-heading` |
| Groups in a section (a popover, a page column) | 24px | `--q-group` |
| Sections of a page | 32px | `--q-section` |

A row's padding is 8px block, 12px inline in a popover and 12px block, 12px inline on a page.

## Type ladder

One heading per level, never two sizes doing the same job.

| Role | Size / weight | Colour |
| --- | --- | --- |
| Page title | 20 / 600 | ink |
| Section heading | 16 / 600 | ink |
| Group heading (a provider, a family) | 14 / 600 | ink |
| Row title (page) | 14 / 500 | ink |
| Row title (popover, menu) | 12 / 500 | ink |
| Group label (small "Accounts", "Models") | 12 / 500, sentence case | ink-soft |
| Row detail, meta | 12 or 11 / 400 | ink-soft or ink-faint |

Never tracked caps. Never a third line on a row: a row is a title and at most one line of detail.

## Rows

The row is the unit of every list (models, accounts, chats, settings).

- **No border, no resting background.** A row is padding and text.
- **Layout:** optional leading mark, title, detail beside the title (or under it on a page), metadata pushed right, then trailing actions.
- **Hover:** a neutral wash (`color-mix(in srgb, currentColor 6%, transparent)`) on the row's radius. Under `@media (hover: hover)` only.
- **Selected:** the title in `--accent` plus a check, or for a persistent selection in a long list, `--accent-soft` behind the row. Never a border.
- **Row actions** (star, more, remove) sit at the end, faint until the row is hovered or focused, always visible on touch (`touch:opacity-100`).
- **Disabled or blocked:** title in `--ink-faint` and the reason as the detail, in words. Never hide a row to mean "unavailable".

## Groups and sections

- A **group** is a heading and its rows. The heading row can carry one line of meta on the right (an email, a count) and its actions.
- Groups stack with `--q-group` between them. **No divider between groups of the same kind.**
- A **hairline** goes between sections of a different kind (Cloud and Local, a list and its footer), spanning the content column. One rule, never a rule plus a box.

## Tabs and switches

- **Text tabs** (`quiet-tab`): the label in `--ink-soft`; the selected one in `--ink` on a neutral wash pill. No track, no border around the set.
- A tab can carry a second, fainter word ("Personal **Max**", "Acme **Team**") when the label alone does not identify the choice.
- **On/off** stays the existing `Toggle`.

## Status

- **At rest, status is a dot and a word**: a `StatusDot` and "Connected" in `--ink-soft`. Not a filled pill.
- **Attention** (offline, expired, limited) uses the state colour on the word, and a soft tint only when the user must act.
- Usage is a thin meter (4px, `--surface-2` track, state colour fill) with its label and percentage as one line of meta above it.

## Fields

- `quiet-field`: no border at rest, a faint wash, the `--ring` halo and an accent edge on focus. A search box in a popover is a `quiet-field` with the placeholder saying what it filters.
- Labels sit above fields as a group label. Help text is one faint line, or a tooltip. Not paragraphs.

## Copy

- One line of explanation per group at most, in `--ink-faint`. Caveats go in a tooltip or the docs.
- Identify things by what the user knows them as: the account's organization and plan ("Acme · Team"), not an internal id or folder name.
- Never put a secret, key or token on screen.

## Density: popover and page

| | Popover / menu | Page |
| --- | --- | --- |
| Row title | 12 / 500 | 14 / 500 |
| Row padding | 8 / 12 | 12 / 12 |
| Group gap | 24 | 24 |
| Width | 416 (640 with two columns) | content column, about 720 max |

## Building blocks

Use these instead of re-declaring markup (`components/primitives/`):

| Block | What it is |
| --- | --- |
| `Group` | A group heading with optional meta and actions, then its rows, with the group gap above it |
| `Row` | One list row: leading, title, detail, meta, trailing; hover wash, selected and disabled states |
| `QuietTabs` | Text tabs with an optional second word per tab |
| `Rule` | The hairline between sections of a different kind |
| `StatusDot`, `Toggle` | Existing state dot and switch |

CSS utilities for plain stylesheets and Tailwind: `quiet-row`, `quiet-tab`, `quiet-field`, `quiet-rule`, `quiet-group-label`.

## Checklist for a new screen

- [ ] No `card`, `border`, or background tile inside a view or popover, except the allowed exceptions.
- [ ] Groups separated by `--q-group` and a heading, not a rule or a box.
- [ ] At most one hairline between two sections, and only between different kinds.
- [ ] Every size on the type ladder; no third line on a row.
- [ ] Status at rest is a dot and a word.
- [ ] One primary button per view.
- [ ] Hover-only affordances also visible on touch.
- [ ] Checked in light and dark, at 360px and desktop widths.

## Migrating older screens

Older screens use `card` tiles, bordered rows and filled status pills. Move them over when you touch them, not in sweeping passes: replace the card with a `Group`, the bordered rows with `Row`, the pill with a dot and a word. The model picker and the Models page were the first to move (2026-11).
