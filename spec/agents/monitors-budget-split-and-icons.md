---
title: "Monitors: actual vs. theoretical Budget, provider logos, monitor icons, no Insights (2026-11-09)"
area: agents
---

# Monitors: actual vs. theoretical Budget, provider logos, monitor icons, no Insights (2026-11-09)

User intent (Philip): the icons on the monitor headers should have the colour and hover of the minimized restore buttons; Utilization and Automations get new Gentleface icons; the Insights monitor goes; Budget splits into **actual spend** (only real spend from APIs or cloud usage, nothing based on subscriptions) and **theoretical spend** (what free/local models and subscriptions saved), with a cleaner card; Utilization shows each provider's logo.

## Monitor header icons `[implemented; unit-tested; renderer-verified in an isolated fixture]`

- A monitor's header icon uses the accent colour, the same as its restore button in the minimized row.
- Hovering (or focusing) the header lights the icon the way hovering a restore button does: a `surface-2` tile appears behind it and Gentleface glyphs switch to their solid weight (or play their motion). The header carries `data-icon-hover`; it is already the drag handle, so the hover is not a false affordance.
- **Utilization** uses Gentleface 0.6.0 `bar-chart-horizontal` (one bar per quota window). **Automations** uses Gentleface 0.6.0 `bolt` (the catalog's "automation" glyph). Both are embedded line-round/solid-round 16px paths in `gentleface-icons.tsx` (`GfBarChartHorizontalIcon`, `GfBoltIcon`). Budget, Hardware and Local models keep their icons.

## Insights monitor removed `[implemented; unit-tested]`

- The Insights monitor (vitals strip, optimize tips, cost, tokens over time, by model, replies, services) is gone: `MonitorKey` no longer has `insights`, Configure lists five monitors, and the `InsightsBox` component and the shared `optimizationTips` module are deleted, as is the vitals computation that only fed it.
- Saved docks that still name `insights` load without it (unknown keys are dropped, as the Vitals panel was on 2026-10-13). An old wall's `insights` window is dropped on load; an old `automations` window still turns on the Automations monitor. A saved wall's `insights` panel choices are ignored and no longer written back.
- The split compass no longer offers an Insights window.

## Budget: actual and theoretical spend `[implemented; unit-tested; renderer-verified in an isolated fixture]`

- **Actual spend** is the recorded API-price cost of turns on metered API keys and cloud usage (the usage summary's daily `cost`). Local-model turns and subscription turns record $0 here, so a subscription never shows up as actual spend.
- **Theoretical spend** is the sum of the two avoided-cost estimates: local models (`avoidedCosts.local`) and subscriptions (`avoidedCosts.subscription`), i.e. what those tokens would have cost at API prices. It is shown in the success colour as money saved.
- Layout, top to bottom: the time-range toggles; two headline tiles side by side (Actual spend, Theoretical spend), whose values line up even when a label wraps; a thin split bar of the API-price total (accent for paid, green for saved) with "`$X` at API prices · you paid `N`%"; a quiet breakdown list (Local models with its token count, Subscriptions, Top paid agent, Tokens in/out in compact notation with exact numbers on hover); one footnote on what theoretical means; the Cloud pricing comparison disclosure, unchanged.
- Every figure follows the selected UTC range, as before. Unpriced and fallback-token notes are unchanged.
- Limitation: cloud models priced at $0 in the pricing catalog (for example OpenRouter free models) count as $0 in both actual and theoretical spend; they are not yet valued at a paid equivalent.

## Utilization provider logos `[implemented; unit-tested; renderer-verified in an isolated fixture]`

- Each provider row leads with its logo tile (`ProviderMark`, the same mark and colour the Models page uses), scaled to 20px. A custom endpoint without a logo keeps the generic mark.
