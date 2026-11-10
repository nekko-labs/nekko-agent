# Design system: quiet surfaces

How Nekko Agent looks and moves, and the rules every screen follows. Every UI change reads this first. The tokens live in `apps/desktop/src/renderer/styles.css` (listed in [TASKS.md](../TASKS.md#design-system--uiux)); this page is how a screen is put together from them. Why: [decision 0071](decisions/0071-quiet-surfaces.md) and [decision 0075](decisions/0075-quiet-design-system.md).

## Principles

1. **Space before lines.** Gaps and type separate things. A border is the last resort.
2. **Say it once.** One short line of help, at most. Detail waits behind a tap, a disclosure or a tooltip. Cut words before adding them.
3. **Only what matters now.** Show what applies to this model, this chat, this state. What does not apply is gone, not greyed out.
4. **Colour means something.** Plum for intent, state colours for state, Petrol for information. Neutrals do the structure.
5. **Every action moves.** Each change animates, briefly and quietly. Nothing bounces.
6. **One surface per layer.** No card in a card. A popover is the only thing that floats.

## Separating things

Reach for these in order and stop at the first that works:

1. **Whitespace**: a bigger gap above a group than between its rows.
2. **Size and weight**: a heading one step up the type ladder.
3. **Ink tier**: `--ink` to scan for, `--ink-soft` to support, `--ink-faint` for metadata.
4. **A hairline**: one 1px `--line` rule between sections of a different kind. Never a rule plus a box.

## Surfaces

- A page is one surface (`--paper`). A popover or menu is one floating surface (`--surface`, `--shadow-float`). Nothing inside either gets a card, a border or a tinted tile.
- Allowed objects, because they are things rather than grouping: text fields, the composer, code blocks, a dragged item (`--shadow-lift`), workbench panels, a destructive confirmation.

## Spacing: 8 and 20

8px steps inside components, 20px steps for layout. 4px only for things that belong together.

| Value | Token | Use |
| --- | --- | --- |
| 4 | `--q-tight` | Tightly coupled pairs: a title and its subtext, an icon and its label, a value and its unit |
| 8 | `--q-inline`, `--q-heading` | Row padding, name to meta, group label to its rows |
| 16 | | Between controls in a bar, inside a field |
| 24 | | Inside large components |
| 20 | `--q-pad`, `--q-group` | Panel padding, page gutter, group to group |
| 40 | `--q-section` | Section to section |

Sizes: rows 40 tall on a page (`--q-row`), 32 in a popover or menu (`--q-row-dense`); buttons and fields 32, small buttons 28; popovers 400 wide; the content column about 720. In Tailwind: `gap-1` 4, `gap-2` 8, `gap-4` 16, `gap-5` 20, `gap-6` 24, `gap-10` 40.

## Type

Geist for the interface, Geist Mono for code, paths and numbers in tables (Settings > Style can override both). One size per job, sentence case, never tracked caps, never a third line on a row.

| Role | Size / weight | Colour |
| --- | --- | --- |
| Page title | 20 / 600 | ink |
| Section heading | 16 / 600 | ink |
| Row title, page | 14 / 500 | ink |
| Row title, popover | 12 / 500 | ink |
| Group label | 12 / 500 | ink-soft |
| Detail, meta | 12 or 11 / 400 | ink-faint |

## Colour

A component reads a token, never a hex value, `rgb()`, a Tailwind palette class (`text-red-400`) or `white`/`black`, and never `var(--token, #fallback)`: the token always exists. The one exception is third-party marks (provider and connector logos) in the `*Icons.tsx` files.

- **Neutrals** build the screen: `--paper`, `--surface`, `--surface-2`, `--line`, and the three ink tiers. Light is Light Nekko; dark is Dusk (`#0B0C14` page, `#1D1F2C` raised, `#252735` line).
- **Plum** marks intent: the one primary button (`.btn-primary`: the accent fill, deep plum `#190019` with a `#854F6C` edge in dark in the Nekko themes), focus (`--ring`), what is selected (title in `--accent` plus a check, or `--accent-soft` behind a row), links, the on state of a toggle, chart series one. Never headings, icons at rest, decorative borders, badges that only inform, secondary buttons or hover.
- **Petrol** (`--info`: `#1F6680` light, `#6BB8D4` dark) is information: notices, "New", tips, chart series three. `--accent-2` is chart series two.
- **State**: `--success`, `--warning`, `--danger`, `--attention` (an agent waiting on you), `--neutral`. Each has a base value for glyphs, dots and meter fills, a `-text` value for words (`--danger-text`; it passes 4.5:1 where the base value does not), and a `-soft` tint used only when the user must act.

## Agent status

Agents show their status with our glyphs, never a generic dot:

| State | In a list (`StatusIcon`) | On a window (`WallMascot`) |
| --- | --- | --- |
| Working | the line rocket, animated, `--success` | Nekko hopping, rocket badge |
| Needs you | question ring, `--attention` | question badge |
| Stopped on an error | warning triangle, `--danger` | cross badge |
| Watching | Zz, `--ink-faint` | Nekko asleep, Zz badge, `--neutral` |
| Done | check, `--ink-faint` | Nekko smiling, check badge |

Everything else (connected, expiring, offline) is a dot and a word: `StatusDot` and the word in `--ink-soft`, or in the state's `-text` colour when it needs attention.

## Icons

- Control icons are **Gentleface** (MIT, bundled in `gentleface-icons.tsx`), line at 16px. New ones go in [ASSETS.md](../ASSETS.md).
- Each plays its motion **once** on the control's hover, focus or press, then rests. Never loop. Decorative and disabled icons stay still. Reduced motion stops playback.
- `--ink-soft` at rest, `--ink` on hover, `--accent` only when the control is on.
- Status glyphs and the Nekko mascot are ours; provider logos keep their own marks.
- **Phones** keep their platform's symbol set for controls (SF Symbols on iOS, Material Symbols Outlined on Android, line weight; the Gentleface PR and permission marks where both apps bundle them), coloured by the same rule: `inkSoft` at rest, the accent only for a selected check, a link or the screen's main action. Agent status is always our glyphs (`ChatStatusIcon`, `LiveStatusGlyph` on iOS, `StatusGlyph` on Android). The theme's accent is also UIKit's window tint on iOS, so popovers, menus and alerts never fall back to system blue.

## Motion

Every action answers with motion: short, decelerating, never bouncing. One curve, `--ease-out` (`EASE_OUT` in `easing.ts`).

| Action | Motion | Time |
| --- | --- | --- |
| Hover, press | Wash fades in; press scales to 0.97; the icon plays once | `--dur-fast` 120ms |
| Toggle, select, tab | Knob slides; fill fades; the tab pill slides | `--dur-med` 200ms |
| Expand, add a row | Height opens, content fades in | 200ms |
| Remove a row | Fades, then the gap closes | 160ms |
| Popover, menu | Fades in, rises 4px, scales from 0.98 at its anchor | 200ms in, 150ms out |
| Status change | Word crossfades, glyph changes | 200ms |
| Meter, theme | Width or colour eases to the new value | `--dur-slow` 260ms |
| Toast | Rises 8px and fades in; fades out after 4s | 200ms |

Move 8px at most. Animate `opacity` and `transform`, never blur, bounce or overshoot. Nothing over 300ms for anything used often; nothing on key repeat or while typing. Exits are about 25% faster than entrances. Reduced motion keeps only the fades.

## Rows, groups and controls

- **Row**: no border, no resting background. Leading glyph, title, one line of detail, metadata pushed right, trailing actions. Hover is a neutral wash (`--q-wash`) under `@media (hover: hover)`. Row actions are faint until hover or focus, always visible on touch.
- **Disabled or blocked**: title in `--ink-faint` and the reason as the detail, in words.
- **Group**: a 12/500 `--ink-soft` label and its rows, `--q-group` above it. No divider between groups of the same kind.
- **Buttons**: one primary per view. Secondary is a neutral wash (`.btn` / `.btn-ghost`), not an outline. Destructive is words in `--danger-text` until the confirmation.
- **Tabs** (`QuietTabs`): the label in `--ink-soft`, the selected one in `--ink` on a wash pill that slides.
- **Fields** (`quiet-field`): no border at rest, a faint wash, the `--ring` halo and an accent edge on focus.
- **Removal**: anything that removes or reverts offers Undo in a toast instead of a confirm dialog, unless it cannot be undone.

## Copy

- One line per group, at most, in `--ink-faint`. Caveats go in a tooltip or the docs.
- Name things by what the user knows them as ("Acme · Team"), not an internal id.
- Never put a secret, key or token on screen.

## Building blocks

Use these instead of re-declaring markup (`components/primitives/`): `Group`, `Row`, `QuietTabs`, `Rule`, `StatusDot`, `Toggle`, `StatusIcon`, `WallMascot`, and the Gentleface icons. CSS utilities: `quiet-row`, `quiet-tab`, `quiet-field`, `quiet-rule`, `quiet-group-label`.

## Checklist for a screen

- [ ] No card, border or tile inside a view or popover, except the allowed objects.
- [ ] Spacing is 8 or 20 (4 only for coupled pairs); groups separated by `--q-group` and a label.
- [ ] At most one hairline, between sections of a different kind.
- [ ] Every size on the type ladder; no tracked caps; no third line on a row.
- [ ] One line of help at most; detail behind a tap or tooltip.
- [ ] Only controls that apply to the current context are shown.
- [ ] One primary button; plum only for intent; information in Petrol.
- [ ] Agent status uses `StatusIcon` or `WallMascot`; other status is a dot and a word with `-text` words.
- [ ] No hex, `rgb()`, Tailwind palette colour, `white`/`black` or token fallback in components.
- [ ] Control icons are Gentleface and play once on hover, focus or press.
- [ ] Every action has a motion from the table; removals offer Undo.
- [ ] Checked in Light Nekko and Dusk, at 360px and desktop width.

## Migrating older screens

Older screens still use `card` tiles, bordered rows and filled pills. Move a screen over when you touch it: the card becomes a `Group`, bordered rows become `Row`, a pill becomes a dot and a word. Reference screens already moved: the model picker, the Models page, Security settings, the model library and change review.
