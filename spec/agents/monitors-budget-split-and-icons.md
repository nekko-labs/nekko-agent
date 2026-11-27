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

## Budget: metered spend and estimated savings

- **API & cloud spend** counts metered API and cloud usage: a recorded provider cost when available, otherwise a token-price estimate. It does not read invoices or include subscription fees. Local-model and subscription tokens add no spend. New Claude Code records use the billing route known at turn time; unknown auth does not get a list-price charge. For older untagged records, the saved Claude Code route is the best available proxy (a CLI login defaults to plan usage; configured API and cloud routes remain metered). The ledger is not rewritten.
- **Estimated savings** compares local and subscription tokens to API prices. **Local model savings** shows the local estimate and token count separately. Local models without a paid catalog price use the configured fallback or are left unpriced if there is none. Hosted free models do not get a paid equivalent. These are not net savings after plan fees, hardware or electricity.
- **Top paid agent** uses the highest metered session total in the selected time range. Its name opens the matching chat by ID, read-only if archived. If the chat no longer exists, the row keeps the cost but has no link.
- All totals follow the selected UTC range; the split bar shows the metered share of the API-price comparison, not a percentage of an invoice. The panel reads local usage data without querying provider billing or exposing chat contents.
- Status (#3597): implementation and isolated desktop fixture verification; not verified against a provider invoice or deployed desktop build.

## Utilization provider logos `[implemented; unit-tested; renderer-verified in an isolated fixture]`

- Each provider row leads with its logo tile (`ProviderMark`, the same mark and colour the Models page uses), scaled to 20px. A custom endpoint without a logo keeps the generic mark.
