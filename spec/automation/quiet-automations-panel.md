---
title: "Quiet Automations panel and one switch"
area: automation
---

# Quiet Automations panel and one switch

**User intent (Philip, 2026-11-14).** The Automations panel on the Agent board should follow the quiet design system ([docs/design-system.md](../../docs/design-system.md)) and show less: the large "Nothing scheduled" card had too much text, and the slider switches did not match from one screen to the next.

## The Automations panel `[implemented 2026-11-14; unit tests and hidden renderer capture in dark and light against synthetic data]`

- **Sections.** CI runners (when this computer can host one, see [CI runners](ci-runners.md)), then **Scheduled tasks** under a heading of the same size.
- **Nothing scheduled** is one faint line: "All clear. Nothing scheduled." (Philip, 2026-11-15; until then it also said to pick Automate in a chat's + menu.) No illustration, dashed card or paragraph. The window strip shows no count while the list is empty, and "N active of M" (plain faint text, not a chip) once it has tasks.
- **Rows** are quiet rows: no card around the list, no dividers, and a neutral wash on hover. Each row has a leading mark, the title, the state word flush right, and one faint detail line: cadence, run count, last run, how the last run started, and the last result, truncated with the whole line in its tooltip. The kind (once, recurring, background) is in that tooltip, not shown as an emoji tile.
- **State marks.** A running task gets our working rocket (`StatusIcon`); everything else is a dot and a word: waiting for you to be away (Petrol dot), next run "in 40 mins" (success dot, faint word), paused (neutral), error (danger dot, words in `--danger-text`), done (the check glyph).
- **Actions.** With a pointer, Run now, Pause or Resume, and Delete take the state word's place on hover or focus and fade in, so the word sits flush right at rest and the row keeps its height. On touch both show and the actions wrap.
- **Paused.** "All automations are paused" is one line: a warning dot, the words in `--warning-text`, and Resume. What it means (schedules, events and polls start nothing; Run now still works) is in the tooltip. The Automations page uses the same line instead of its bordered warning box.

## One switch `[implemented 2026-11-14; unit tests and hidden renderer capture]`

Every on/off slider draws the same: `.quiet-switch` in `styles.css`, a 36x20 track with a 16px knob, a faint track when off and the accent when on, the knob sliding and the fill fading over `--dur-med`, the `--ring` halo on keyboard focus, and no knob motion under reduced motion. `primitives/Toggle` renders it, and Settings' `Toggle` (its `on` and aria call shape) now wraps the primitive, so Settings, the Automations page, the CI runner header and every other screen match. The chat's mode switches, the onboarding switches, the connector switches in the chat's controls menu and the privacy shield's switches wear the same class.

The Monitors dock, where the Automations panel lives, styles its own buttons with a border, a 6px corner and padding. Until 2026-11-15 that rule also reached the CI runner's switch, which drew as a bordered, square-cornered box with its knob off the track. The dock's button rule now skips `.quiet-switch` `[fixed 2026-11-15; hidden capture inside the dock, with a computed-style check]`.

## Settings icon `[implemented 2026-11-15; hidden renderer capture of the runner header]`

Every settings cog is Gentleface's `settings` (MIT, 0.6.0): line at rest and solid on hover for controls (the runner's settings button, the System group in Settings), and the solid glyph with an accent hub in the nav rail. The hand-drawn gear (`GearIcon`) and the old rail cog are gone.

Not verified: the packaged app and native window chrome. The hover swap was checked with a synthetic pointer in the hidden fixture; keyboard focus in a focused window was not.
